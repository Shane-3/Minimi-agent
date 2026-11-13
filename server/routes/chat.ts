// The chat route: one question in, a stream of events out (ARCHITECTURE.md §4, §6).
import { Router, type Response } from "express";
import { z } from "zod";
import type { ChatEvent, ThreadMessage } from "../../shared/types.ts";
import { AgentError, type Agent } from "../agent/loop.ts";
import { buildPrompt } from "../agent/prompt.ts";
import { chipsFor, FIRST_STATUS, sourcesFor, statusFor } from "../agent/status.ts";
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
}

const chatBody = z.object({
  threadId: z.uuid().optional(),
  message: z.string().trim().min(1).max(MESSAGE_MAX_CHARS),
  timezone: z.string().refine(isValidTimeZone, { error: "is not a timezone this server recognises" }),
});

export function chatRoutes({ store, agent, searchAvailable, now = () => new Date() }: ChatRouteOptions): Router {
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
      const history = (existing?.segments ?? []).flatMap(toThreadMessage);

      // The question is saved before the model runs, so it survives a failed answer.
      saveQuietly(() => {
        store.ensureLiveChat({
          id: threadId,
          title: shortTitle(body.message),
          startedAt: askedAt.toISOString(),
          tz: body.timezone,
        });
        store.appendSegment(threadId, { speaker: "user", text: body.message, ts: askedAt.toISOString() });
      });

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

      if (result.stopReason === "max_tokens") {
        // Cut off: kept on screen but not saved as a complete answer.
        stream.send(errorEvent("incomplete", "This answer was cut off. Retry for a complete one.", true, threadId));
        return;
      }

      const messageId = saveQuietly(() =>
        store.appendSegment(threadId, { speaker: "assistant", text: result.text, ts: now().toISOString() }),
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
      const messages: ThreadMessage[] = record.segments.flatMap(toThreadMessage);
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
