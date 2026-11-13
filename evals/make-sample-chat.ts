// npx tsx evals/make-sample-chat.ts <output.json>
// How the sample's 3 November chat (sample-postgres-prices-chat) was made:
// one real run of the agent, with live web search, whose question and answer
// were copied word for word into data/sample.json. AGENTS.md rule 4 requires
// any sample that states a real product's price to come from a real run; this
// script is that run, kept so it can be repeated. The prompt's clock is set to
// Tue 3 Nov so the answer dates itself to the day the record sits on; the
// search results are whatever the web shows when it is run.
import { writeFileSync } from "node:fs";
import { createAgent } from "../server/agent/loop.ts";
import { buildPrompt } from "../server/agent/prompt.ts";
import { createWebSearch } from "../server/agent/search.ts";
import { retrieve } from "../server/memory/retrieve.ts";
import { evalEnv, sampleHistory, TIMEZONE } from "./setup.ts";

const env = evalEnv();
const now = new Date("2026-11-03T11:00:00Z"); // Tue 3 Nov, 16:30 in Kolkata
const question = "What do Neon, Supabase and Amazon RDS currently charge for a small managed Postgres database?";
const { store } = sampleHistory(now);
const webSearch = createWebSearch({ apiKey: env.tavilyKey ?? "" });
const agent = createAgent({ apiKey: env.cerebrasKey, models: env.models, webSearch });
const retrieval = retrieve(store, question, { timezone: TIMEZONE, now });
const prompt = buildPrompt({ retrieval, question, history: [], timezone: TIMEZONE, now, searchAvailable: true });
const result = await agent.answer({ ...prompt, onText: () => {} });
console.log(`model ${result.model}, searches ${result.searches}, stop ${result.stopReason}\n`);
console.log(result.text);
writeFileSync(process.argv[2]!, JSON.stringify({ question, answer: result.text, model: result.model, searches: result.searches, ranAt: new Date().toISOString() }, null, 2));
store.close();
