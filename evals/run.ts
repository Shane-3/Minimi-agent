// npm run eval [case numbers...]
// Runs the eval cases against the sample history with real model calls,
// through the same retrieval, prompt and loop the chat route uses.
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { AgentError, createAgent } from "../server/agent/loop.ts";
import { buildPrompt } from "../server/agent/prompt.ts";
import { SAMPLE_PATH } from "../server/config.ts";
import { readEnv } from "../server/env.ts";
import { addDays, formatDay, partsInZone, todayIn } from "../server/memory/dates.ts";
import { loadSampleInto, prepareSample } from "../server/memory/importer.ts";
import { retrieve } from "../server/memory/retrieve.ts";
import { Store } from "../server/memory/store.ts";
import { evalCases, type EvalContext } from "./cases.ts";

const TIMEZONE = "Asia/Kolkata";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function main(): Promise<void> {
  dotenv.config({ override: true, quiet: true });
  const env = readEnv(process.env);
  if (env.geminiKey === null) {
    console.error("Add GEMINI_API_KEY to .env to run the evals. They make real model calls.");
    process.exit(1);
  }
  const agent = createAgent({ apiKey: env.geminiKey, model: env.model });

  const now = new Date();
  const store = new Store(":memory:");
  const sample = JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as unknown;
  loadSampleInto(store, prepareSample(sample, TIMEZONE, now), TIMEZONE);

  const context = evalContext(store, now);
  const only = new Set(process.argv.slice(2).map(Number));
  const cases = evalCases(context).filter((evalCase) => only.size === 0 || only.has(evalCase.id));

  console.log(`Model ${env.model}, sample loaded as of ${formatDay(todayIn(now, TIMEZONE), todayIn(now, TIMEZONE))} (${TIMEZONE})\n`);
  let failed = 0;
  for (const [index, evalCase] of cases.entries()) {
    // The free tier allows 5 requests a minute; spacing the calls keeps a run
    // of seven inside that.
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, CALL_GAP_MS));
    const asked = new Date();
    const retrieval = retrieve(store, evalCase.question, { timezone: TIMEZONE, now: asked });
    const prompt = buildPrompt({ retrieval, question: evalCase.question, history: [], timezone: TIMEZONE, now: asked });

    let started = performance.now();
    let firstText: number | null = null;
    let answer: string;
    const ask = async () => {
      started = performance.now();
      firstText = null;
      const result = await agent.answer({
        ...prompt,
        onText: () => {
          firstText ??= performance.now();
        },
      });
      return result.text;
    };
    try {
      try {
        answer = await ask();
      } catch (error) {
        // Out of requests for the day: every later case would fail the same
        // way and say nothing about the answers, so stop here.
        if (error instanceof AgentError && error.code === "quota_exhausted") {
          console.log(`STOP at case ${evalCase.id}: ${error.message}`);
          store.close();
          process.exit(1);
        }
        // Hitting the per-minute limit says nothing about the answers either,
        // so wait out the minute and ask again once. Timings are of the second try.
        if (!(error instanceof AgentError && error.code === "rate_limited")) throw error;
        console.log(`     ${evalCase.id}. rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000}s and asking again`);
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
        answer = await ask();
      }
    } catch (error) {
      failed += 1;
      // The cause is the SDK's own error (status and API message), which the
      // user-facing message hides; whoever runs the evals needs it.
      const cause = error instanceof Error && error.cause !== undefined ? `\n  cause: ${String(error.cause)}` : "";
      console.log(`FAIL ${evalCase.id}. ${evalCase.name}: the model call failed\n  ${String(error)}${cause}\n`);
      continue;
    }
    const seconds = (ms: number | null) => (ms === null ? "-" : `${((ms - started) / 1000).toFixed(1)}s`);

    const misses = evalCase.checks.filter((check) => !check.pass(answer)).map((check) => check.name);
    const timing = `first text ${seconds(firstText)}, done ${seconds(performance.now())}`;
    if (misses.length === 0) {
      console.log(`PASS ${evalCase.id}. ${evalCase.name} (${timing})`);
    } else {
      failed += 1;
      console.log(`FAIL ${evalCase.id}. ${evalCase.name} (${timing})`);
      console.log(`  Q: ${evalCase.question}`);
      for (const miss of misses) console.log(`  missed: ${miss}`);
      console.log(`  answer:\n${answer.replace(/^/gm, "    ")}`);
    }
  }

  store.close();
  console.log(`\n${cases.length - failed} of ${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

const RATE_LIMIT_WAIT_MS = 60_000;
const CALL_GAP_MS = 13_000;

function evalContext(store: Store, now: Date): EvalContext {
  const today = todayIn(now, TIMEZONE);
  const records = store.listRecords();
  const dayOf = (id: string) => {
    const record = records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error(`The sample has no record ${id}`);
    // "29 Oct": the weekday is left out so the check accepts either way of writing it.
    return formatDay(partsInZone(new Date(record.startedAt), TIMEZONE), today).split(" ").slice(1, 3).join(" ");
  };
  const first = records[records.length - 1]!;
  const empty = addDays(partsInZone(new Date(first.startedAt), TIMEZONE), -5);
  const recordsText = records
    .map((summary) => store.getRecord(summary.id)?.segments.map((segment) => segment.text).join("\n") ?? "")
    .join("\n");
  return { dayOf, emptyDayBeforeRange: `${empty.day} ${MONTHS[empty.month - 1]}`, recordsText };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
