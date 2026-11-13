# AGENTS.md

Instructions for any AI coding tool working in this repo. Read `REQUIREMENTS.md`, `ARCHITECTURE.md` and `FRONTEND.md` first. If they conflict with this file, stop and ask.

## What this project is

A chat agent with dated memory and one tool, `web_search`. It answers from stored records without inventing anything and checks the web only for questions about the present. Correct beats fast beats pretty.

## Commands

```
npm install
npm run dev        # Express + Vite on one port
npm test           # Vitest unit tests
npm run eval       # eval cases against the sample history
npm run typecheck
```

## Rules that must not be broken

1. **One tool.** The model is given `web_search` and nothing else. Memory lookup is code that runs before the model call. Do not add tools.
2. **One agent.** No planner, critic or sub-agents. No agent frameworks (LangChain, LangGraph, Vercel AI SDK). The loop in `server/agent/loop.ts` is written by hand.
3. **Raw records are the truth.** Answers quote stored segments. Nothing model-generated is stored as a fact about a record. There is one model call site, `server/agent/loop.ts`; do not add another.
4. **Never invent.** No sample prices, quotes or dates made up to look plausible, in code, prompts, tests or sample data. Sample meeting transcripts are fictional and labelled as samples; any sample that states a real product's price must come from a real run of the agent.
5. **Two keys only.** `CEREBRAS_API_KEY` and `TAVILY_API_KEY`. Do not add a dependency that needs another key or a running service.
6. **`npm install` then `npm run dev` must work** on a clean clone with Node 22. No build step, no global installs, no Docker.
7. **No copied branding.** Do not draw or imitate Minimi's cat mascot or logo. Use the original mark in `web/assets`.
8. **Out-of-scope list** in `REQUIREMENTS.md` §8 stays out unless the author says otherwise.

## Code conventions

- TypeScript, `strict` on. No `any` without a comment saying why.
- Small files with one job. `server/memory/store.ts` is the only file that touches SQLite. `server/agent/loop.ts` is the only file that calls the model (Cerebras). `server/agent/search.ts` is the only file that calls Tavily.
- Shared types (`MemoryRecord`, `Segment`, `Evidence`, `Check`, SSE events) live in `shared/types.ts` and are used by both server and web. The record type is `MemoryRecord`, not `Record`, so it does not hide TypeScript's built-in `Record<K, V>`.
- Validate everything that crosses a boundary with zod: env, import files, request bodies, tool inputs.
- Every external call has a timeout and a typed error. No unhandled promise rejections.
- Comments explain why, not what. The author must be able to explain every line, so prefer plain code over clever code.
- Check current SDK and API docs (Cerebras, reached through the OpenAI SDK `openai`; Tavily) before writing calls; do not rely on remembered parameter names or model ids. Model ids come from env with defaults set in one place.
- No secrets, database files or `.env` in git.

## Build order

Build in this order. Do not start a step until the previous one passes its check.

| # | Step | Done when |
|---|---|---|
| 1 | Scaffold: Express + Vite middleware, env check, `.env.example`, `.nvmrc`, `engines` | `npm run dev` serves a page; a missing key prints a clear message |
| 2 | Store and importer: schema, FTS5, zod validation, duplicate detection, relative-date sample | Unit tests pass for valid, invalid, duplicate and timezone-less files |
| 3 | Date resolver | Unit tests pass for weekday names, "last Tuesday", absolute dates, "two weeks ago", across a timezone boundary |
| 4 | Retrieval and context budget | Given a question and the sample, returns the right records; over-budget record is marked partial |
| 5 | Agent loop without search: prompt, streaming, save turn | Eval cases 1 to 7 pass |
| 6 | `web_search` tool: fan-out, parallel calls, timeouts, dedupe, ranking, dates | Tool unit tests pass with mocked Tavily, including failure of one query |
| 7 | Agent loop with search, per-claim change report | Eval cases 8 and 9 pass |
| 8 | Grounding check | Unit tests: matching formats ("$15/user/mo" vs "15 USD per seat"), unmatched figure flagged, check failure does not block |
| 9 | UI: welcome card, chat, status, chips, sources, check marks, records panel | Every component and state in `FRONTEND.md` works by hand |
| 10 | Failure cases | Every row in `REQUIREMENTS.md` §5 reproduced and handled |
| 11 | `DESIGN.md` updated to match what was built; README with setup | A clean clone runs with only the two keys |

## Testing

- Unit tests sit next to the code as `*.test.ts`.
- Mock the model API and Tavily in unit tests. Only `npm run eval` makes real calls.
- A failing test is fixed by fixing the code. Do not weaken or delete a test to make it pass; if a test is wrong, say so and explain.

## Git

- Small commits, one change each, imperative subject line.
- Do not commit broken states to `main`.

## When unsure

Ask the author. Do not guess at requirements, widen scope, or add a library to save a few lines.
