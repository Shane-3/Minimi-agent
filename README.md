# minimi-agent

A chat agent with one tool, web search, and a dated memory of your meetings, chats, notes and past conversations with it. Ask what was decided last Tuesday, whether something you discussed on Monday is still true, or anything else.

- Answers about your history come only from your records, with the deciding line quoted.
- Anything that can change (prices, versions, news) is checked on the web, per item, with dated sources.
- Every figure, date and quote in an answer is checked in code; anything unsupported is underlined.

How it works and why: [docs/DESIGN.md](docs/DESIGN.md).

## Run it

You need Node 22 or later, and two free API keys.

```bash
git clone <this repo>
cd <the cloned folder>
npm install
cp .env.example .env      # then put both keys in .env
npm run dev
```

Open http://localhost:3000.

| Key | What it is for | Where to get it |
|---|---|---|
| `CEREBRAS_API_KEY` | The model (Qwen 3.8 27B, falling back to GPT-OSS 120B) | [cloud.cerebras.ai](https://cloud.cerebras.ai), free tier |
| `TAVILY_API_KEY` | Web search | [tavily.com](https://tavily.com), free tier |

Without the Tavily key, questions about your records still work and the app says web search is off. A missing key is named in the terminal and in the app. Memory is kept in `data/minimi.db`; delete it to start fresh.

## Try it

Click **Load sample history**, then ask the brief's questions:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

The small sample is dated relative to today, so these work on any day. **Upload JSON → Or load a ready-made sample** has two larger fictional histories (Kestrel Works and Monsoon Bikes), too big to read at once, with meetings, WhatsApp groups, emails, tasks, articles and journal entries.

Everything you ask is remembered too: tomorrow, "what did I ask you yesterday?" works.

## Bring your own data

**Upload JSON** in the header explains the format and has a downloadable example. The short version: a list of records, each with a date.

```json
{
  "records": [
    {
      "type": "meeting",
      "title": "Weekly planning",
      "timestamp": "2026-11-09T10:00:00+05:30",
      "turns": [{ "speaker": "Asha", "text": "Let's ship the beta on Friday." }]
    },
    { "type": "note", "timestamp": "2026-11-11T18:30:00+05:30", "content": "Try a referral programme." }
  ]
}
```

- **Only the date is required.** `type` is `meeting`, `chat` or `note`; any other kind (article, task, bookmark) is kept as a note titled with it.
- **Exports from other tools usually load as they are:**
  - `date`, `created_at` or Unix times for the timestamp;
  - `messages` with `from`/`author` and `body`/`text` for the turns;
  - `subject` for the title;
  - kinds like "email", "WhatsApp" or "call";
  - a chat log `[{ timestamp, role, content }]`.
- A timestamp without a timezone is read in yours, and the import says so.
- **Uploads are all or nothing.** A file with a problem imports nothing, and the message names the record and field to fix. Duplicates are skipped, so uploading twice is safe.

Full format: [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md#3-import-format).

## Commands

```bash
npm run dev         # app and API on one port (3000, or PORT in .env)
npm test            # unit tests, model and search mocked
npm run eval        # 10 eval cases with real model calls (uses your keys)
npm run typecheck
```

`npm run eval -- 8 9` runs chosen cases; `--show` prints every answer.

## Layout

```
server/agent/    the agent loop, prompt, web_search, grounding check
server/memory/   SQLite store, importer, date resolution, retrieval
server/routes/   chat (streamed) and import routes
web/             React UI
shared/          types and limits used by both sides
data/            the small sample (and your local database)
samples/         the two larger fictional samples
evals/           eval cases and runner
docs/            DESIGN, ARCHITECTURE, REQUIREMENTS, FRONTEND
```

## Notes

- **Free tiers have limits.** Cerebras allows a number of requests and tokens a minute and a day. If one model hits its limit, the answer moves to the next; if all do, the app says so and offers Retry. Tavily's free plan has a monthly credit allowance.
- **Everything runs on your machine** except the model and search calls. Nothing is sent anywhere else.
- All sample data is fictional. The one sample answer with real prices is a real run of this agent, made on 13 Nov 2026 and placed on 3 November so "What did I ask you on 3 November?" has something to recall.
