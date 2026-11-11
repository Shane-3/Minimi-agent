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

/** Tokens of record text the prompt may hold. */
export const RECORD_CONTEXT_BUDGET_TOKENS = 80_000;

/** Rough token estimate. Good enough for a budget; no tokenizer dependency. */
export const CHARS_PER_TOKEN = 4;

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
