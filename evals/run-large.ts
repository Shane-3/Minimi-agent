// npx tsx evals/run-large.ts [--sample 2] [question numbers...]
// Asks the questions in data/large-sample-questions.md (or, with --sample 2,
// data/large-sample-2-questions.md) against that large fictional sample, with real model calls, through the same retrieval,
// prompt and loop the chat route uses. Prints each answer next to the
// expected one for a person to grade: the answers are free text, and an LLM
// judge would be a second model call site (AGENTS.md rule 3).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAnswer } from "../server/agent/grounding.ts";
import { AgentError, createAgent, type Agent } from "../server/agent/loop.ts";
import { buildPrompt } from "../server/agent/prompt.ts";
import { createWebSearch } from "../server/agent/search.ts";
import { importInto, parseImportText, prepareImport } from "../server/memory/importer.ts";
import { retrieve } from "../server/memory/retrieve.ts";
import { Store } from "../server/memory/store.ts";
import { evalEnv, TIMEZONE } from "./setup.ts";

const args = process.argv.slice(2);
const sampleAt = args.indexOf("--sample");
const suffix = sampleAt >= 0 && args[sampleAt + 1] === "2" ? "-2" : "";
if (sampleAt >= 0) args.splice(sampleAt, 2);
const SAMPLE = fileURLToPath(new URL(`../data/large-sample${suffix}.json`, import.meta.url));
const QUESTIONS = fileURLToPath(new URL(`../data/large-sample${suffix}-questions.md`, import.meta.url));
/** Spacing between questions: large prompts count heavily against the free tier's per-minute token limit. */
const CALL_GAP_MS = 20_000;
const RATE_LIMIT_WAIT_MS = 60_000;

/** The rows of the questions table: [question, expected answer]. */
function readQuestions(): [string, string][] {
  return readFileSync(QUESTIONS, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Question"))
    .map((line) => {
      const [question, expected] = line.slice(2, -2).split(" | ");
      return [question!, expected!];
    });
}

async function ask(agent: Agent, store: Store, question: string, searchAvailable: boolean) {
  const asked = new Date();
  const retrieval = retrieve(store, question, { timezone: TIMEZONE, now: asked });
  const prompt = buildPrompt({ retrieval, question, history: [], timezone: TIMEZONE, now: asked, searchAvailable });
  const started = performance.now();
  const result = await agent.answer({ ...prompt, onText: () => {} });
  const checks = checkAnswer({ answer: result.text, question, retrieval, history: [], evidence: result.evidence, timezone: TIMEZONE, now: asked });
  return { result, retrieval, seconds: (performance.now() - started) / 1000, unverified: checks.filter((check) => !check.verified) };
}

async function main(): Promise<void> {
  const env = evalEnv();
  const webSearch = env.tavilyKey === null ? undefined : createWebSearch({ apiKey: env.tavilyKey });
  const agent = createAgent({ apiKey: env.cerebrasKey, models: env.models, ...(webSearch ? { webSearch } : {}) });
  const store = new Store(":memory:");
  const imported = importInto(store, prepareImport(parseImportText(readFileSync(SAMPLE, "utf8")), TIMEZONE), TIMEZONE);
  console.log(`Loaded ${imported.imported} records. Models ${env.models.join(", ")}.\n`);

  const only = new Set(args.map(Number));
  const questions = readQuestions()
    .map((row, index) => ({ id: index + 1, question: row[0], expected: row[1] }))
    .filter(({ id }) => only.size === 0 || only.has(id));

  for (const [index, { id, question, expected }] of questions.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, CALL_GAP_MS));
    let answer: Awaited<ReturnType<typeof ask>>;
    try {
      try {
        answer = await ask(agent, store, question, webSearch !== undefined);
      } catch (error) {
        if (!(error instanceof AgentError && error.code === "rate_limited")) throw error;
        console.log(`${id}. rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000}s and asking again`);
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
        answer = await ask(agent, store, question, webSearch !== undefined);
      }
    } catch (error) {
      if (error instanceof AgentError && error.code === "quota_exhausted") {
        console.log(`STOP at ${id}: ${error.message}`);
        break;
      }
      const cause = error instanceof Error && error.cause !== undefined ? ` (${String(error.cause)})` : "";
      console.log(`=== ${id}. ${question}\nFAILED: ${String(error)}${cause}\n`);
      continue;
    }
    const { result, retrieval, seconds, unverified } = answer;
    console.log(`=== ${id}. ${question}`);
    console.log(
      `${result.model}, ${seconds.toFixed(1)}s, ${retrieval.loaded.length} records loaded${retrieval.allLoaded ? " (all)" : ""}, ${result.searches} searches`,
    );
    console.log(`EXPECTED: ${expected}`);
    console.log(`ANSWER:\n${result.text.replace(/^/gm, "  ")}`);
    for (const check of unverified) console.log(`  unverified ${check.kind}: ${JSON.stringify(check.text)} (${check.reason ?? ""})`);
    console.log("");
  }
  store.close();
}

await main();
