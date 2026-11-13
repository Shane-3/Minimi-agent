// Limits the browser and the server must agree on. The server enforces them;
// the browser checks them first so the user hears at once.

/** Largest import file, in bytes. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/** Longest chat message, in characters. */
export const MESSAGE_MAX_CHARS = 4_000;

/** The composer shows a character counter from this length. */
export const MESSAGE_COUNTER_FROM = 3_500;
