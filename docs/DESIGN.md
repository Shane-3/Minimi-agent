# Design

A chat agent with one tool, `web_search`, and a dated memory of everything it is given or told. Priorities, in order: right, fast, pleasant.

## How it works

Every question runs the same path, with the model in the middle and code on both sides.

1. **Code finds the memory.** Date phrases ("last Tuesday", "3 November") become exact days in the user's timezone. Records on those days and keyword matches (SQLite FTS5) go into the prompt whole, with an index of everything stored. Follow-ups carry the chat's recent records; spare budget goes to the same chat group or meeting series, then recent records.
2. **One model, one tool.** History is answered only from the records, quoting the deciding line. Anything that can change (prices, versions, news) goes to `web_search`, which fans out one query set per entity to Tavily in parallel, then reads each vendor's own pricing or changelog page. Everything else is answered like a normal assistant.
3. **Code checks the answer.** After streaming, every figure, date, quote, sum and day count is checked against the records and sources; anything unsupported is underlined with a reason. The check never blocks the answer.
4. **The exchange is saved** with a timestamp, so "What did I ask you on 3 November?" is ordinary recall.

"Has it changed since Monday?" is answered per entity: changed (old → new, source, date), no announced change found since that date, or couldn't verify. Never a bare "unchanged".

## Why this way

- **Memory is code, not a tool.** The brief allows one tool, and every example question starts with recall. Code that always runs cannot forget to look.
- **Dates in code.** Models get weekdays wrong, so the resolver decides what "last Tuesday" means, and the prompt and imported records carry finished labels ("Mon 9 Nov"). The model has no weekday to work out.
- **Raw records are the only evidence.** Nothing model-written is stored as a fact; the check confirms each quote is really there, from that speaker.
- **Verification is deterministic.** An LLM judging an LLM shares its blind spots and doubles latency. Plain code can tell that "$15/user/mo" and "15 USD per seat" agree, that 14 Nov 2026 is not a Monday, and that 12 × $14 is $168.
- **Primary sources, read in code.** Search snippets are mostly third-party roundups, so the tool also reads each vendor's own pricing or changelog page. Still one tool, one key.
- **Honest wording.** A pricing page shows today's price, not last week's, so without a stored old value or a dated announcement the agent says "no announced change found".
- **Fast without cutting corners.** Cerebras won on measured latency: history answers start in about a second with one call and no search; re-checks take one parallel search-and-read step (about 9 to 12 s). Reasoning is higher once results are in, where mistakes cost most.
- **Real histories are messy.** The importer reads other tools' field names (`date`, `messages`, `from`, Unix times) and any dated record (articles, tasks, journals), and rejects a bad file whole, naming the record and field.

## Considered and rejected

| Option | Why not |
|---|---|
| A `recall` tool | Breaks the one-tool rule and lets the model skip memory |
| Planner, researcher and critic agents | Each handoff adds latency and can drop a date or figure; code does these jobs deterministically |
| Agent frameworks | Hide the loop this exercise is about |
| An LLM verifier or judge | Second model call site, same blind spots; the deterministic check caught what the model actually got wrong |
| Vector search | Questions are pinned by date and entity, and it needs a third key; the paraphrase gap is covered by filling the budget (see next week) |
| Headless browser or own crawler | Slow, blocked, heavy install, breaks `npm install` + `npm run dev` |
| Holding the answer until checks finish | Seconds of blank screen; marks arrive just after the text |
| Records-only answers | The first version answered general questions with "no record"; judges talk to it like a real user, so general questions now get real answers |

## Results

- **Evals:** 10 cases with real model calls and deterministic checks (`npm run eval`): summaries, decisions not made, missing dates and topics, timelines, re-checks, general questions. All 10 pass on current runs; the re-check cases depend on live search.
- **Larger histories:** two fictional histories (239 and 132 records), too big to read at once, with 38 graded questions: 34 fully right. The misses were relative day counts and one wrong week, mostly flagged by the check. "I can't find it" is never turned into "it didn't happen".
- **Unit tests:** 399, with the model and Tavily mocked.

## With another week

- **Hybrid retrieval:** embeddings beside keywords, for questions that share no words with their record, the one gap the large histories showed.
- **Pages that need a browser:** some pricing pages render prices with JavaScript or vary by country; a rendering step, with the user's region, would close that gap.
- **Watch, don't wait:** "tell me if any of these change", with scheduled re-checks of stored claims.
- **Memory over MCP,** so any assistant can use the same verified memory; a larger eval set from real, anonymised histories.
