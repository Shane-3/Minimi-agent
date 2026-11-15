import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError, ChatEvent, Check, Evidence, ThreadMessage } from "../../shared/types.ts";
import type { GroundingInput } from "../agent/grounding.ts";
import { AgentError, type Agent, type AnswerRequest, type AnswerResult } from "../agent/loop.ts";
import { createApi } from "../api.ts";
import { Store, StoreError } from "../memory/store.ts";

const SAMPLE_PATH = fileURLToPath(new URL("../../data/sample.json", import.meta.url));
const KOLKATA = "Asia/Kolkata";
const NOW = new Date("2026-11-11T06:00:00Z");

/** A stand-in agent that records each request and plays a scripted reply. */
function fakeAgent(
  reply: (
    request: AnswerRequest,
  ) => Promise<{
    text: string;
    stopReason?: "end_turn" | "max_tokens";
    evidence?: Evidence[];
    searches?: number;
    failedSearches?: AnswerResult["failedSearches"];
  }>,
) {
  const requests: AnswerRequest[] = [];
  const agent: Agent = {
    async answer(request) {
      requests.push(request);
      const { text, stopReason = "end_turn", evidence = [], searches = 0, failedSearches = [] } = await reply(request);
      return { text, stopReason, model: "test-model", evidence, searches, failedSearches };
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

async function start(agent: Agent | null, check?: (input: GroundingInput) => Check[]): Promise<void> {
  const app = express();
  app.use(
    "/api",
    createApi({
      env: { cerebrasKey: agent === null ? null : "a-key", tavilyKey: null, port: 0, models: ["test-model"] },
      store,
      samplePath: SAMPLE_PATH,
      agent,
      now: () => NOW,
      check,
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
  it("streams status, memory chips, the answer, the check, then done", async () => {
    await start(fakeAgent(streams(["The shortlist ", "is five tools."])).agent);
    await post("/import/sample", { timezone: KOLKATA });

    const events = await ask({ message: "On Monday we shortlisted 5 CRM tools. What were they?" });
    expect(types(events)).toEqual(["status", "memory", "status", "delta", "delta", "status", "checks", "done"]);
    expect(events[0]).toEqual({ type: "status", text: "Looking through your records" });
    expect(events[1]).toMatchObject({ type: "memory", records: [{ id: "sample-crm-shortlist", title: "CRM shortlist review" }] });
    expect(events[2]).toEqual({ type: "status", text: "Reading CRM shortlist review · Mon 9 Nov" });
    expect(events[5]).toEqual({ type: "status", text: "Verifying figures" });
  });

  it("passes on the agent's search status, and lists the sources the answer links to", async () => {
    const used: Evidence = {
      title: "Example pricing",
      url: "https://example.com/pricing",
      site: "example.com",
      publishedDate: "2026-11-10",
      snippet: "Plan details.",
      official: true,
    };
    const unused: Evidence = { ...used, title: "Other page", url: "https://other.example.org/page", official: false };
    await start(
      fakeAgent(async (request) => {
        request.onStatus?.("Checking example.com");
        const text = "**Example**: no announced change found. ([example.com](https://example.com/pricing), Tue 10 Nov)";
        request.onText(text);
        return { text, evidence: [used, unused], searches: 1 };
      }).agent,
    );
    const events = await ask({ message: "Has Example changed its pricing?" });
    expect(events).toContainEqual({ type: "status", text: "Checking example.com" });
    expect(events.find((event) => event.type === "sources")).toEqual({
      type: "sources",
      sources: [{ title: "Example pricing", url: "https://example.com/pricing", site: "example.com", publishedDate: "2026-11-10", official: true }],
    });
    // FRONTEND.md: chips, answer text, sources, then the verification note.
    expect(types(events).slice(-4)).toEqual(["sources", "status", "checks", "done"]);
  });

  it("says which searches failed, saves it, and offers no retry when the key was rejected", async () => {
    await start(
      fakeAgent(async (request) => {
        request.onText("HubSpot: couldn't verify.");
        return {
          text: "HubSpot: couldn't verify.",
          searches: 1,
          failedSearches: [
            { entity: "HubSpot", failure: "timeout" },
            { entity: "Pipedrive", failure: "auth" },
          ],
        };
      }).agent,
    );
    const events = await ask({ message: "Has pricing changed?" });
    expect(events).toContainEqual({ type: "search_failed", entities: ["HubSpot", "Pipedrive"], retryable: true });
    const threadId = events.at(-1)?.type === "done" ? (events.at(-1) as { threadId: string }).threadId : "";
    const thread = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    expect(thread[1]!.meta?.searchFailed).toEqual({ entities: ["HubSpot", "Pipedrive"], retryable: true });
  });

  it("marks failed searches as not worth retrying when every failure was the key", async () => {
    await start(fakeAgent(async () => ({ text: "x", failedSearches: [{ entity: "HubSpot", failure: "auth" }] })).agent);
    expect(await ask({ message: "Has pricing changed?" })).toContainEqual({ type: "search_failed", entities: ["HubSpot"], retryable: false });
  });

  it("sends no sources event for an answer that links to none", async () => {
    await start(fakeAgent(streams(["From the records."])).agent);
    expect(types(await ask({ message: "What did we decide?" }))).not.toContain("sources");
  });

  it("checks the answer against the loaded records and the pages the agent read", async () => {
    const page: Evidence = {
      title: "Example pricing",
      url: "https://example.com/pricing",
      site: "example.com",
      publishedDate: "2026-11-10",
      snippet: "Team plan: 15 USD per seat, billed monthly.",
      official: true,
    };
    await start(
      fakeAgent(async (request) => {
        const text = "You shortlisted 5 tools on Mon 9 Nov. Example's Team plan is $15/user/mo, not $18.";
        request.onText(text);
        return { text, evidence: [page], searches: 1 };
      }).agent,
    );
    await post("/import/sample", { timezone: KOLKATA });

    const events = await ask({ message: "On Monday we shortlisted 5 CRM tools. Has Example's price changed?" });
    const checks = events.find((event) => event.type === "checks");
    expect(checks).toMatchObject({ status: "done" });
    const marks = checks?.type === "checks" && checks.status === "done" ? checks.checks : [];
    expect(marks.map((item) => [item.text, item.verified])).toEqual([
      ["5", true],
      ["Mon 9 Nov", true],
      ["$15", true],
      ["$18", false],
    ]);
  });

  it("still gives and saves the answer when the check itself fails", async () => {
    await start(fakeAgent(streams(["From the records."])).agent, () => {
      throw new Error("check broke");
    });
    const events = await ask({ message: "What did we decide?" });
    expect(events).toContainEqual({ type: "checks", status: "unavailable" });
    expect(types(events).slice(-2)).toEqual(["checks", "done"]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done" });
    const threadId = done?.type === "done" ? done.threadId : "";
    const saved = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    expect(saved.map((message) => message.text)).toEqual(["What did we decide?", "From the records."]);
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
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[0]?.content).toBe("What did we decide about Acme?");
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

  it("on retry, answers the saved question without saving it twice or sending it as history", async () => {
    let calls = 0;
    const { agent, requests } = fakeAgent(async (request) => {
      calls += 1;
      if (calls === 1) throw new AgentError("unavailable", "The answer didn't come through. Your message is saved.", { retryable: true });
      request.onText("Nothing was decided.");
      return { text: "Nothing was decided." };
    });
    await start(agent);
    const failed = await ask({ message: "What did we decide?" });
    const threadId = failed.at(-1)?.type === "error" ? (failed.at(-1) as { threadId: string }).threadId : "";

    const retried = await ask({ message: "What did we decide?", threadId });
    expect(retried.at(-1)).toMatchObject({ type: "done", threadId });
    expect(store.getRecord(threadId)?.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      ["user", "What did we decide?"],
      ["assistant", "Nothing was decided."],
    ]);
    const lastPrompt = requests.at(-1)!.messages;
    expect(lastPrompt.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("reloads a saved answer with the chips, sources and checks shown with it", async () => {
    const page: Evidence = {
      title: "Example pricing",
      url: "https://example.com/pricing",
      site: "example.com",
      publishedDate: "2026-11-10",
      snippet: "Team plan: 15 USD per seat.",
      official: true,
    };
    await start(
      fakeAgent(async (request) => {
        const text = "You shortlisted 5 tools. Team is $15 ([example.com](https://example.com/pricing)).";
        request.onText(text);
        return { text, evidence: [page], searches: 1 };
      }).agent,
    );
    await post("/import/sample", { timezone: KOLKATA });
    const events = await ask({ message: "On Monday we shortlisted 5 CRM tools. What does Example cost?" });
    const threadId = events.at(-1)?.type === "done" ? (events.at(-1) as { threadId: string }).threadId : "";

    const thread = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    expect(thread[0]!.meta).toBeUndefined();
    expect(thread[1]!.meta).toMatchObject({
      chips: [{ id: "sample-crm-shortlist" }],
      sources: [{ url: "https://example.com/pricing" }],
      checks: [
        { text: "5", verified: true },
        { text: "$15", verified: true },
      ],
    });
  });

  it("saves a failed check as unavailable, so a reload says so too", async () => {
    await start(fakeAgent(streams(["From the records."])).agent, () => {
      throw new Error("check broke");
    });
    const events = await ask({ message: "What did we decide?" });
    const threadId = events.at(-1)?.type === "done" ? (events.at(-1) as { threadId: string }).threadId : "";
    const thread = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    expect(thread[1]!.meta).toEqual({ chips: [], sources: [], checks: null });
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

  it("still answers when the chat can't be saved, and says it wasn't saved", async () => {
    await start(fakeAgent(streams(["From the records."])).agent);
    vi.spyOn(store, "appendSegment").mockImplementation(() => {
      throw new StoreError("Could not save the message.");
    });
    const events = await ask({ message: "What did we decide?" });
    expect(events.filter((event) => event.type === "delta")).toEqual([{ type: "delta", text: "From the records." }]);
    // messageId null is what the UI turns into "This chat can't be saved right now. You can keep talking."
    expect(events.at(-1)).toMatchObject({ type: "done", messageId: null });
  });

  it("says plainly when the records can't be read", async () => {
    await start(fakeAgent(streams(["unused"])).agent);
    vi.spyOn(store, "getRecord").mockImplementation(() => {
      throw new StoreError("Could not read a record.");
    });
    const events = await ask({ message: "What did we decide?" });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "database_error",
      message: "Your records can't be read right now. Try again.",
      retryable: true,
    });
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

  it("answers 503 with the setup message when the Cerebras key is missing", async () => {
    await start(null);
    const response = await post("/chat", { timezone: KOLKATA, message: "Hi" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "missing_key",
      message: "Add CEREBRAS_API_KEY to .env and restart the server.",
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
