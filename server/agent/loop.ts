// The agent loop: the only file that calls Gemini. One model, written by
// hand, no framework. In this version the model has no tools, so a turn is a
// single streamed call; web_search is added to this loop in build step 7.
import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  MODEL_MAX_TOKENS,
  MODEL_RETRIES,
  MODEL_RETRY_DELAY_MS,
  MODEL_THINKING_LEVEL,
  MODEL_TIMEOUT_MS,
} from "../config.ts";
import type { Prompt } from "./prompt.ts";

export type AgentErrorCode =
  /** Overloaded, rate limited, quota used up, server error or network failure, after the retry. */
  | "unavailable"
  | "timeout"
  /** The user pressed Stop or closed the page. */
  | "aborted"
  /** The model's safety filters declined to answer. */
  | "refusal"
  /** The key is missing or rejected. */
  | "auth"
  /** Our request was malformed: a bug, not something a retry fixes. */
  | "bad_request";

/** A failed turn. `message` is written for the user; `partialText` is whatever streamed before it failed. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;
  readonly partialText: string;

  constructor(code: AgentErrorCode, message: string, options: { retryable: boolean; partialText?: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable;
    this.partialText = options.partialText ?? "";
  }
}

export interface AnswerRequest extends Prompt {
  /** Called with each piece of answer text as it arrives. */
  onText: (text: string) => void;
  /** Aborts the call when the user stops or disconnects. */
  signal?: AbortSignal;
}

export interface AnswerResult {
  text: string;
  /** "max_tokens" means the answer was cut off. */
  stopReason: "end_turn" | "max_tokens";
  /** The model version that wrote the answer, as the API reports it. */
  model: string;
}

export interface Agent {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

/** The one part of the SDK the loop uses, so tests can stand in for it. */
export type ModelClient = Pick<GoogleGenAI, "models">;

// Finish reasons where the model's filters stopped the answer.
const DECLINED = new Set<FinishReason | undefined>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

const UNAVAILABLE_MESSAGE = "The answer didn't come through. Your message is saved.";

export function createAgent(options: { apiKey: string; model: string; client?: ModelClient }): Agent {
  // The SDK's own retries are turned off (it would try 5 times). The single
  // retry below happens only before any text has reached the user, since a
  // retry after that would repeat what they already saw.
  const client =
    options.client ??
    new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });

  async function attempt(request: AnswerRequest, emitted: { text: string }): Promise<AnswerResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MODEL_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort);
    // A Stop pressed during the wait before a retry has already fired its
    // event, so check the flag too, or the retry would run anyway.
    if (request.signal?.aborted === true) controller.abort();

    try {
      const stream = await client.models.generateContentStream({
        model: options.model,
        contents: request.contents,
        config: {
          // Rules and memory first and unchanged between questions, so the
          // API's automatic prefix caching can reuse them.
          systemInstruction: request.system,
          maxOutputTokens: MODEL_MAX_TOKENS,
          thinkingConfig: { thinkingLevel: ThinkingLevel[MODEL_THINKING_LEVEL] },
          abortSignal: controller.signal,
        },
      });

      let finishReason: FinishReason | undefined;
      let blocked = false;
      let model = options.model;
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason !== undefined) blocked = true;
        model = chunk.modelVersion ?? model;
        const candidate = chunk.candidates?.[0];
        finishReason = candidate?.finishReason ?? finishReason;
        for (const part of candidate?.content?.parts ?? []) {
          // Thought parts are the model's reasoning, not the answer.
          if (part.thought === true || part.text === undefined || part.text === "") continue;
          emitted.text += part.text;
          request.onText(part.text);
        }
      }

      if (blocked || DECLINED.has(finishReason)) {
        throw new AgentError("refusal", "This question can't be answered here.", {
          retryable: false,
          partialText: emitted.text,
        });
      }
      const stopReason = finishReason === FinishReason.MAX_TOKENS ? "max_tokens" : "end_turn";
      return { text: emitted.text, stopReason, model };
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (request.signal?.aborted === true) {
        throw new AgentError("aborted", "Stopped.", { retryable: true, partialText: emitted.text, cause: error });
      }
      if (timedOut) {
        throw new AgentError("timeout", UNAVAILABLE_MESSAGE, { retryable: true, partialText: emitted.text, cause: error });
      }
      throw toAgentError(error, emitted.text);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async answer(request) {
      const emitted = { text: "" };
      for (let tries = 0; ; tries += 1) {
        try {
          return await attempt(request, emitted);
        } catch (error) {
          const canRetry =
            error instanceof AgentError &&
            error.retryable &&
            error.code !== "aborted" &&
            emitted.text === "" &&
            tries < MODEL_RETRIES;
          if (!canRetry) throw error;
          await delay(MODEL_RETRY_DELAY_MS, request.signal);
        }
      }
    },
  };
}

// Sorts failures into ones a retry may fix and ones it cannot.
function toAgentError(error: unknown, partialText: string): AgentError {
  const options = (retryable: boolean) => ({ retryable, partialText, cause: error });
  if (error instanceof ApiError) {
    // The Gemini API answers a bad key with 400 and the reason code
    // API_KEY_INVALID, so the status alone cannot tell it from a malformed
    // request. The code is a fixed identifier, not wording that may change.
    const badKey = error.status === 400 && error.message.includes("API_KEY_INVALID");
    if (badKey || error.status === 401 || error.status === 403) {
      return new AgentError("auth", "The Gemini API key was rejected. Check GEMINI_API_KEY in .env.", options(false));
    }
    if (error.status === 400 || error.status === 404) {
      return new AgentError("bad_request", UNAVAILABLE_MESSAGE, options(false));
    }
  }
  // Rate limits and used-up quota (429), server errors (5xx), network
  // failures, and anything unexpected: worth one retry, then the user's Retry button.
  return new AgentError("unavailable", UNAVAILABLE_MESSAGE, options(true));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
