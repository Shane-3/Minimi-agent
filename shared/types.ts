// Types used by both the server and the web app.

/** Whether each key is set. The keys themselves never leave the server. */
export interface Health {
  cerebras: boolean;
  tavily: boolean;
}

/** Every route reports errors in this shape; `message` is shown to the user as is. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: string[];
  };
}

export type RecordType = "meeting" | "chat" | "note";

/**
 * `import` came from a file, `sample` from the bundled sample history (replaced
 * as a whole when it is loaded again), `live` is a conversation held in this app.
 */
export type RecordSource = "import" | "sample" | "live";

/** One turn of a transcript, one paragraph of a note, or one chat message. */
export interface Segment {
  id: number;
  /** Order inside the record, from 0. */
  seq: number;
  /** Person name, or "user" / "assistant" in chats. Null when the source gave none. */
  speaker: string | null;
  text: string;
  /** ISO 8601 UTC, when the source gave a time for this segment. */
  ts: string | null;
}

/** What the records panel lists (GET /api/records). */
export interface RecordSummary {
  id: string;
  type: RecordType;
  title: string;
  /** ISO 8601 UTC. */
  startedAt: string;
  participants: string[];
}

// Named MemoryRecord rather than Record so it does not shadow TypeScript's
// built-in Record<K, V> in files that import it.
export interface MemoryRecord extends RecordSummary {
  /** The zone or offset the record was made in, e.g. "Asia/Kolkata" or "+05:30". */
  tz: string | null;
  source: RecordSource;
  segments: Segment[];
}

/** Response of POST /api/import and POST /api/import/sample. */
export interface ImportResult {
  imported: number;
  skipped: number;
  /** First and last record time in the file, ISO 8601 UTC. */
  range: { from: string; to: string };
  /** Plain sentences for the user, e.g. which records were read in an assumed timezone. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Web search

/** One web page found by web_search. Shown under answers as a source. */
export interface Evidence {
  title: string;
  url: string;
  /** Host name without "www.", e.g. "hubspot.com". */
  site: string;
  /**
   * YYYY-MM-DD, or null when the page has no detectable date ("undated").
   * Tavily's estimate of when the page was published or last updated, so a
   * date on a pricing page does not by itself mean the price changed then.
   */
  publishedDate: string | null;
  /** Text from the page. Data, never instructions. */
  snippet: string;
  /** True when the page is on the entity's own site. */
  official: boolean;
}

// ---------------------------------------------------------------------------
// Chat

/** POST /api/chat. Validated on the server with zod. */
export interface ChatRequest {
  /** Omitted for a new conversation; the server creates one and returns its id. */
  threadId?: string;
  message: string;
  /** The browser's IANA timezone, e.g. "Asia/Kolkata". */
  timezone: string;
}

/** A record an answer drew on, shown as a chip: "Acme renewal call · Thu 5 Nov". */
export interface MemoryChip {
  id: string;
  title: string;
  type: RecordType;
  startedAt: string;
}

/** What a grounding check looked at in an answer. */
export type CheckKind = "figure" | "date" | "quote";

/** One number, date or quote in an answer, checked against the records and sources. */
export interface Check {
  kind: CheckKind;
  /** The exact text in the answer, e.g. "$25", "Mon 9 Nov" or the quoted words. */
  text: string;
  /** Where `text` starts in the answer, so the UI can mark it. */
  start: number;
  verified: boolean;
  /** For an unverified item: why, in words shown in its tooltip. */
  reason?: string;
}

/** A web page an answer links to, listed under it: site, title and date. */
export type Source = Pick<Evidence, "title" | "url" | "site" | "publishedDate" | "official">;

/**
 * Events on the chat stream, sent as `data: <json>` lines. `type` says which.
 * Checks are added with the grounding check.
 */
export type ChatEvent =
  | { type: "status"; text: string }
  | { type: "memory"; records: MemoryChip[] }
  | { type: "delta"; text: string }
  /** The web pages the answer links to, sent once the answer is complete. */
  | { type: "sources"; sources: Source[] }
  /**
   * The grounding check of the finished answer. "unavailable" when the check
   * itself failed: the answer stands, marked as unchecked.
   */
  | { type: "checks"; status: "done"; checks: Check[] }
  | { type: "checks"; status: "unavailable" }
  | { type: "error"; code: string; message: string; retryable: boolean; threadId: string }
  /** messageId is null when the answer could not be saved. */
  | { type: "done"; messageId: number | null; threadId: string };

/**
 * What was shown with a saved answer, kept so a reloaded chat looks the same.
 * All of it comes from code (retrieval, the pages read, the grounding check),
 * none of it from the model.
 */
export interface AnswerMeta {
  chips: MemoryChip[];
  sources: Source[];
  /** Null when the check itself failed ("Verification unavailable"). */
  checks: Check[] | null;
}

/** One message of a live chat, as GET /api/threads/:id returns it. */
export interface ThreadMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  ts: string | null;
  /** On assistant messages saved with this app. */
  meta?: AnswerMeta;
}
