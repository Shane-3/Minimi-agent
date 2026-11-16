import { describe, expect, it } from "vitest";
import { prepareImport } from "./importer.ts";
import { normaliseFieldNames } from "./fieldNames.ts";

const KOLKATA = "Asia/Kolkata";
const prepare = (value: unknown) => prepareImport(value, KOLKATA).records;

describe("other tools' field names", () => {
  it("reads a record written with other names: date, subject, kind, messages with from and body", () => {
    const [record] = prepare([
      {
        date: "2026-11-09T10:00:00+05:30",
        subject: "Re: launch date",
        kind: "email",
        messages: [
          { from: "Asha", body: "Can we ship on Friday?", time: "2026-11-09T10:00:00+05:30" },
          { from: "Ravi", body: "Yes, Friday works." },
        ],
      },
    ]);
    expect(record).toMatchObject({ type: "chat", title: "Re: launch date", startedAt: "2026-11-09T04:30:00.000Z" });
    expect(record!.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      ["Asha", "Can we ship on Friday?"],
      ["Ravi", "Yes, Friday works."],
    ]);
  });

  it("keeps the sender of a single email written as { from, subject, body }", () => {
    const [record] = prepare([{ date: "2026-11-09T10:00:00+05:30", from: "Asha", subject: "Beta", body: "The beta ships Friday." }]);
    expect(record).toMatchObject({ type: "chat", title: "Beta" });
    expect(record!.segments).toEqual([expect.objectContaining({ speaker: "Asha", text: "The beta ships Friday." })]);
  });

  it("works out a missing type: a conversation when it has turns, a note when it is one text", () => {
    const records = prepare([
      { timestamp: "2026-11-09T10:00:00+05:30", turns: [{ speaker: "Asha", text: "Hi" }] },
      { timestamp: "2026-11-09T11:00:00+05:30", notes: "Remember to book the venue." },
    ]);
    expect(records.map((record) => record.type)).toEqual(["chat", "note"]);
  });

  it("maps other names for a kind of record, and keeps any other kind as a note titled with it", () => {
    const at = "2026-11-09T10:00:00+05:30";
    const records = prepare(
      ["call", "WhatsApp", "Slack", "memo"].map((type) => ({ type, timestamp: at, content: `A ${type}` })),
    );
    expect(records.map((record) => record.type)).toEqual(["meeting", "chat", "chat", "note"]);

    const [article] = prepare([{ type: "article", title: "How Stripe prices", timestamp: at, content: "Usage-based." }]);
    expect(article).toMatchObject({ type: "note", title: "Article: How Stripe prices" });
    expect(() => prepare([{ type: 42, timestamp: at, content: "x" }])).toThrow('type must be "meeting", "chat" or "note"');
  });

  it("keeps every other field of a record with no text of its own, one line each", () => {
    const [bookmark] = prepare([
      { date: "2026-11-09", kind: "bookmark", title: "Postgres hosting guide", url: "https://example.com/guide", tags: ["db", "hosting"], rating: 4 },
    ]);
    expect(bookmark).toMatchObject({ type: "note", title: "Bookmark: Postgres hosting guide" });
    // One line per field, with no speaker: "url: ..." is not mistaken for a person.
    expect(bookmark!.segments.map((segment) => [segment.speaker, segment.text])).toEqual([
      [null, "url: https://example.com/guide"],
      [null, "tags: db, hosting"],
      [null, "rating: 4"],
    ]);
  });

  it("names a record without a title by its first field, and leaves a single field unlabelled", () => {
    const [task, entry] = prepare([
      { date: "2026-11-10", kind: "task", task: "Draft the pricing page copy", due: "2026-11-14" },
      { date: "2026-11-11", kind: "journal", entry: "Decided to try a free tier with a hard cap." },
    ]);
    expect(task).toMatchObject({ type: "note", title: "Task: Draft the pricing page copy" });
    expect(task!.segments.map((segment) => segment.text)).toEqual(["task: Draft the pricing page copy", "due: Sat 14 Nov 2026"]);
    expect(entry).toMatchObject({ type: "note", title: "Journal: Decided to try a free tier with a..." });
    expect(entry!.segments.map((segment) => segment.text)).toEqual(["Decided to try a free tier with a hard cap."]);
  });

  it("reads a single record on its own, and a list kept under any name", () => {
    expect(prepare({ date: "2026-11-09", task: "Book the venue", done: false })).toHaveLength(1);
    const journal = { owner: "Asha", journal: [{ date: "2026-11-09", entry: "Good day." }, { date: "2026-11-10", entry: "Shipped." }] };
    expect(prepare(journal).map((record) => record.type)).toEqual(["note", "note"]);
  });

  it("reads Unix time in seconds or milliseconds", () => {
    const records = prepare([
      { timestamp: 1_794_204_000, content: "Seconds" },
      { created_at: 1_794_204_000_000, content: "Milliseconds" },
    ]);
    expect(records.map((record) => record.startedAt)).toEqual(["2026-11-09T06:00:00.000Z", "2026-11-09T06:00:00.000Z"]);
  });

  it("reads a chat export under another list name, with author, text and create_time", () => {
    const [record] = prepare({
      conversations: [
        { author: "user", text: "Which Postgres host is cheapest?", create_time: 1_794_204_000 },
        { author: "assistant", text: "Neon's free tier, for a small database.", create_time: 1_794_204_060 },
      ],
    });
    expect(record).toMatchObject({ type: "chat" });
    expect(record!.segments.map((segment) => segment.speaker)).toEqual(["user", "assistant"]);
  });

  it("leaves a file in the documented format as it is", () => {
    const file = { records: [{ type: "meeting", title: "Planning", timestamp: "2026-11-09T10:00:00+05:30", turns: [{ speaker: "Asha", text: "Hi" }] }] };
    expect(normaliseFieldNames(file)).toEqual(file);
  });

  it("does not overwrite a documented field with another name for it", () => {
    const [record] = prepare([{ type: "note", timestamp: "2026-11-09T10:00:00+05:30", date: "2020-01-01", content: "Kept." }]);
    expect(record!.startedAt).toBe("2026-11-09T04:30:00.000Z");
  });
});
