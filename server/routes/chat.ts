// The chat route: one question in, a stream of events out (ARCHITECTURE.md §4, §6).
import { Router, type Response } from "express";
import { z } from "zod";
import type { ChatEvent, Check, SearchFailures, ThreadMessage } from "../../shared/types.ts";
import { checkAnswer, type GroundingInput } from "../agent/grounding.ts";
import { AgentError, type Agent, type AnswerResult } from "../agent/loop.ts";
import { buildPrompt } from "../agent/prompt.ts";
import { chipsFor, FIRST_STATUS, sourcesFor, statusFor, VERIFY_STATUS } from "../agent/status.ts";
import { MESSAGE_MAX_CHARS } from "../config.ts";
import { parseBody, sendError } from "../http.ts";
import { isValidTimeZone } from "../memory/dates.ts";
import { shortTitle } from "../memory/importer.ts";
import { retrieve } from "../memory/retrieve.ts";
import { StoreError, type Store } from "../memory/store.ts";

export interface ChatRouteOptions {
  store: Store;
  /** Null when CEREBRAS_API_KEY is not set. */
  agent: Agent | null;
  /** Whether the agent was given web_search (TAVILY_API_KEY is set); the prompt's rules depend on it. */
  searchAvailable: boolean;
  /** Injected so tests can fix the time. */
  now?: () => Date;
  /** The grounding check; injected so tests can make it fail. */
  check?: (input: GroundingInput) => Check[];
}

const chatBody = z.object({
  threadId: z.uuid().optional(),
  message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
  timezone: z.string().refine(isValidTimeZone, { error: "is not a timezone this server recognises" }),
});

export function chatRoutes({
  store,
  agent,
  searchAvailable,
  now = () => new Date(),
  check = checkAnswer,
}: ChatRouteOptions): Router {
  const router = Router();

  router.post("/chat", async (req, res) => {
    const body = parseBody(chatBody, req.body, res);
    if (body === null) return;
    if (agent === null) {
      sendError(res, 503, "missing_key", "Add CEREBRAS_API_KEY to .env and restart the server.");
      return;
    }

    const threadId = body.threadId ?? crypto.randomUUID();
    const askedAt = now();
    const stream = openStream(res);
    // The first status goes out before any lookup, so the user sees progress within a second.
    stream.send({ type: "status", text: FIRST_STATUS });

    try {
      const existing = store.getRecord(threadId);
      if (existing !== null && existing.source !== "live") {
        stream.send(errorEvent("bad_request", "That conversation can't be continued.", false, threadId));
        return;
      }
      const saved = (existing?.segments ?? []).flatMap(toThreadMessage);
      // Retry sends the unanswered question again. It is already saved, and
      // it is the question now, so it is not saved twice or sent as history.
      const last = saved.at(-1);
      const retrying = last?.role === "user" && last.text === body.message;
      const history = retrying ? saved.slice(0, -1) : saved;

      // The question is saved before the model runs, so it survives a failed answer.
      if (!retrying) {
        saveQuietly(() => {
          store.ensureLiveChat({
            id: threadId,
            title: shortTitle(body.message),
            startedAt: askedAt.toISOString(),
            tz: body.timezone,
          });
          store.appendSegment(threadId, { speaker: "user", text: body.message, ts: askedAt.toISOString() });
        });
      }

      const retrieval = retrieve(store, body.message, {
        timezone: body.timezone,
        now: askedAt,
        excludeRecordId: threadId,
      });
      const chips = chipsFor(retrieval);
      if (chips.length > 0) stream.send({ type: "memory", records: chips });
      stream.send({ type: "status", text: statusFor(retrieval, body.timezone, askedAt) });

      const prompt = buildPrompt({
        retrieval,
        question: body.message,
        history,
        timezone: body.timezone,
        now: askedAt,
        searchAvailable,
      });
      const result = await agent.answer({
        ...prompt,
        signal: stream.signal,
        onText: (text) => stream.send({ type: "delta", text }),
        onStatus: (text) => stream.send({ type: "status", text }),
      });

      const sources = sourcesFor(result.evidence, result.text);
      if (sources.length > 0) stream.send({ type: "sources", sources });
      const searchFailed = failuresOf(result.failedSearches);
      if (searchFailed !== undefined) stream.send({ type: "search_failed", ...searchFailed });

      stream.send({ type: "status", text: VERIFY_STATUS });
      const checks = verify(() =>
        check({
          answer: result.text,
          question: body.message,
          retrieval,
          history,
          evidence: result.evidence,
          timezone: body.timezone,
          now: askedAt,
        }),
      );
      stream.send(checks === null ? { type: "checks", status: "unavailable" } : { type: "checks", status: "done", checks });

      if (result.stopReason === "max_tokens") {
        // Cut off: kept on screen but not saved as a complete answer.
        stream.send(errorEvent("incomplete", "This answer was cut off. Retry for a complete one.", true, threadId));
        return;
      }

      const messageId = saveQuietly(() =>
        store.appendSegment(
          threadId,
          { speaker: "assistant", text: result.text, ts: now().toISOString() },
          { chips, sources, checks, ...(searchFailed === undefined ? {} : { searchFailed }) },
        ),
      );
      stream.send({ type: "done", messageId, threadId });
    } catch (error) {
      if (error instanceof AgentError) {
        // After Stop or a closed page there is no one to tell.
        if (error.code !== "aborted") {
          // The user sees a plain message; the server log keeps the API's own
          // reason (a billing or key problem shows only here).
          console.error(`[chat] Answer failed (${error.code}):`, error.cause ?? error.message);
          stream.send(errorEvent(error.code, error.message, error.retryable, threadId));
        }
      } else if (error instanceof StoreError) {
        console.error(`[chat] ${error.message}`, error.cause);
        stream.send(errorEvent("database_error", "Your records can't be read right now. Try again.", true, threadId));
      } else {
        console.error("[chat] Unexpected error:", error);
        stream.send(errorEvent("internal", "Something went wrong on the server. Try again.", true, threadId));
      }
    } finally {
      stream.end();
    }
  });

  router.get("/threads/:id", (req, res) => {
    try {
      const record = store.getRecord(req.params.id);
      if (record === null || record.source !== "live") {
        sendError(res, 404, "not_found", "That conversation no longer exists.");
        return;
      }
      const meta = store.answerMeta(record.id);
      const messages: ThreadMessage[] = record.segments.flatMap(toThreadMessage).map((message) => {
        const shown = meta.get(message.id);
        return shown === undefined ? message : { ...message, meta: shown };
      });
      res.json(messages);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      console.error(`[chat] ${error.message}`, error.cause);
      sendError(res, 500, "database_error", "This conversation can't be loaded right now.");
    }
  });

  return router;
}

interface EventStream {
  send(event: ChatEvent): void;
  end(): void;
  /** Aborts when the browser goes away, which stops the model call. */
  signal: AbortSignal;
}

function openStream(res: Response): EventStream {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  return {
    send(event) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
    signal: controller.signal,
  };
}

/**
 * What the UI says about failed searches. Asking again cannot help when the
 * search key itself was rejected, so then there is no "Check again".
 */
function failuresOf(failed: AnswerResult["failedSearches"]): SearchFailures | undefined {
  if (failed.length === 0) return undefined;
  return { entities: failed.map((item) => item.entity), retryable: failed.some((item) => item.failure !== "auth") };
}

/**
 * The check is a safety net, not a gate: if it fails, the answer stands and is
 * marked as unchecked (REQUIREMENTS.md §5).
 */
function verify(run: () => Check[]): Check[] | null {
  try {
    return run();
  } catch (error) {
    console.error("[chat] Grounding check failed:", error);
    return null;
  }
}

function errorEvent(code: string, message: string, retryable: boolean, threadId: string): ChatEvent {
  return { type: "error", code, message, retryable, threadId };
}

function toThreadMessage(segment: { id: number; speaker: string | null; text: string; ts: string | null }): ThreadMessage[] {
  if (segment.speaker !== "user" && segment.speaker !== "assistant") return [];
  return [{ id: segment.id, role: segment.speaker, text: segment.text, ts: segment.ts }];
}

/**
 * Saving a turn must never cost the user their answer. A database failure is
 * logged and the conversation carries on; telling the user is part of the
 * failure-case work (build step 10).
 */
function saveQuietly<T>(save: () => T): T | null {
  try {
    return save();
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    console.error(`[chat] ${error.message}`, error.cause);
    return null;
  }
}
