// Every tunable limit lives here (ARCHITECTURE.md §9). Starting values,
// adjusted while running the evals.
import { fileURLToPath } from "node:url";

/** Model turns per answer. */
export const STEP_CAP = 4;

/** Search queries run at once in one model step. */
export const MAX_PARALLEL_SEARCHES = 10;

export const SEARCH_TIMEOUT_MS = 8_000;

/** Tavily's search endpoint. */
export const SEARCH_URL = "https://api.tavily.com/search";

/**
 * Entities one web_search call may check. Each gets at least a page search
 * and a news search, so five fill the ten parallel searches.
 */
export const MAX_SEARCH_ENTITIES = 5;

/** Results asked of Tavily per search. */
export const SEARCH_RESULTS_PER_QUERY = 5;

/** Sources kept per entity after merging and ranking. */
export const MAX_EVIDENCE_PER_ENTITY = 5;

/** Page text kept per source: enough to hold a price line, short enough to keep the prompt small. */
export const SNIPPET_MAX_CHARS = 500;
export const MODEL_TIMEOUT_MS = 60_000;
export const MODEL_RETRIES = 1;
/** Wait before the one retry after an overload or server error. */
export const MODEL_RETRY_DELAY_MS = 1_500;

/** Cerebras's OpenAI-compatible endpoint. */
export const MODEL_BASE_URL = "https://api.cerebras.ai/v1";

/**
 * Models to answer with, best first: the only place model ids are written.
 * CEREBRAS_MODELS in .env replaces the list. Limits are counted per model, so
 * when one hits its limit, or is overloaded, the answer moves to the next.
 * Qwen passed every recall eval with reasoning off and starts answering in
 * well under a second; gpt-oss is the backup.
 */
export const DEFAULT_MODELS = ["qwen-3.8-27b", "gpt-oss-120b"];

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * Reasoning for recall answers, per model. With reasoning off, Qwen sometimes
 * worked out a weekday wrongly ("Monday 14 Nov", a Saturday) or left a
 * decision out of a summary. At medium it passed every recall eval in two
 * runs, and answers still start within about a second on Cerebras, so
 * accuracy wins. A model not listed gets RECALL_REASONING_DEFAULT.
 */
export const RECALL_REASONING: { [model: string]: ReasoningEffort } = {
  "qwen-3.8-27b": "medium",
  "gpt-oss-120b": "medium",
};
export const RECALL_REASONING_DEFAULT: ReasoningEffort = "medium";

/**
 * Reasoning once search results are in: weighing old against new values,
 * conflicting sources and dates is where an error is most costly, and
 * accuracy comes before speed.
 */
export const SEARCH_REASONING: ReasoningEffort = "high";

/**
 * When the model may still call web_search, the start of its text is held
 * back until this many characters arrive or the call ends. If a search
 * request follows, the held text was a preamble ("Let me check...") and is
 * dropped, so the answer is not written twice. At Cerebras speeds this
 * delays a direct answer by a fraction of a second.
 */
export const TOOL_PREAMBLE_HOLD_CHARS = 500;

/** How long a model rests after a per-minute limit, when the API gives no delay. */
export const MODEL_REST_AFTER_MINUTE_LIMIT_MS = 60_000;
/** How long a model rests after its daily limit, when the API gives no delay; checked again after that. */
export const MODEL_REST_AFTER_DAILY_LIMIT_MS = 60 * 60_000;
/** How long a model rests after an overload, server error or timeout. */
export const MODEL_REST_AFTER_FAILURE_MS = 60_000;

/**
 * Caps reasoning and answer together. Recall answers are a few hundred
 * tokens; this leaves ample room without letting a runaway answer use up the
 * per-minute token limit.
 */
export const MODEL_MAX_TOKENS = 8_192;

/**
 * Tokens of record text the prompt may hold. Kept well under the free tier's
 * 30,000 uncached tokens a minute, so one question never exceeds the
 * per-minute limit on its own and a second still fits.
 */
export const RECORD_CONTEXT_BUDGET_TOKENS = 20_000;

/**
 * Earlier turns of a chat sent with each question, at most. Older turns are
 * left out so a long chat stays fast and inside the model's context; the chat
 * is a stored record, so its older turns can still be found by search.
 */
export const HISTORY_BUDGET_TOKENS = 8_000;

/** How many of a chat's last questions and answers a follow-up carries into the record search. */
export const FOLLOW_UP_TURNS = 3;

/** Rough token estimate. Good enough for a budget; no tokenizer dependency. */
export const CHARS_PER_TOKEN = 4;

/** Allowance per segment for the speaker label and line break in the prompt. */
export const SEGMENT_OVERHEAD_TOKENS = 3;

/** When a record is too long to load whole: segments kept either side of each match. */
export const PARTIAL_NEIGHBOUR_SEGMENTS = 2;

/** Search hits read when ranking records by topic. */
export const TOPIC_SEARCH_LIMIT = 200;

// Shared with the browser, which checks them before sending.
export { IMPORT_MAX_BYTES, MESSAGE_MAX_CHARS } from "../shared/limits.ts";

/**
 * JSON body limit for the API. The file's text is sent inside a JSON string,
 * where each quote, backslash or newline takes two characters, so a 5 MB file
 * can need just over 10 MB. Anything up to the real limit must reach the
 * importer, which applies IMPORT_MAX_BYTES to the text itself.
 */
export const API_BODY_LIMIT = "11mb";

// Resolved from this file, not the working directory, so the server finds
// its data wherever it is started from.
/** Where memory is kept. Git-ignored. */
export const DATABASE_PATH = fileURLToPath(new URL("../data/minimi.db", import.meta.url));

/** The bundled sample history, anchored to weekdays. */
export const SAMPLE_PATH = fileURLToPath(new URL("../data/sample.json", import.meta.url));

/** The larger samples, imported as they are (shared/samples.ts lists them). */
export const SAMPLES_DIR = fileURLToPath(new URL("../samples/", import.meta.url));
