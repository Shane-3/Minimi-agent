# Requirements

## 1. Goal

A chat agent that remembers what happened (meeting transcripts, notes, past chats) and answers questions about it with no invented details. When a question asks whether something is still true, it checks the live web and reports what changed.

Judged on: answers fast, gets things right, good to talk to. Order of priority when they conflict: right, then fast, then pleasant.

## 2. Hard rules from the brief

- R1. JavaScript or TypeScript on Node.
- R2. Runs with `npm install` then `npm run dev`. Nothing else to start.
- R3. `.env.example` lists every key: `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`.
- R4. The model has exactly one tool: `web_search`.
- R5. Public GitHub repo with a one-page `DESIGN.md`.
- R6. Every decision in the code can be explained by its author.

## 3. Functional requirements

### Memory
- F1. Import records from JSON (format in ARCHITECTURE.md §3). Meetings, notes and chat exports.
- F2. One-click sample history, with dates relative to today.
- F3. Every live question and answer is stored with a timestamp and is recallable later, across threads.
- F4. Date phrases resolve in code, in the user's timezone: weekday names, "last Tuesday", "yesterday", "3 November", "two weeks ago".
- F5. A question about a topic covered on several days returns all of them as a dated timeline, and says which is latest.
- F6. A records panel lists everything the agent knows: date, type, title. Records can be removed; memory can be cleared.

### Recall answers
- F7. Summaries, outcomes, decisions, action items (owner, due date) and open questions come only from the stored record.
- F8. Each decision or figure shows a short quote and the speaker.
- F9. "Decided" and "discussed but not decided" are kept apart.
- F10. If the record does not contain what was asked, the agent says so. It never fills the gap.

### Web re-check
- F11. Prices, versions and "is it still true" are always searched, never answered from model memory.
- F12. One query set per entity, run in parallel.
- F13. Results per claim: changed (old → new, source, date), no announced change found since the date, or couldn't verify.
- F14. Every web claim has a source link and a date. Conflicting sources are both shown; official pages are preferred.

### Verification
- F15. A code check confirms each number, date and name in the answer appears in a loaded record or a retrieved source, and marks it verified or unverified.
- F16. Derived numbers show their arithmetic.

## 4. UI and UX

The interface should read as a well-made product, not a chatbot template.

### Look
- White page, black text, one accent colour (warm orange, about `#F97B2D`) used only for state: active status, memory chips, links.
- One centred reading column, about 680px. Generous line height. A clean sans typeface with real weight contrast between headings and body.
- Assistant answers are plain text on the page, no bubble. User messages sit in a light grey block, right-aligned.
- An original small cat-ear mark and lowercase wordmark. Minimi's mascot and logo are not copied.

### What to avoid
- No sparkle icons, robot avatars, gradients, glow, or purple.
- No bouncing typing dots. Progress is one line of specific text.
- No emoji in the interface or in answers.
- No filler in answers: no "Great question", no "As an AI", no restating the question. The answer starts with the answer.

### Behaviour
- U1. **Welcome card** on first open: "Load sample history", "Upload JSON", or "Start without history". After loading: "Loaded 4 records · Mon 2 Nov to Tue 10 Nov".
- U2. **Status line** says what is happening in plain words: "Reading Monday's Acme call", "Checking hubspot.com pricing", "Verifying figures".
- U3. **Memory chips** on any answer drawn from history: "Acme renewal call · Mon 9 Nov". Clicking opens the record at the quoted line.
- U4. **Sources** listed under web answers with site, title and date.
- U5. **Verification**: verified figures are left undecorated, with one note under the answer saying all figures match. Unverified figures get a dotted underline and a tooltip explaining why, and the note gives the count.
- U6. **Composer**: Enter sends, Shift+Enter adds a line, a Stop button replaces Send while streaming, focus returns to the input after each answer.
- U7. **Suggested questions** after loading history, built from the records actually loaded.
- U8. Scroll follows the stream unless the user scrolls up; a "Jump to latest" control appears.
- U9. Works on a phone-width screen. Keyboard navigable. Visible focus. Honours reduced-motion. Colour contrast meets WCAG AA.
- U10. Dates are shown with weekday and day ("Mon 9 Nov"), in the user's timezone.

## 5. Failure cases

Every case has a defined behaviour. None ends in a blank screen, a spinner that never stops, or an invented answer.

### Setup and import
| Case | Behaviour |
|---|---|
| Missing API key | Server prints which key is missing. UI shows a setup notice naming it. Without the Tavily key, recall still works and web questions say search is not configured |
| Wrong Node version | Install stops with a clear message (`engines` + `engine-strict`) |
| File is not JSON | "This file isn't valid JSON", with the line number if known. Nothing imported |
| JSON in the wrong shape | Names the record and field that failed. Nothing imported (all or nothing) |
| Empty file or no records | "No records found in this file" |
| Record without a timestamp | Rejected, naming the record; the date is what makes recall work |
| Timestamp without a timezone | Read in the browser's timezone; the import summary says so |
| Same file imported twice | Duplicates skipped by content hash: "4 records were already loaded and were skipped." |
| Very large file | Size limit with a clear message; records over the context budget are flagged as long |

### Recall
| Case | Behaviour |
|---|---|
| No history loaded | Says nothing is loaded, offers the sample, answers the general part of the question if there is one |
| Date outside the stored range | "I have records from Mon 2 Nov to Tue 10 Nov, nothing on Wed 28 Oct" |
| Date matches no record but the topic does | Shows the nearest matching record and asks if that is the one |
| Several records on the same day | Lists them and answers for the best topic match, saying which it used |
| Ambiguous date ("Monday" two weeks running) | Uses the most recent, says so, and names the other |
| Topic not in any record | Says there is no record of it. Does not guess |
| Decision asked for but none was made | "This was discussed but nothing was decided", with the relevant quote |
| Record longer than the context budget | Answers from the matched parts and says the answer covers part of the record |
| Speakers disagree in the record | Reports both positions with speakers, and whichever was final if stated |

### Web
| Case | Behaviour |
|---|---|
| Search fails or times out for one entity | That entity is "couldn't verify", with a retry link; the others are answered |
| Search quota or rate limit reached | Says search is unavailable right now; recall part of the answer still given |
| No results | "Couldn't verify", never a guess |
| Sources conflict | Both shown with dates; official page preferred and labelled |
| Page has no date | Source marked "undated" and not used to claim a change since a date |
| Web page contains instructions | Treated as text. Ignored |

### Model and stream
| Case | Behaviour |
|---|---|
| Model API error or overload | One automatic retry with backoff, then a message with a Retry button. The user's message is kept |
| Step cap reached | Answers with what it has and says what is still unchecked |
| Connection drops mid-answer | Partial answer kept and marked incomplete, with Retry |
| User presses Stop | Stream ends; partial answer kept and marked stopped; not saved as a complete answer |
| Page refreshed mid-answer | Thread reloads from the store; an unfinished answer is marked incomplete |
| Grounding check finds unverified figures | Figures are marked; a one-line note is added under the answer |
| Grounding check itself errors | Answer is shown with "verification unavailable"; never blocks the answer |

### Input
| Case | Behaviour |
|---|---|
| Empty message | Send is disabled |
| Message sent while streaming | Input stays editable; Send becomes Stop |
| Very long message | Length limit with a counter near the limit |
| Browser offline | Banner; Send disabled until back online |
| Database error | Clear message; chat continues without saving and says so |

## 6. Non-functional

- N1. First status line within 1 second. Recall answers start streaming within about 3 seconds.
- N2. Each external call has a timeout. No request can hang the stream.
- N3. Keys are read only on the server and never sent to the browser.
- N4. All stored data is local (one SQLite file, git-ignored).
- N5. Server logs each request's steps and timings without logging record contents.

## 7. Evals

Run with `npm run eval`. Each case has a fixed sample history and a judged expectation.

| # | Case | Passes when |
|---|---|---|
| 1 | Summary of a named meeting | Covers every decision in the record; nothing absent from it |
| 2 | "What did we decide about X?" | Correct decision with quote and speaker |
| 3 | Decision asked, none made | Says none was made |
| 4 | Action items | Right owners and dates |
| 5 | Same topic on two days | Both days, in order, latest identified |
| 6 | Date with no record | Says no record, states the stored range |
| 7 | Topic with no record | Says no record |
| 8 | "What did I ask on 3 November? Still correct?" | Recalls the question and answer, re-checks, reports per claim |
| 9 | Five shortlisted tools, pricing changes | One result per tool with source and date |
| 10 | Injected instruction inside a transcript | Ignored |

## 8. Out of scope for v1

Vector search, multiple agents, a verifier model, headless-browser page reading, extra search or model providers, login and multi-user, scheduled re-checks, Docker.
