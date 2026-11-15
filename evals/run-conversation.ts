// npx tsx evals/run-conversation.ts
// Holds follow-up conversations through the real chat route, as the browser
// does: the second large sample loaded into an in-memory database, the real
// model and search, each turn in the same thread. Prints every answer with
// its chips and check result, then reloads each thread the way the page does
// after a refresh. For a person to read: the answers are free text.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import type { ChatEvent, ThreadMessage } from "../shared/types.ts";
import { createAgent } from "../server/agent/loop.ts";
import { createWebSearch } from "../server/agent/search.ts";
import { createApi } from "../server/api.ts";
import { SAMPLE_PATH } from "../server/config.ts";
import { Store } from "../server/memory/store.ts";
import { takeEvents } from "../web/http/client.ts";
import { evalEnv, TIMEZONE } from "./setup.ts";

const SAMPLE = fileURLToPath(new URL("../data/large-sample-2.json", import.meta.url));
const CALL_GAP_MS = 15_000;

const conversations: string[][] = [
  ["Who is our new CTO?", "Why was the first choice not hired?", "anyone else got opinion on this?"],
  ["When did the M2 launch?", "and how many preorders did we get?", "what about the batteries, did they all arrive?"],
];

async function main(): Promise<void> {
  const env = evalEnv();
  const webSearch = env.tavilyKey === null ? undefined : createWebSearch({ apiKey: env.tavilyKey });
  const agent = createAgent({ apiKey: env.cerebrasKey, models: env.models, ...(webSearch ? { webSearch } : {}) });
  const store = new Store(":memory:");
  const app = express();
  app.use("/api", createApi({ env, store, samplePath: SAMPLE_PATH, agent }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const imported = await (await post("/import", { content: readFileSync(SAMPLE, "utf8"), timezone: TIMEZONE })).json();
  console.log("Import:", JSON.stringify(imported), "\n");

  let first = true;
  for (const turns of conversations) {
    const threadId = crypto.randomUUID();
    console.log(`##### Conversation ${threadId.slice(0, 8)}`);
    for (const message of turns) {
      if (!first) await new Promise((resolve) => setTimeout(resolve, CALL_GAP_MS));
      first = false;
      const started = performance.now();
      const events = takeEvents(await (await post("/chat", { threadId, message, timezone: TIMEZONE })).text()).events;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const text = events.flatMap((event: ChatEvent) => (event.type === "delta" ? [event.text] : [])).join("");
      const chips = events.find((event) => event.type === "memory");
      const checks = events.find((event) => event.type === "checks");
      const end = events.at(-1);
      console.log(`=== ${message}  (${seconds}s)`);
      console.log(`chips: ${chips?.type === "memory" ? chips.records.map((chip) => chip.title).join(" | ") : "none"}`);
      console.log(`ANSWER:\n${text.replace(/^/gm, "  ")}`);
      if (checks?.type === "checks") {
        const unverified = checks.status === "done" ? checks.checks.filter((check) => !check.verified) : [];
        console.log(`checks: ${checks.status}${unverified.map((check) => `\n  unverified ${check.kind}: ${JSON.stringify(check.text)} (${check.reason ?? ""})`).join("")}`);
      }
      console.log(`end: ${JSON.stringify(end)}\n`);
    }
    // A reload: the thread comes back with what was shown with each answer.
    const thread = (await (await fetch(`${base}/threads/${threadId}`)).json()) as ThreadMessage[];
    const answers = thread.filter((item) => item.role === "assistant");
    console.log(`reload: ${thread.length} messages, ${answers.filter((item) => item.meta !== undefined).length} of ${answers.length} answers with their chips and checks\n`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
}

await main();
