// Fetch wrappers for the API and the reader for the chat stream.
// Responses come from this app's own server, whose routes are typed with the
// same shared types, so they are read with a type assertion, not re-validated.
import type {
  ApiError,
  ChatEvent,
  ChatRequest,
  Health,
  ImportResult,
  MemoryRecord,
  RecordSummary,
  ThreadMessage,
} from "../../shared/types.ts";

/** A failed request, with the server's message when it sent one. */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details: string[];

  constructor(code: string, message: string, status: number | null, details: string[] = []) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const NETWORK_MESSAGE = "The server can't be reached. Check that it is running, then try again.";

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (error) {
    // Stop is not a failure; the caller decides what it means.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiFailure("network", NETWORK_MESSAGE, null);
  }
  if (response.ok) return response;

  let body: Partial<ApiError> = {};
  try {
    body = (await response.json()) as ApiError;
  } catch {
    // Not our error shape (a proxy page, say); the generic message below stands.
  }
  const error = body.error;
  throw new ApiFailure(
    error?.code ?? "http_error",
    error?.message ?? "Something went wrong on the server. Try again.",
    response.status,
    error?.details ?? [],
  );
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await request(path, init)).json()) as T;
}

const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  health: () => json<Health>("/health"),
  records: () => json<RecordSummary[]>("/records"),
  record: (id: string) => json<MemoryRecord>(`/records/${encodeURIComponent(id)}`),
  removeRecord: async (id: string) => {
    await request(`/records/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  clearAll: async () => {
    await request("/records", { method: "DELETE" });
  },
  /** `content` is the file's raw text; every check on it runs on the server. */
  importFile: (content: string, timezone: string) => json<ImportResult>("/import", jsonBody({ content, timezone })),
  importSample: (timezone: string) => json<ImportResult>("/import/sample", jsonBody({ timezone })),
  thread: (id: string) => json<ThreadMessage[]>(`/threads/${encodeURIComponent(id)}`),
};

/**
 * Splits complete `data:` events off the front of what has arrived so far.
 * Whatever is left is the start of an event still arriving.
 */
export function takeEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events = chunks.flatMap((chunk) => {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    return data === "" ? [] : [JSON.parse(data) as ChatEvent];
  });
  return { events, rest };
}

/**
 * Sends a question and calls `onEvent` for each event. Resolves true when the
 * stream ended with `done` or `error`, false when it was cut short. Throws
 * ApiFailure when the request is refused or the server can't be reached, and
 * the AbortError when `signal` aborts (Stop).
 */
export async function streamChat(
  body: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<boolean> {
  // The chat request is a POST, so EventSource can't be used; fetch streams it.
  const response = await request("/chat", { ...jsonBody(body), signal });
  if (response.body === null) return false;

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const taken = takeEvents(buffer + value);
      buffer = taken.rest;
      for (const event of taken.events) {
        if (event.type === "done" || event.type === "error") finished = true;
        onEvent(event);
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // The connection dropped mid-answer: reported as cut short, not thrown.
    return false;
  }
  return finished;
}
