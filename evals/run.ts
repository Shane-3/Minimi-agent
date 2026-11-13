// npm run eval [--reasoning none|low|medium|high] [--show] [case numbers...]
// Runs the eval cases against the sample history with real model calls,
// through the same retrieval, prompt and loop the chat route uses.
// --reasoning overrides the configured per-model setting, for tuning it.
// --show prints every answer, not only the ones that fail.
import { AgentError, createAgent } from "../server/agent/loop.ts";
import { createWebSearch } from "../server/agent/search.ts";
import type { ReasoningEffort } from "../server/config.ts";
import { evalCases } from "./cases.ts";
import { askCase, evalEnv, sampleHistory, TIMEZONE, type CaseAnswer } from "./setup.ts";

const RATE_LIMIT_WAIT_MS = 60_000;
/** The free tier allows 5 requests a minute per model; spacing the calls keeps a run of seven inside that. */
const CALL_GAP_MS = 13_000;

async function main(): Promise<void> {
  const env = evalEnv();
  const { reasoning, show, caseIds } = parseArgs(process.argv.slice(2));
  const webSearch = env.tavilyKey === null ? undefined : createWebSearch({ apiKey: env.tavilyKey });
  const searchAvailable = webSearch !== undefined;
  const agent = createAgent({ apiKey: env.cerebrasKey, models: env.models, reasoning, ...(webSearch ? { webSearch } : {}) });
  const { store, context, today } = sampleHistory(new Date());

  const only = new Set(caseIds);
  const cases = evalCases(context).filter((evalCase) => only.size === 0 || only.has(evalCase.id));

  const effort = reasoning ?? "as configured";
  console.log(`Models ${env.models.join(", ")}, reasoning ${effort}, sample loaded as of ${today} (${TIMEZONE})\n`);
  let failed = 0;
  for (const [index, evalCase] of cases.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, CALL_GAP_MS));

    let result: CaseAnswer;
    try {
      try {
        result = await askCase(agent, store, evalCase, searchAvailable);
      } catch (error) {
        // Out of requests for the day: every later case would fail the same
        // way and say nothing about the answers, so stop here.
        if (error instanceof AgentError && error.code === "quota_exhausted") {
          console.log(`STOP at case ${evalCase.id}: ${error.message}`);
          store.close();
          process.exit(1);
        }
        // Every model at its per-minute limit says nothing about the answers
        // either, so wait out the minute and ask again once. Timings are of the second try.
        if (!(error instanceof AgentError && error.code === "rate_limited")) throw error;
        console.log(`     ${evalCase.id}. rate limited; waiting ${RATE_LIMIT_WAIT_MS / 1000}s and asking again`);
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_WAIT_MS));
        result = await askCase(agent, store, evalCase, searchAvailable);
      }
    } catch (error) {
      failed += 1;
      // The cause is the SDK's own error (status and API message), which the
      // user-facing message hides; whoever runs the evals needs it.
      const cause = error instanceof Error && error.cause !== undefined ? `\n  cause: ${String(error.cause)}` : "";
      console.log(`FAIL ${evalCase.id}. ${evalCase.name}: the model call failed\n  ${String(error)}${cause}\n`);
      continue;
    }

    // The pool may move to another model, so each result says which one
    // answered: a weaker model failing a case reads differently.
    const first = result.firstText === null ? "-" : `${result.firstText.toFixed(1)}s`;
    const searched = result.searches > 0 ? `, ${result.searches} search${result.searches === 1 ? "" : "es"}` : "";
    const timing = `${result.model}, first text ${first}, done ${result.total.toFixed(1)}s${searched}`;
    if (result.misses.length === 0) {
      console.log(`PASS ${evalCase.id}. ${evalCase.name} (${timing})`);
      if (show) console.log(`  answer:
${result.answer.replace(/^/gm, "    ")}`);
    } else {
      failed += 1;
      console.log(`FAIL ${evalCase.id}. ${evalCase.name} (${timing})`);
      console.log(`  Q: ${evalCase.question}`);
      for (const miss of result.misses) console.log(`  missed: ${miss}`);
      console.log(`  answer:\n${result.answer.replace(/^/gm, "    ")}`);
    }
  }

  store.close();
  console.log(`\n${cases.length - failed} of ${cases.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];

function parseArgs(args: string[]): { reasoning: ReasoningEffort | undefined; show: boolean; caseIds: number[] } {
  let reasoning: ReasoningEffort | undefined;
  let show = false;
  const caseIds: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--show") {
      show = true;
    } else if (args[index] === "--reasoning") {
      reasoning = EFFORTS.find((effort) => effort === args[index + 1]);
      if (reasoning === undefined) throw new Error(`--reasoning takes one of ${EFFORTS.join(", ")}`);
      index += 1;
    } else {
      caseIds.push(Number(args[index]));
    }
  }
  return { reasoning, show, caseIds };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
