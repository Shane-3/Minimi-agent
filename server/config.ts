// Every tunable limit lives here (ARCHITECTURE.md §9). Starting values,
// adjusted while running the evals.

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

/** Where memory is kept. Git-ignored. */
export const DATABASE_PATH = "data/minimi.db";

/** The bundled sample history, with dates relative to today. */
export const SAMPLE_PATH = "data/sample.json";
