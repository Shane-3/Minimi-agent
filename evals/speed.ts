// npx tsx evals/speed.ts [--levels LOW,MEDIUM] [model ...]
// Compares free-tier models for speed and correctness on a few eval cases,
// at the given thinking levels (default LOW and MEDIUM; Gemma takes only
// MINIMAL or HIGH). Each model is asked on its own (a pool
// of one), so the timings are that model's, not the pool's.
//
// Calls go round the models in turn, so each model sees a call only every
// few seconds and stays inside its per-minute limit.
import { DEFAULT_MODELS } from "../server/config.ts";
import { AgentError, createAgent, type ThinkingLevelName } from "../server/agent/loop.ts";
import { evalCases } from "./cases.ts";
import { askCase, evalEnv, sampleHistory } from "./setup.ts";

/** Summary (the hardest), a decision with its quote, and a date with no record. */
const CASES = [1, 2, 6];
const LEVEL_NAMES: ThinkingLevelName[] = ["MINIMAL", "LOW", "MEDIUM", "HIGH"];

function parseArgs(args: string[]): { levels: ThinkingLevelName[]; models: string[] } {
  let levels: ThinkingLevelName[] = ["LOW", "MEDIUM"];
  const models: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--levels") {
      levels = (args[index + 1] ?? "").split(",").map((level) => {
        const name = level.trim().toUpperCase() as ThinkingLevelName;
        if (!LEVEL_NAMES.includes(name)) throw new Error(`Unknown thinking level "${level}"`);
        return name;
      });
      index += 1;
    } else {
      models.push(args[index]!);
    }
  }
  return { levels, models: models.length > 0 ? models : DEFAULT_MODELS };
}

interface Row {
  model: string;
  level: ThinkingLevelName;
  caseId: number;
  outcome: string;
  firstText: number | null;
  total: number | null;
}

async function main(): Promise<void> {
  const env = evalEnv();
  const { levels: LEVELS, models } = parseArgs(process.argv.slice(2));
  const { store, context } = sampleHistory(new Date());
  const cases = evalCases(context).filter((evalCase) => CASES.includes(evalCase.id));

  // One agent per model and level, so the pool never moves a call elsewhere.
  const agents = new Map(
    models.flatMap((model) =>
      LEVELS.map((level) => [`${model} ${level}`, createAgent({ apiKey: env.geminiKey, models: [model], thinkingLevel: level })]),
    ),
  );
  // Models that ran out of requests today are skipped for the rest of the run.
  const outOfQuota = new Set<string>();

  const rows: Row[] = [];
  for (const evalCase of cases) {
    for (const level of LEVELS) {
      for (const model of models) {
        if (outOfQuota.has(model)) continue;
        const row: Row = { model, level, caseId: evalCase.id, outcome: "", firstText: null, total: null };
        try {
          const result = await askCase(agents.get(`${model} ${level}`)!, store, evalCase);
          row.outcome = result.misses.length === 0 ? "pass" : `FAIL: ${result.misses.join("; ")}`;
          row.firstText = result.firstText;
          row.total = result.total;
        } catch (error) {
          if (error instanceof AgentError && error.code === "quota_exhausted") outOfQuota.add(model);
          row.outcome = error instanceof AgentError ? `error: ${error.code}` : `error: ${String(error)}`;
        }
        rows.push(row);
        console.log(format(row));
      }
    }
  }
  store.close();

  console.log("\nBy model and level (median first text over the answers that came back):");
  for (const model of models) {
    for (const level of LEVELS) {
      const mine = rows.filter((row) => row.model === model && row.level === level);
      if (mine.length === 0) continue;
      const passes = mine.filter((row) => row.outcome === "pass").length;
      const times = mine.flatMap((row) => (row.firstText === null ? [] : [row.firstText])).sort((a, b) => a - b);
      const median = times.length === 0 ? "-" : `${times[Math.floor(times.length / 2)]!.toFixed(1)}s`;
      console.log(`  ${model.padEnd(24)} ${level.padEnd(6)} ${passes}/${mine.length} passed, first text ${median}`);
    }
  }
}

function format(row: Row): string {
  const first = row.firstText === null ? "-" : `${row.firstText.toFixed(1)}s`;
  const total = row.total === null ? "-" : `${row.total.toFixed(1)}s`;
  return `${row.model.padEnd(24)} ${row.level.padEnd(6)} case ${row.caseId}  first ${first.padStart(6)}  total ${total.padStart(6)}  ${row.outcome}`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
