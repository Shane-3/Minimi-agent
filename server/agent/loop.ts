// The agent loop: the only file that calls Anthropic. One model, written by
// hand, no framework. In this version the model has no tools, so a turn is a
// single streamed call; web_search is added to this loop in build step 7.
import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL_EFFORT,
  MODEL_MAX_TOKENS,
  MODEL_RETRIES,
  MODEL_RETRY_DELAY_MS,
  MODEL_TIMEOUT_MS,
} from "../config.ts";
import type { Prompt } from "./prompt.ts";

export type AgentErrorCode =
  /** Overloaded, rate limited, server error or network failure, after the retry. */
  | "unavailable"
  | "timeout"
  /** The user pressed Stop or closed the page. */
  | "aborted"
  /** The model and its fallback declined to answer. */
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
  stopReason: string | null;
  /** The model that wrote the answer: differs from the configured one after a refusal fallback. */
  model: string;
}

export interface Agent {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

/**
 * Server-side refusal fallback: if the model declines, the API re-runs the
 * same request on a fallback model it picks by refusal category, inside the
 * same call, so the user gets an answer instead of a bare refusal.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const UNAVAILABLE_MESSAGE = "The answer didn't come through. Your message is saved.";

export function createAgent(options: { apiKey: string; model: string; client?: Anthropic }): Agent {
  // Retries are done below, not by the SDK, so there is exactly one and only
  // before any text has reached the user (a retry after that would repeat it).
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });

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
      const stream = client.beta.messages.stream(
        {
          model: options.model,
          max_tokens: MODEL_MAX_TOKENS,
          system: request.system,
          messages: request.messages,
          output_config: { effort: MODEL_EFFORT },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          emitted.text += event.delta.text;
          request.onText(event.delta.text);
        }
      }

      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        throw new AgentError("refusal", "This question can't be answered here.", {
          retryable: false,
          partialText: emitted.text,
        });
      }
      return { text: emitted.text, stopReason: final.stop_reason, model: final.model };
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

// Most specific first, so retryable failures stay apart from ones a retry cannot fix.
function toAgentError(error: unknown, partialText: string): AgentError {
  const options = (retryable: boolean) => ({ retryable, partialText, cause: error });
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AgentError("auth", "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.", options(false));
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new AgentError("bad_request", UNAVAILABLE_MESSAGE, options(false));
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AgentError("timeout", UNAVAILABLE_MESSAGE, options(true));
  }
  // Rate limits, overload (529), other server errors and network failures,
  // and anything unexpected: worth one retry, then the user's Retry button.
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
