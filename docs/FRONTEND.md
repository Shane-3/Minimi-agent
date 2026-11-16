# Frontend

Build spec for the React UI. Requirements live in `REQUIREMENTS.md` §4 and §5; this file says how to build them.

## 1. Stack

- React + TypeScript, served by Vite.
- Plain CSS with custom properties and CSS modules. No Tailwind, no component library.
- State: one `useReducer` per screen. No state library.
- `react-markdown` for answers (raw HTML disabled; links open in a new tab with `rel="noopener noreferrer"`).
- Inter, self-hosted through `@fontsource-variable/inter` so nothing loads from a third party.
- Light theme only in v1.

## 2. Design tokens

```css
:root {
  --bg: #ffffff;
  --surface: #f6f6f4;        /* user message, cards */
  --text: #111111;
  --text-muted: #6b6b6b;
  --border: #e6e6e3;
  --accent: #f97b2d;         /* state only: status, chips, links */
  --accent-soft: #fff1e7;    /* chip background */
  --danger: #b42318;
  --danger-soft: #fef3f2;
  --radius: 10px;
  --radius-pill: 999px;
  --col: 680px;              /* reading column */
  --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px; --space-12: 48px;
}
```

| Text | Size / line height | Weight |
|---|---|---|
| Page heading | 28 / 34 | 700 |
| Section heading in answers | 17 / 26 | 600 |
| Body | 16 / 26 | 400 |
| Meta, chips, status | 13 / 18 | 500 |

Orange text on white is used at 13px medium or larger only for interactive items; body links are underlined so colour is never the only signal. Check contrast for every pairing before finishing.

## 3. Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ◣ minimi-agent          Upload JSON   Records (4)   New chat │  header, 56px, bottom border
├──────────────────────────────────────────────────────────────┤
│                                                              │
│               ┌──────── 680px column ────────┐               │
│               │ messages                      │               │
│               │                               │               │
│               └───────────────────────────────┘               │
│               ┌───────────────────────────────┐               │
│               │ composer (sticky bottom)      │               │
│               └───────────────────────────────┘               │
└──────────────────────────────────────────────────────────────┘
```

- Records panel slides in from the right (360px) over the page; on screens under 720px it is full width.
- Under 720px the column has 16px side padding and the header keeps only the mark, Records and New chat icons with labels for screen readers.

## 4. Screens and components

### Welcome card (no records, no messages)
- Heading: "What do you want to remember?"
- One line: "Load your records and ask about any meeting, decision or date."
- Buttons: **Load sample history** (primary, black), **Upload JSON** (secondary), and a text link "Start without history".
- Drag and drop a file anywhere on the card.
- After import: a summary line "Loaded 4 records · Mon 2 Nov to Tue 10 Nov", then three suggested questions built from the loaded titles.

### Message list
- **User message**: `--surface` block, right-aligned, max 80% width, radius 10px.
- **Assistant message**: plain text in the column, no bubble, no avatar.
  - Order inside one answer: memory chips → answer text → sources → verification note.
  - A small "Copy" button under a finished answer copies its text.
- **Status line**: 13px muted text with a small orange dot, replaced in place as steps change. Removed when the first answer text arrives. No animation beyond a slow opacity pulse on the dot (off under reduced motion).

### Memory chip
- Pill, `--accent-soft` background, text like "Acme renewal call · Mon 9 Nov".
- Click opens the record viewer scrolled to the quoted segment.
- Keyboard: focusable, Enter opens.

### Quote
- Left border 2px `--border`, muted speaker name above the text. Used when the answer cites a record.

### Sources
- Small list under web answers: site name, page title (link), publish date or "undated".

### Verification marks
- Verified figure: no decoration in the text; the note under the answer reads "All figures match the records and sources I read".
- Unverified figure: dotted underline; hover or focus shows "Not found in the sources I read". Note under the answer: "1 figure could not be verified".
- Check unavailable: note reads "Verification unavailable for this answer".

### Composer
- Auto-growing textarea, 1 to 6 lines. Placeholder: "Ask about a meeting, a decision, or a date".
- Enter sends. Shift+Enter adds a line. Send is disabled when empty or offline.
- While streaming, Send becomes **Stop**.
- Character counter appears from 3,500; hard limit 4,000.

### Upload dialog
- Opened by "Upload JSON" in the header, on the welcome card and in the records panel.
- Shows how to shape a file: a short example (the same one offered as "Download this example", and imported by a test so it always works), each field with whether it is required, and notes on timezones, duplicates, chat exports and all-or-nothing imports.
- "Choose JSON file", or drop a file on it. The result (summary and warnings) or the error (record and field to fix) shows in the dialog.
- "Or load a ready-made sample": the small sample, and the larger Kestrel Works and Monsoon Bikes files in `samples/`. All fictional. The welcome card links here as "More samples".

### Records panel
- List grouped by date, newest first: type label (Meeting, Chat, Note), title, time.
- A search box filters by title, type, day or person.
- Each row: open, remove (with confirm). Footer: "Upload JSON" (opens the upload dialog), "Clear all" (with confirm).
- Empty state: "No records yet", with the two load buttons.

### Record viewer
- Title, date, participants, then the transcript as speaker and text rows. The cited segment is highlighted and scrolled into view.

## 5. States every component must handle

| Component | States |
|---|---|
| Welcome card | idle, dragging file, importing, success, error |
| Import | invalid JSON, wrong shape, empty, duplicate, too large, timezone assumed |
| Message (assistant) | status only, streaming, complete, stopped, incomplete (connection lost), error with Retry |
| Composer | empty, typing, sending, streaming (Stop), offline, over limit |
| Upload dialog | idle, dragging file, importing, success with warnings, error with details |
| Records panel | loading, empty, list, filtered, no match, removing, error |
| App | missing key notice, offline banner, database error notice |

## 6. Interface copy

Plain, specific, no exclamation marks, no apologies beyond one "Sorry" where something failed.

| Situation | Text |
|---|---|
| Missing model key | "Add CEREBRAS_API_KEY to .env and restart the server." |
| Missing Tavily key | "Web search is off. Add TAVILY_API_KEY to .env to turn it on. Questions about your records still work." |
| Not JSON | "This file isn't valid JSON." |
| Wrong shape | "Record 3 is missing a timestamp." (names the record and field) |
| Empty | "No records found in this file." |
| Duplicate | "4 records were already loaded and were skipped." |
| Too large | "This file is over 5 MB. Split it and upload the parts." |
| Timezone assumed | "2 records had no timezone. They were read as Asia/Kolkata." |
| Model error | "The answer didn't come through. Your message is saved." + Retry |
| Connection lost | "Connection lost. This answer is incomplete." + Retry |
| Stopped | "Stopped." |
| Offline | "You're offline. Messages will send when you're back." |
| Database error | "This chat can't be saved right now. You can keep talking." |
| Remove record | "Remove this record? The agent will no longer remember it." |
| Clear all | "Remove all records and chats? This can't be undone." |

## 7. Interaction rules

- Auto-scroll follows the stream only while the user is at the bottom. Otherwise show "Jump to latest".
- Focus returns to the composer after an answer completes or is stopped.
- New chat keeps all memory; it only starts a new thread.
- Reloading the page restores the current thread from the server.
- Opening the records panel moves focus into it; Escape closes it and returns focus to the trigger.
- Status and error updates are announced through an `aria-live="polite"` region; the streaming answer is not announced token by token, only "Answer ready" at the end.
- All controls reachable by keyboard with a visible 2px focus ring.

## 8. Files

```
web/
  main.tsx  App.tsx  styles/tokens.css  styles/base.css
  http/client.ts       fetch wrappers and the SSE reader (uses fetch streaming, since the chat request is a POST).
                       Not web/api/: in dev Vite serves it at /api/client.ts, which the API route answers first.
  state/chat.ts        reducer: messages, stream state
  state/records.ts     reducer: records, import state
  components/
    Header  WelcomeCard  MessageList  UserMessage  AssistantMessage
    StatusLine  MemoryChip  Quote  Sources  VerificationNote
    Composer  RecordsPanel  RecordViewer  ImportDialog  Banner  ConfirmDialog
  assets/mark.svg      original cat-ear mark
```
