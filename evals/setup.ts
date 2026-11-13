// What the eval runner and the speed comparison share: the key, the sample
// history as loaded today, and asking one case through the real pipeline.
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import type { Agent } from "../server/agent/loop.ts";
import { buildPrompt } from "../server/agent/prompt.ts";
import { SAMPLE_PATH } from "../server/config.ts";
import { readEnv, type Env } from "../server/env.ts";
import { addDays, formatDay, partsInZone, todayIn } from "../server/memory/dates.ts";
import { loadSampleInto, prepareSample } from "../server/memory/importer.ts";
import { retrieve } from "../server/memory/retrieve.ts";
import { Store } from "../server/memory/store.ts";
import type { EvalCase, EvalContext } from "./cases.ts";

export const TIMEZONE = "Asia/Kolkata";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The environment, with a Cerebras key; exits with a message when there is none. */
export function evalEnv(): Env & { cerebrasKey: string } {
  dotenv.config({ override: true, quiet: true });
  const env = readEnv(process.env);
  if (env.cerebrasKey === null) {
    console.error("Add CEREBRAS_API_KEY to .env to run the evals. They make real model calls.");
    process.exit(1);
  }
  return { ...env, cerebrasKey: env.cerebrasKey };
}

/** An in-memory store holding the sample as it would be loaded today, and what the checks need to know about it. */
export function sampleHistory(now: Date): { store: Store; context: EvalContext; today: string } {
  const store = new Store(":memory:");
  const sample = JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as unknown;
  loadSampleInto(store, prepareSample(sample, TIMEZONE, now), TIMEZONE);

  const today = todayIn(now, TIMEZONE);
  const records = store.listRecords();
  const dayOf = (id: string) => {
    const record = records.find((candidate) => candidate.id === id);
    if (record === undefined) throw new Error(`The sample has no record ${id}`);
    // "29 Oct": the weekday is left out so the check accepts either way of writing it.
    return formatDay(partsInZone(new Date(record.startedAt), TIMEZONE), today).split(" ").slice(1, 3).join(" ");
  };
  // listRecords is newest first.
  const first = records[records.length - 1]!;
  const empty = addDays(partsInZone(new Date(first.startedAt), TIMEZONE), -5);
  const recordsText = records
    .map((summary) => store.getRecord(summary.id)?.segments.map((segment) => segment.text).join("\n") ?? "")
    .join("\n");

  const context: EvalContext = {
    dayOf,
    emptyDayBeforeRange: `${empty.day} ${MONTHS[empty.month - 1]}`,
    rangeFrom: dayOf(first.id),
    rangeTo: dayOf(records[0]!.id),
    recordsText,
  };
  return { store, context, today: formatDay(today, today) };
}

export interface CaseAnswer {
  answer: string;
  /** The model that answered, as the API reports it. */
  model: string;
  /** Seconds until the first piece of answer text, or null if none came. */
  firstText: number | null;
  total: number;
  /** Names of the checks the answer missed; empty when it passed. */
  misses: string[];
}

/** Asks one case through the same retrieval, prompt and loop the chat route uses. Throws what the agent throws. */
export async function askCase(agent: Agent, store: Store, evalCase: EvalCase): Promise<CaseAnswer> {
  const asked = new Date();
  const retrieval = retrieve(store, evalCase.question, { timezone: TIMEZONE, now: asked });
  const prompt = buildPrompt({ retrieval, question: evalCase.question, history: [], timezone: TIMEZONE, now: asked });

  const started = performance.now();
  let firstText: number | null = null;
  const result = await agent.answer({
    ...prompt,
    onText: () => {
      firstText ??= performance.now();
    },
  });
  const seconds = (ms: number) => (ms - started) / 1000;
  return {
    answer: result.text,
    model: result.model,
    firstText: firstText === null ? null : seconds(firstText),
    total: seconds(performance.now()),
    misses: evalCase.checks.filter((check) => !check.pass(result.text)).map((check) => check.name),
  };
}
