# Design

<!-- Draft written before the build. Update the Evals line and anything that changed once the code exists. -->

## How it works

The agent keeps a dated record of everything it is given or told: meeting transcripts, notes, and its own past chats. Records are stored raw in SQLite with a full-text index.

Each message goes through four steps:

1. **Code finds the memory.** Date phrases ("Monday", "3 November") are resolved in the user's timezone, matching records are looked up, and they are placed in the prompt whole, next to an index of every record that exists.
2. **One model, one tool.** The model (Qwen on Cerebras, chosen for speed after comparing free providers) answers recall questions directly. For anything about the present it calls `web_search`, which fans out one query set per entity, runs them in parallel against Tavily, and returns ranked, dated evidence.
3. **Code checks the answer.** Every number, date and name must appear in a record or a source, or it is marked unverified.
4. **The exchange is saved** with a timestamp, so it can be recalled later.

"Has it changed since Monday?" is answered per claim: changed (old → new, source, date), no announced change found, or couldn't verify.

## Why this way

- **Memory is not a tool.** The brief allows one tool, and code that always runs cannot forget to look. The examples all start with recall, so recall must not depend on the model's choice.
- **Whole records, not fragments.** A summary built from retrieved snippets misses decisions. Meetings fit in the context window, so the model reads all of it.
- **Raw text is the only evidence.** Answers quote the record with the speaker. Nothing model-generated is stored about a record.
- **Dates in code.** Models are unreliable at weekday arithmetic; a library is not.
- **Honest wording.** A pricing page shows today's price, not last week's. Without a stored old value or a dated announcement, the agent says "no announced change found", not "unchanged".
- **Right before fast.** Speed comes from skipping search on recall questions, parallel searches, prompt caching and streaming, never from skipping a check.

## Considered and rejected

| Option | Why not |
|---|---|
| Vector database | Questions are pinned by date and entity; similarity can return the wrong day's meeting. Needs a third key |
| Multiple agents (planner, researcher, critic) | Each handoff adds latency and can drop a date or figure. Code does these jobs deterministically |
| Agent frameworks | Hide the loop that this exercise is about |
| A `recall` tool | Breaks the one-tool rule and lets the model skip memory |
| A per-claim ledger or topic tags written by a second model | Can lag or be wrong; the model reads the original instead. When all records fit in context they are all loaded, so tags aren't needed to find one |
| Scraping a search engine with a headless browser | Blocked, slow, against terms, heavy install |
| Our own crawler or self-hosted search | Out of proportion; breaks `npm install` + `npm run dev` |
| Postgres | Needs a running server |
| Blocking the answer until verification finishes | Seconds of blank screen; marks are attached after streaming instead |

## Assumptions

- Test history arrives as dated records; the format is documented and a sample is included.
- One user, no login. Memory is shared across threads.
- Relative dates mean the most recent past match, in the browser's timezone.
- If nothing is stored for a date or topic, the right answer is to say so.

## Evals

<!-- Fill in after running: N of 10 cases pass; note any that fail and why. -->
Ten cases in `/evals` cover summaries, decisions, missing records, same topic on two days, re-checks and injected instructions.

## With another week

- A verifier pass for misread context (billing period, plan tier), added only if evals show those errors.
- Hybrid keyword and embedding retrieval for histories too large to load whole, where a paraphrased question can currently miss its record.
- Headless rendering for pricing pages that load prices with JavaScript.
- Scheduled re-checks: "tell me if any of these change", which is where a memory product should go next.
- Per-source trust scores and a larger eval set built from real transcripts.
