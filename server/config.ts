// Every tunable limit lives here (ARCHITECTURE.md §9). Starting values,
// adjusted while running the evals.
import { fileURLToPath } from "node:url";

/** Model turns per answer. */
export const STEP_CAP = 4;

/** Search queries run at once in one model step. */
export const MAX_PARALLEL_SEARCHES = 10;

export const SEARCH_TIMEOUT_MS = 8_000;
export const MODEL_TIMEOUT_MS = 60_000;
export const MODEL_RETRIES = 1;
/** Wait before the one retry after an overload or server error. */
export const MODEL_RETRY_DELAY_MS = 1_500;

/** The model, unless ANTHROPIC_MODEL in .env names another. The only place a model id is written. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Reasoning depth. Thinking cannot be turned off on this model; effort is the
 * control. "medium" is its default, set here so a change is deliberate.
 */
export const MODEL_EFFORT = "medium";

/** Room for thinking plus the answer. Streaming, so a large cap costs nothing unless used. */
export const MODEL_MAX_TOKENS = 32_000;

/** Tokens of record text the prompt may hold. */
export const RECORD_CONTEXT_BUDGET_TOKENS = 80_000;

/** Rough token estimate. Good enough for a budget; no tokenizer dependency. */
export const CHARS_PER_TOKEN = 4;

/** Allowance per segment for the speaker label and line break in the prompt. */
export const SEGMENT_OVERHEAD_TOKENS = 3;

/** When a record is too long to load whole: segments kept either side of each match. */
export const PARTIAL_NEIGHBOUR_SEGMENTS = 2;

/** Search hits read when ranking records by topic. */
export const TOPIC_SEARCH_LIMIT = 200;

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const MESSAGE_MAX_CHARS = 4_000;

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
