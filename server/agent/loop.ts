// The agent loop: the only file that calls Gemini. One agent, written by
// hand, no framework; the model answering it comes from a pool (pool.ts). In this version the model has no tools, so a turn is a
// single streamed call; web_search is added to this loop in build step 7.
import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  MODEL_MAX_TOKENS,
  MODEL_REST_AFTER_DAILY_LIMIT_MS,
  MODEL_REST_AFTER_FAILURE_MS,
  MODEL_REST_AFTER_MINUTE_LIMIT_MS,
  MODEL_RETRIES,
  MODEL_RETRY_DELAY_MS,
  MODEL_THINKING_LEVEL,
  MODEL_TIMEOUT_MS,
} from "../config.ts";
import { ModelPool, type Rest } from "./pool.ts";
import type { Prompt } from "./prompt.ts";

export type AgentErrorCode =
  /** Overloaded, server error or network failure, after the retry. */
  | "unavailable"
  | "timeout"
  /** Every model hit its per-minute request limit. */
  | "rate_limited"
  /** Every model used up its daily request limit (the free tier allows a few dozen a day per model). */
  | "quota_exhausted"
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
  /** For a rate limit: how long the API asked us to wait, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { retryable: boolean; partialText?: string; cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, { cause: options.cause });
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable;
    this.partialText = options.partialText ?? "";
    this.retryAfterMs = options.retryAfterMs;
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

export interface AgentOptions {
  apiKey: string;
  models: string[];
  /** Overrides the configured thinking level; the speed comparison uses it. */
  thinkingLevel?: ThinkingLevelName;
  client?: ModelClient;
}

/** MINIMAL turns thinking off on models that allow it (Gemma); Gemini 4 models reject it. */
export type ThinkingLevelName = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export function createAgent(options: AgentOptions): Agent {
  const thinkingLevel = ThinkingLevel[options.thinkingLevel ?? MODEL_THINKING_LEVEL];
  // The SDK's own retries are turned off (it would try 5 times). Retries and
  // model changes below happen only before any text has reached the user,
  // since after that they would repeat what the user already saw.
  const client =
    options.client ??
    new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });
  // Shared by every answer, so a model that hit its limit is skipped by the
  // next question too, not tried again first.
  const pool = new ModelPool(options.models);

  async function attempt(model: string, request: AnswerRequest, emitted: { text: string }): Promise<AnswerResult> {
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
        model,
        contents: request.contents,
        config: {
          // Rules and memory first and unchanged between questions, so the
          // API's automatic prefix caching can reuse them.
          systemInstruction: request.system,
          maxOutputTokens: MODEL_MAX_TOKENS,
          thinkingConfig: { thinkingLevel },
          abortSignal: controller.signal,
        },
      });

      let finishReason: FinishReason | undefined;
      let blocked = false;
      let version = model;
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason !== undefined) blocked = true;
        version = chunk.modelVersion ?? version;
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
      return { text: emitted.text, stopReason, model: version };
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
      let failureRetries = 0;
      for (;;) {
        const model = pool.pick();
        if (model === null) throw everyModelResting(pool.soonest());
        try {
          return await attempt(model, request, emitted);
        } catch (error) {
          if (!(error instanceof AgentError) || emitted.text !== "") throw error;

          // Limits fail fast and are counted per model, so the next model is
          // tried at once, as many times as there are models.
          if (error.code === "rate_limited") {
            pool.rest(model, "minute", error.retryAfterMs ?? MODEL_REST_AFTER_MINUTE_LIMIT_MS);
            continue;
          }
          if (error.code === "quota_exhausted") {
            pool.rest(model, "day", error.retryAfterMs ?? MODEL_REST_AFTER_DAILY_LIMIT_MS);
            continue;
          }

          // An overload or server error fails within a second, so like a
          // limit it moves straight on while another model is free.
          if (error.code === "unavailable" && pool.pick(model) !== null) {
            pool.rest(model, "failure", MODEL_REST_AFTER_FAILURE_MS);
            continue;
          }

          // A timeout costs a whole minute, and an overload with no other
          // model free has nowhere to go: those get one more try in all
          // (REQUIREMENTS §5), on another model if there is one, otherwise on
          // the same model after a short wait.
          if ((error.code === "unavailable" || error.code === "timeout") && failureRetries < MODEL_RETRIES) {
            failureRetries += 1;
            if (pool.pick(model) !== null) {
              pool.rest(model, "failure", MODEL_REST_AFTER_FAILURE_MS);
            } else {
              await delay(MODEL_RETRY_DELAY_MS, request.signal);
            }
            continue;
          }
          throw error;
        }
      }
    },
  };
}

/** When every model is resting, the one free soonest says what to tell the user. */
function everyModelResting(soonest: Rest | null): AgentError {
  if (soonest?.reason === "day") {
    return new AgentError("quota_exhausted", "The daily request limit is used up. Questions will work again tomorrow.", {
      retryable: false,
    });
  }
  if (soonest?.reason === "minute") {
    return new AgentError("rate_limited", "Too many questions in the last minute. Wait a moment and press Retry.", {
      retryable: true,
    });
  }
  return new AgentError("unavailable", UNAVAILABLE_MESSAGE, { retryable: true });
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
    if (error.status === 429) {
      // The quota id names the window that ran out, e.g.
      // GenerateRequestsPerDayPerProjectPerModel-FreeTier. A fixed identifier,
      // like API_KEY_INVALID above.
      const retryAfterMs = retryDelayMs(error.message);
      if (error.message.includes("PerDay")) {
        return new AgentError("quota_exhausted", "The daily request limit is used up. Questions will work again tomorrow.", {
          ...options(false),
          retryAfterMs,
        });
      }
      return new AgentError("rate_limited", "Too many questions in the last minute. Wait a moment and press Retry.", {
        ...options(true),
        retryAfterMs,
      });
    }
  }
  // Server errors (5xx), network failures and anything unexpected: worth one
  // retry, then the user's Retry button.
  return new AgentError("unavailable", UNAVAILABLE_MESSAGE, options(true));
}

/**
 * The wait the API asks for, from the RetryInfo in its error body
 * ("retryDelay": "35s"). The body arrives as escaped JSON inside the message,
 * hence the loose match between the name and the number.
 */
function retryDelayMs(message: string): number | undefined {
  const match = /retryDelay\W{0,12}(\d+(?:\.\d+)?)s/.exec(message);
  return match === null ? undefined : Math.ceil(Number(match[1]) * 1000);
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
