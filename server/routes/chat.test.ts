import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, ChatEvent, ThreadMessage } from "../../shared/types.ts";
import { AgentError, type Agent, type AnswerRequest } from "../agent/loop.ts";
import { createApi } from "../api.ts";
import { Store } from "../memory/store.ts";

const SAMPLE_PATH = fileURLToPath(new URL("../../data/sample.json", import.meta.url));
const KOLKATA = "Asia/Kolkata";
const NOW = new Date("2026-11-11T06:00:00Z");

/** A stand-in agent that records each request and plays a scripted reply. */
function fakeAgent(
  reply: (request: AnswerRequest) => Promise<{ text: string; stopReason?: "end_turn" | "max_tokens" }>,
) {
  const requests: AnswerRequest[] = [];
  const agent: Agent = {
    async answer(request) {
      requests.push(request);
      const { text, stopReason = "end_turn" } = await reply(request);
      return { text, stopReason, model: "test-model" };
    },
  };
  return { agent, requests };
}

function streams(pieces: string[]) {
  return async (request: AnswerRequest) => {
    for (const piece of pieces) request.onText(piece);
    return { text: pieces.join("") };
  };
}

let store: Store;
let server: http.Server;
let base: string;

async function start(agent: Agent | null): Promise<void> {
  const app = express();
  app.use(
    "/api",
    createApi({
      env: { geminiKey: agent === null ? null : "a-key", tavilyKey: null, port: 0, model: "test-model" },
      store,
      samplePath: SAMPLE_PATH,
      agent,
      now: () => NOW,
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
}

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Sends a question and reads the whole event stream. */
async function ask(body: { message: string; threadId?: string }): Promise<ChatEvent[]> {
  const response = await post("/chat", { timezone: KOLKATA, ...body });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as ChatEvent);
}

const types = (events: ChatEvent[]) => events.map((event) => event.type);

describe("POST /api/chat", () => {
  it("streams status, memory chips, the answer, then done", async () => {
    await start(fakeAgent(streams(["The shortlist ", "is five tools."])).agent);
    await post("/import/sample", { timezone: KOLKATA });

    const events = await ask({ message: "On Monday we shortlisted 5 CRM tools. What were they?" });
    expect(types(events)).toEqual(["status", "memory", "status", "delta", "delta", "done"]);
    expect(events[0]).toEqual({ type: "status", text: "Looking through your records" });
    expect(events[1]).toMatchObject({ type: "memory", records: [{ id: "sample-crm-shortlist", title: "CRM shortlist review" }] });
    expect(events[2]).toEqual({ type: "status", text: "Reading CRM shortlist review · Mon 9 Nov" });
  });

  it("saves the question and the answer as a chat that can be reloaded and recalled", async () => {
    await start(fakeAgent(streams(["Five tools."])).agent);
    const events = await ask({ message: "Which tools did we shortlist?" });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    const threadId = done?.type === "done" ? done.threadId : "";

    const thread = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    expect(thread.map((message) => [message.role, message.text])).toEqual([
      ["user", "Which tools did we shortlist?"],
      ["assistant", "Five tools."],
    ]);
    expect(store.getRecord(threadId)).toMatchObject({ type: "chat", source: "live", title: "Which tools did we shortlist?" });
  });

  it("sends the earlier turns of the same conversation, and leaves the conversation out of memory", async () => {
    const { agent, requests } = fakeAgent(streams(["ok"]));
    await start(agent);
    const first = await ask({ message: "What did we decide about Acme?" });
    const threadId = first.at(-1)?.type === "done" ? (first.at(-1) as { threadId: string }).threadId : "";

    await ask({ message: "And who owns the next step?", threadId });
    const second = requests[1]!;
    expect(second.contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    expect(second.contents[0]?.parts).toEqual([{ text: "What did we decide about Acme?" }]);
    // Its own messages are already in the conversation, so not repeated as a record.
    expect(second.system).not.toContain("What did we decide about Acme?");
  });

  it("recalls a different, earlier conversation as a record", async () => {
    const { agent, requests } = fakeAgent(streams(["ok"]));
    await start(agent);
    await ask({ message: "What does the zebra crossing project need?" });
    await ask({ message: "What did I ask about the zebra crossing?" });
    expect(requests[1]?.system).toContain("User: What does the zebra crossing project need?");
  });

  it("keeps the question when the answer fails, and says so with a retry", async () => {
    await start(
      fakeAgent(async () => {
        throw new AgentError("unavailable", "The answer didn't come through. Your message is saved.", { retryable: true });
      }).agent,
    );
    const events = await ask({ message: "What did we decide?" });
    const error = events.at(-1);
    expect(error).toMatchObject({
      type: "error",
      code: "unavailable",
      message: "The answer didn't come through. Your message is saved.",
      retryable: true,
    });
    const threadId = error?.type === "error" ? error.threadId : "";
    expect(store.getRecord(threadId)?.segments.map((segment) => segment.speaker)).toEqual(["user"]);
  });

  it("does not save an answer that was cut off", async () => {
    await start(fakeAgent(async (request) => {
      request.onText("Half");
      return { text: "Half", stopReason: "max_tokens" };
    }).agent);
    const events = await ask({ message: "Summarise everything" });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "incomplete", retryable: true });
    const threadId = (events.at(-1) as { threadId: string }).threadId;
    expect(store.getRecord(threadId)?.segments).toHaveLength(1);
  });

  it("ends quietly when the user stops", async () => {
    await start(
      fakeAgent(async () => {
        throw new AgentError("aborted", "Stopped.", { retryable: true });
      }).agent,
    );
    expect(types(await ask({ message: "What did we decide?" }))).toEqual(["status", "status"]);
  });

  it("says nothing is loaded when there are no records", async () => {
    await start(fakeAgent(streams(["ok"])).agent);
    const events = await ask({ message: "What did we decide?" });
    expect(events[1]).toEqual({ type: "status", text: "No records loaded yet" });
  });

  it("refuses to continue a conversation id that belongs to an imported record", async () => {
    await start(fakeAgent(streams(["ok"])).agent);
    await post("/import/sample", { timezone: KOLKATA });
    // Sample ids are not UUIDs, so they fail validation before reaching the store.
    const response = await post("/chat", { timezone: KOLKATA, message: "Hi", threadId: "sample-crm-shortlist" });
    expect(response.status).toBe(400);
  });

  it("refuses to add messages to an imported record, even when its id is a UUID", async () => {
    await start(fakeAgent(streams(["ok"])).agent);
    const file = JSON.stringify([{ type: "note", title: "Plan", timestamp: "2026-11-10T10:00:00+05:30", content: "A plan." }]);
    await post("/import", { timezone: KOLKATA, content: file });
    const imported = store.listRecords()[0]!;
    const events = await ask({ message: "Hi", threadId: imported.id });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "bad_request", retryable: false });
    expect(store.getRecord(imported.id)?.segments).toHaveLength(1);
  });

  it("answers 503 with the setup message when the Gemini key is missing", async () => {
    await start(null);
    const response = await post("/chat", { timezone: KOLKATA, message: "Hi" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "missing_key",
      message: "Add GEMINI_API_KEY to .env and restart the server.",
    });
  });

  it("rejects an empty message, one over the length limit, and an unknown timezone", async () => {
    await start(fakeAgent(streams(["ok"])).agent);
    for (const body of [
      { timezone: KOLKATA, message: "   " },
      { timezone: KOLKATA, message: "x".repeat(4_001) },
      { timezone: "Mars/Olympus", message: "Hi" },
    ]) {
      expect((await post("/chat", body)).status).toBe(400);
    }
  });
});

describe("GET /api/threads/:id", () => {
  it("answers 404 for an unknown conversation and for a record that is not a chat", async () => {
    await start(fakeAgent(streams(["ok"])).agent);
    await post("/import/sample", { timezone: KOLKATA });
    expect((await fetch(`${base}/threads/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await fetch(`${base}/threads/sample-crm-shortlist`)).status).toBe(404);
  });
});
