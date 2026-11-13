// The agent loop: the only file that calls the model. One agent, written by
// hand, no framework; the model answering comes from a pool (pool.ts). The
// API is Cerebras's, reached through the OpenAI SDK because it speaks the
// same protocol. In this version the model has no tools, so a turn is a
// single streamed call; web_search is added to this loop in build step 7.
import OpenAI from "openai";
import {
  MODEL_BASE_URL,
  MODEL_MAX_TOKENS,
  MODEL_REST_AFTER_DAILY_LIMIT_MS,
  MODEL_REST_AFTER_FAILURE_MS,
  MODEL_REST_AFTER_MINUTE_LIMIT_MS,
  MODEL_RETRIES,
  MODEL_RETRY_DELAY_MS,
  MODEL_TIMEOUT_MS,
  RECALL_REASONING,
  RECALL_REASONING_DEFAULT,
  type ReasoningEffort,
} from "../config.ts";
import { ModelPool, type Rest } from "./pool.ts";
import type { Prompt } from "./prompt.ts";

export type AgentErrorCode =
  /** Overloaded, server error or network failure, after the retry. */
  | "unavailable"
  | "timeout"
  /** Every model hit its per-minute limit. */
  | "rate_limited"
  /** Every model used up its daily limit. */
  | "quota_exhausted"
  /** The user pressed Stop or closed the page. */
  | "aborted"
  /** The provider's content filter stopped the answer. */
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
  /** The model that wrote the answer, as the API reports it. */
  model: string;
}

export interface Agent {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

/** The one part of the SDK the loop uses, so tests can stand in for it. */
export type ModelClient = Pick<OpenAI, "chat">;

export interface AgentOptions {
  apiKey: string;
  models: string[];
  /** Overrides the per-model reasoning setting for every model; the speed comparison uses it. */
  reasoning?: ReasoningEffort;
  client?: ModelClient;
}

const UNAVAILABLE_MESSAGE = "The answer didn't come through. Your message is saved.";
const RATE_LIMITED_MESSAGE = "Too many questions in the last minute. Wait a moment and press Retry.";
const QUOTA_MESSAGE = "The daily request limit is used up. Questions will work again tomorrow.";

/**
 * A rate limit whose wait is longer than this is taken to be a daily limit.
 * The API's 429 says which token count ran out but not which window, so the
 * length of the wait it asks for is what tells them apart.
 */
const DAILY_LIMIT_THRESHOLD_MS = 10 * 60_000;

export function createAgent(options: AgentOptions): Agent {
  // The SDK's own retries are turned off. Retries and model changes below
  // happen only before any text has reached the user, since after that they
  // would repeat what the user already saw.
  const client =
    options.client ??
    new OpenAI({ apiKey: options.apiKey, baseURL: MODEL_BASE_URL, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
  // Shared by every answer, so a model that hit its limit is skipped by the
  // next question too, not tried again first.
  const pool = new ModelPool(options.models);
  const reasoningFor = (model: string): ReasoningEffort =>
    options.reasoning ?? RECALL_REASONING[model] ?? RECALL_REASONING_DEFAULT;

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
      const stream = await client.chat.completions.create(
        {
          model,
          // Rules and memory first and unchanged between questions, so the
          // provider can reuse them from its cache.
          messages: [{ role: "system", content: request.system }, ...request.messages],
          stream: true,
          max_completion_tokens: MODEL_MAX_TOKENS,
          reasoning_effort: reasoningFor(model),
        },
        { signal: controller.signal },
      );

      let finishReason: string | null = null;
      let version = model;
      for await (const chunk of stream) {
        version = chunk.model || version;
        const choice = chunk.choices[0];
        finishReason = choice?.finish_reason ?? finishReason;
        // Reasoning, when on, arrives in a separate field and is not shown.
        const text = choice?.delta?.content;
        if (text === undefined || text === null || text === "") continue;
        emitted.text += text;
        request.onText(text);
      }

      if (finishReason === "content_filter") {
        throw new AgentError("refusal", "This question can't be answered here.", {
          retryable: false,
          partialText: emitted.text,
        });
      }
      return { text: emitted.text, stopReason: finishReason === "length" ? "max_tokens" : "end_turn", model: version };
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
  if (soonest?.reason === "day") return new AgentError("quota_exhausted", QUOTA_MESSAGE, { retryable: false });
  if (soonest?.reason === "minute") return new AgentError("rate_limited", RATE_LIMITED_MESSAGE, { retryable: true });
  return new AgentError("unavailable", UNAVAILABLE_MESSAGE, { retryable: true });
}

// Sorts failures into ones a retry may fix and ones it cannot. The SDK's
// typed errors are checked most specific first.
function toAgentError(error: unknown, partialText: string): AgentError {
  const options = (retryable: boolean) => ({ retryable, partialText, cause: error });
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) {
    return new AgentError("auth", "The Cerebras API key was rejected. Check CEREBRAS_API_KEY in .env.", options(false));
  }
  if (error instanceof OpenAI.RateLimitError) {
    const retryAfterMs = retryAfter(error.headers);
    if (retryAfterMs !== undefined && retryAfterMs > DAILY_LIMIT_THRESHOLD_MS) {
      return new AgentError("quota_exhausted", QUOTA_MESSAGE, { ...options(false), retryAfterMs });
    }
    return new AgentError("rate_limited", RATE_LIMITED_MESSAGE, { ...options(true), retryAfterMs });
  }
  if (error instanceof OpenAI.BadRequestError || error instanceof OpenAI.NotFoundError) {
    return new AgentError("bad_request", UNAVAILABLE_MESSAGE, options(false));
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new AgentError("timeout", UNAVAILABLE_MESSAGE, options(true));
  }
  // Server errors (5xx), network failures and anything unexpected: worth one
  // retry, then the user's Retry button.
  return new AgentError("unavailable", UNAVAILABLE_MESSAGE, options(true));
}

/** The wait the API asks for, from the standard retry-after-ms or retry-after (seconds) header. */
function retryAfter(headers: Headers | undefined): number | undefined {
  const milliseconds = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  const seconds = Number(headers?.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  return undefined;
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
