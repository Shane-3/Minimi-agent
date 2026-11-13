// The agent loop: the only file that calls the model. One agent, written by
// hand, no framework. Each answer is a few model calls at most: the model
// either answers or asks for web_search, the searches run, and the results go
// back for the next call. The model answering comes from a pool (pool.ts);
// the API is Cerebras's, reached through the OpenAI SDK because it speaks the
// same protocol.
import OpenAI from "openai";
import type { Evidence } from "../../shared/types.ts";
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
  SEARCH_REASONING,
  STEP_CAP,
  TOOL_PREAMBLE_HOLD_CHARS,
  type ReasoningEffort,
} from "../config.ts";
import { ModelPool, type Rest } from "./pool.ts";
import type { Prompt } from "./prompt.ts";
import { WEB_SEARCH_TOOL, webSearchInput, type WebSearch, type WebSearchInput, type WebSearchResult } from "./search.ts";

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
  /** Called with a plain progress line, e.g. "Checking HubSpot and Pipedrive". */
  onStatus?: (text: string) => void;
  /** Aborts the call when the user stops or disconnects. */
  signal?: AbortSignal;
}

export interface AnswerResult {
  text: string;
  /** "max_tokens" means the answer was cut off. */
  stopReason: "end_turn" | "max_tokens";
  /** The model that wrote the answer, as the API reports it. */
  model: string;
  /** Every page the searches returned, once each. */
  evidence: Evidence[];
  /** How many web_search calls ran. */
  searches: number;
}

export interface Agent {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

/** The one part of the SDK the loop uses, so tests can stand in for it. */
export type ModelClient = Pick<OpenAI, "chat">;

export interface AgentOptions {
  apiKey: string;
  models: string[];
  /** The web_search tool; without it the model is offered no tools. */
  webSearch?: WebSearch;
  /** Overrides the per-model reasoning setting for every call; the speed comparison and evals use it. */
  reasoning?: ReasoningEffort;
  /** Model calls per answer; tests lower it. */
  stepCap?: number;
  client?: ModelClient;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One model call's output. */
interface CallResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  model: string;
}

const UNAVAILABLE_MESSAGE = "The answer didn't come through. Your message is saved.";
const RATE_LIMITED_MESSAGE = "Too many questions in the last minute. Wait a moment and press Retry.";
const QUOTA_MESSAGE = "The daily request limit is used up. Questions will work again tomorrow.";

/** Added before the last call when the model still wanted to search (REQUIREMENTS §5, step cap). */
const LAST_STEP_NOTE =
  "No more searches are possible for this answer. Answer now with what you have, and say what is still unchecked.";

/**
 * A rate limit whose wait is longer than this is taken to be a daily limit.
 * The API's 429 says which token count ran out but not which window, so the
 * length of the wait it asks for is what tells them apart.
 */
const DAILY_LIMIT_THRESHOLD_MS = 10 * 60_000;

export function createAgent(options: AgentOptions): Agent {
  // The SDK's own retries are turned off. Retries and model changes below
  // happen only before a call has sent any text, since after that they would
  // repeat what the user already saw.
  const client =
    options.client ??
    new OpenAI({ apiKey: options.apiKey, baseURL: MODEL_BASE_URL, maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
  // Shared by every answer, so a model that hit its limit is skipped by the
  // next question too, not tried again first.
  const pool = new ModelPool(options.models);
  const stepCap = options.stepCap ?? STEP_CAP;

  /** Recall reasoning per model; once search results are in, more (SEARCH_REASONING). */
  function reasoningFor(model: string, afterSearch: boolean): ReasoningEffort {
    if (options.reasoning !== undefined) return options.reasoning;
    if (afterSearch) return SEARCH_REASONING;
    return RECALL_REASONING[model] ?? RECALL_REASONING_DEFAULT;
  }

  // ---------------------------------------------------------------------
  // One streamed call to one model

  async function attempt(
    model: string,
    messages: ChatMessage[],
    withTools: boolean,
    afterSearch: boolean,
    request: AnswerRequest,
    emitted: { text: string },
  ): Promise<CallResult> {
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
          messages,
          stream: true,
          max_completion_tokens: MODEL_MAX_TOKENS,
          reasoning_effort: reasoningFor(model, afterSearch),
          ...(withTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
        },
        { signal: controller.signal },
      );

      let finishReason: string | null = null;
      let version = model;
      // Tool calls arrive in pieces, keyed by their position.
      const calls: ToolCall[] = [];
      // While the model may still search, the start of its text waits here
      // (see TOOL_PREAMBLE_HOLD_CHARS): a search request after it means it was
      // a preamble and is dropped; otherwise it goes out as normal.
      let held: string | null = withTools ? "" : null;
      const send = (text: string) => {
        emitted.text += text;
        request.onText(text);
      };
      for await (const chunk of stream) {
        version = chunk.model || version;
        const choice = chunk.choices[0];
        finishReason = choice?.finish_reason ?? finishReason;
        for (const piece of choice?.delta?.tool_calls ?? []) {
          // A search is coming, so anything held back was a preamble.
          held = held === null ? null : "";
          const call = (calls[piece.index] ??= { id: "", name: "", arguments: "" });
          if (piece.id) call.id = piece.id;
          if (piece.function?.name) call.name += piece.function.name;
          if (piece.function?.arguments) call.arguments += piece.function.arguments;
        }
        // Reasoning, when on, arrives in a separate field and is not shown.
        const text = choice?.delta?.content;
        if (text === undefined || text === null || text === "") continue;
        if (held === null || calls.length > 0) {
          if (held === null) send(text);
          continue;
        }
        held += text;
        if (held.length >= TOOL_PREAMBLE_HOLD_CHARS) {
          send(held);
          held = null;
        }
      }
      // The call ended without asking to search: the held text is the answer's start.
      if (held !== null && held !== "" && calls.length === 0) send(held);

      if (finishReason === "content_filter") {
        throw new AgentError("refusal", "This question can't be answered here.", {
          retryable: false,
          partialText: emitted.text,
        });
      }
      return { text: emitted.text, toolCalls: calls.filter((call) => call !== undefined), finishReason, model: version };
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

  // ---------------------------------------------------------------------
  // One call, with the pool: limits and overloads move to the next model

  async function callModel(
    messages: ChatMessage[],
    withTools: boolean,
    afterSearch: boolean,
    request: AnswerRequest,
  ): Promise<CallResult> {
    let failureRetries = 0;
    for (;;) {
      const model = pool.pick();
      if (model === null) throw everyModelResting(pool.soonest());
      // Text from this call only: a retry is safe as long as this call has
      // sent nothing, even if an earlier call in the answer did.
      const emitted = { text: "" };
      try {
        return await attempt(model, messages, withTools, afterSearch, request, emitted);
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
  }

  // ---------------------------------------------------------------------
  // The tool

  async function runTool(call: ToolCall, request: AnswerRequest): Promise<{ result: WebSearchResult | { error: string }; ran: boolean }> {
    const webSearch = options.webSearch;
    if (webSearch === undefined || call.name !== "web_search") {
      return { result: { error: `There is no tool called "${call.name}". The only tool is web_search.` }, ran: false };
    }
    let args: unknown;
    try {
      args = JSON.parse(call.arguments === "" ? "{}" : call.arguments);
    } catch {
      return { result: { error: "The arguments were not valid JSON. Call web_search again with valid arguments." }, ran: false };
    }
    // Tool input crosses a boundary like any other, so it is checked.
    const parsed = webSearchInput.safeParse(args);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
      return { result: { error: `Invalid web_search input. ${problems.join("; ")}` }, ran: false };
    }
    request.onStatus?.(searchStatus(parsed.data));
    return { result: await webSearch.search(parsed.data, request.signal), ran: true };
  }

  // ---------------------------------------------------------------------
  // The answer: call, search, call again, up to the step cap

  return {
    async answer(request) {
      const messages: ChatMessage[] = [{ role: "system", content: request.system }, ...request.messages];
      const evidence = new Map<string, Evidence>();
      let text = "";
      let searches = 0;
      // Text from different calls is kept apart by a blank line, both on
      // screen and in the saved answer.
      let needsBreak = false;
      const onText = (raw: string) => {
        // Blank lines a model sends before any real text (often just before
        // a tool call) would show as an empty gap at the top of the answer.
        const piece = text === "" ? raw.trimStart() : raw;
        if (piece === "") return;
        if (text !== "" && needsBreak) {
          text += "\n\n";
          request.onText("\n\n");
        }
        needsBreak = false;
        text += piece;
        request.onText(piece);
      };
      const callRequest: AnswerRequest = { ...request, onText };

      for (let step = 1; ; step += 1) {
        const lastStep = step >= stepCap;
        const withTools = options.webSearch !== undefined && !lastStep;
        if (lastStep && step > 1) messages.push({ role: "user", content: LAST_STEP_NOTE });

        let call: CallResult;
        try {
          call = await callModel(messages, withTools, searches > 0, callRequest);
        } catch (error) {
          // The partial text of an answer is everything sent so far, not just this call's.
          if (error instanceof AgentError) {
            throw new AgentError(error.code, error.message, {
              retryable: error.retryable,
              partialText: text,
              cause: error.cause,
              retryAfterMs: error.retryAfterMs,
            });
          }
          throw error;
        }

        if (call.toolCalls.length === 0 || !withTools) {
          return {
            text,
            stopReason: call.finishReason === "length" ? "max_tokens" : "end_turn",
            model: call.model,
            evidence: [...evidence.values()],
            searches,
          };
        }

        messages.push({
          role: "assistant",
          content: call.text === "" ? null : call.text,
          tool_calls: call.toolCalls.map((tool) => ({
            id: tool.id,
            type: "function" as const,
            function: { name: tool.name, arguments: tool.arguments },
          })),
        });
        // Every search the model asked for in this step runs at once.
        const outcomes = await Promise.all(call.toolCalls.map((tool) => runTool(tool, request)));
        outcomes.forEach(({ result, ran }, index) => {
          if (ran) searches += 1;
          if ("entities" in result) {
            for (const entity of result.entities) {
              for (const page of entity.evidence) if (!evidence.has(page.url)) evidence.set(page.url, page);
            }
          }
          messages.push({ role: "tool", tool_call_id: call.toolCalls[index]!.id, content: JSON.stringify(result) });
        });
        needsBreak = true;
      }
    },
  };
}

/** "Checking hubspot.com and pipedrive.com", or "Checking HubSpot, Pipedrive and 3 more". */
export function searchStatus(input: WebSearchInput): string {
  const names = input.entities.map((entity) => entity.officialSite ?? entity.name);
  if (names.length <= 2) return `Checking ${names.join(" and ")}`;
  return `Checking ${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
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
