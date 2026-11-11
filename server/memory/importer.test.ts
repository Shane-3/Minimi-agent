import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ImportError,
  importInto,
  parseImportText,
  prepareImport,
  prepareSample,
  shortTitle,
  splitContent,
} from "./importer.ts";
import { Store } from "./store.ts";

const KOLKATA = "Asia/Kolkata";

function meeting(overrides: { [key: string]: unknown } = {}) {
  return {
    type: "meeting",
    title: "Acme renewal call",
    timestamp: "2026-11-09T15:00:00+05:30",
    participants: ["Shane", "Priya (Acme)"],
    turns: [
      { speaker: "Priya (Acme)", text: "We can sign if onboarding is done by December." },
      { speaker: "Shane", text: "Then onboarding starts Monday." },
    ],
    ...overrides,
  };
}

/** Runs the whole import and returns the error it throws. */
function importError(value: unknown, timezone = KOLKATA): ImportError {
  try {
    prepareImport(value, timezone);
  } catch (error) {
    if (error instanceof ImportError) return error;
    throw error;
  }
  throw new Error("expected the import to fail");
}

describe("parseImportText", () => {
  it("parses a JSON file", () => {
    expect(parseImportText('{ "records": [] }')).toEqual({ records: [] });
  });

  it("ignores a byte-order mark", () => {
    expect(parseImportText('﻿{ "records": [] }')).toEqual({ records: [] });
  });

  it("reports an empty file as having no records", () => {
    expect(() => parseImportText("  \n ")).toThrow("No records found in this file.");
  });

  it("reports invalid JSON with its line number", () => {
    const text = '{\n  "records": [\n    { "type": "meeting" }\n  ]\n  "extra": 1\n}';
    expect(() => parseImportText(text)).toThrow("This file isn't valid JSON (line 5).");
  });

  it("reports invalid JSON without a line when the parser gives none", () => {
    expect(() => parseImportText('{ "records": ')).toThrow("This file isn't valid JSON.");
  });

  it("rejects a file over the size limit", () => {
    const text = `"${"x".repeat(5 * 1024 * 1024)}"`;
    expect(() => parseImportText(text)).toThrow("This file is over 5 MB. Split it and upload the parts.");
  });
});

describe("prepareImport: valid files", () => {
  it("stores the timestamp in UTC and keeps the offset it was written in", () => {
    const [record] = prepareImport({ records: [meeting()] }, KOLKATA).records;
    expect(record).toMatchObject({
      type: "meeting",
      title: "Acme renewal call",
      startedAt: "2026-11-09T09:30:00.000Z",
      tz: "+05:30",
      participants: ["Shane", "Priya (Acme)"],
      source: "import",
    });
    expect(record?.segments).toEqual([
      { speaker: "Priya (Acme)", text: "We can sign if onboarding is done by December.", ts: null },
      { speaker: "Shane", text: "Then onboarding starts Monday.", ts: null },
    ]);
  });

  it("reads Z as UTC", () => {
    const [record] = prepareImport([meeting({ timestamp: "2026-11-09T09:30:00Z" })], KOLKATA).records;
    expect(record?.startedAt).toBe("2026-11-09T09:30:00.000Z");
    expect(record?.tz).toBe("UTC");
  });

  it("accepts a bare array of records", () => {
    expect(prepareImport([meeting(), meeting({ title: "Second" })], KOLKATA).records).toHaveLength(2);
  });

  it("reads per-turn timestamps", () => {
    const value = [meeting({ turns: [{ speaker: "Shane", text: "Hello", timestamp: "2026-11-09T15:01:00+05:30" }] })];
    expect(prepareImport(value, KOLKATA).records[0]?.segments[0]?.ts).toBe("2026-11-09T09:31:00.000Z");
  });

  it("splits a content string on speaker labels", () => {
    const value = [
      meeting({
        turns: undefined,
        participants: undefined,
        content: "Priya: We can sign.\nIf onboarding is done.\n\nShane: Agreed.",
      }),
    ];
    const [record] = prepareImport(value, KOLKATA).records;
    expect(record?.segments).toEqual([
      { speaker: "Priya", text: "We can sign.\nIf onboarding is done.", ts: null },
      { speaker: "Shane", text: "Agreed.", ts: null },
    ]);
    // With no participants given, they come from the speakers in the text.
    expect(record?.participants).toEqual(["Priya", "Shane"]);
  });

  it("names the record from its first words when it has no title", () => {
    const value = [{ type: "note", timestamp: "2026-11-09T15:00:00+05:30", content: "Call the bank about the loan." }];
    expect(prepareImport(value, KOLKATA).records[0]?.title).toBe("Call the bank about the loan.");
  });

  it("imports a chat export as one chat record per day", () => {
    const value = [
      { timestamp: "2026-11-03T10:00:00+05:30", role: "user", content: "What does HubSpot cost for 12 seats?" },
      { timestamp: "2026-11-03T10:00:05+05:30", role: "assistant", content: "Here is what I found." },
      { timestamp: "2026-11-04T09:00:00+05:30", role: "user", content: "And Pipedrive?" },
    ];
    const { records } = prepareImport(value, KOLKATA);
    expect(records.map((record) => [record.type, record.title, record.startedAt, record.segments.length])).toEqual([
      ["chat", "What does HubSpot cost for 12 seats?", "2026-11-03T04:30:00.000Z", 2],
      ["chat", "And Pipedrive?", "2026-11-04T03:30:00.000Z", 1],
    ]);
    expect(records[0]?.segments[1]).toEqual({
      speaker: "assistant",
      text: "Here is what I found.",
      ts: "2026-11-03T04:30:05.000Z",
    });
  });
});

describe("prepareImport: invalid files", () => {
  it("reports a file with no records", () => {
    for (const value of [[], { records: [] }]) {
      expect(importError(value)).toMatchObject({ code: "empty", message: "No records found in this file." });
    }
  });

  it("rejects JSON that is not a list of records", () => {
    for (const value of [42, "text", { meetings: [] }, { records: "none" }]) {
      expect(importError(value).code).toBe("wrong_shape");
    }
  });

  it("names the record that is missing a timestamp", () => {
    const error = importError([meeting(), meeting({ title: "Second", timestamp: undefined })]);
    expect(error.code).toBe("wrong_shape");
    expect(error.message).toBe('Record 2 ("Second") is missing a timestamp.');
  });

  it("names a record without a title by its number", () => {
    const error = importError([meeting({ title: undefined, timestamp: undefined })]);
    expect(error.message).toBe("Record 1 is missing a timestamp.");
  });

  it("names an invalid type", () => {
    expect(importError([meeting({ type: "memo" })]).message).toBe(
      'Record 1 ("Acme renewal call"): type must be "meeting", "chat" or "note".',
    );
  });

  it("names a field of the wrong kind", () => {
    expect(importError([meeting({ title: 42 })]).message).toBe("Record 1: title must be text.");
  });

  it("names a turn that is missing its text", () => {
    const error = importError([meeting({ turns: [{ speaker: "Shane", text: "Hi" }, { speaker: "Priya" }] })]);
    expect(error.message).toBe('Record 1 ("Acme renewal call"), turn 2 is missing its text.');
  });

  it("rejects a timestamp it cannot read", () => {
    expect(importError([meeting({ timestamp: "last Monday" })]).message).toBe(
      'Record 1 ("Acme renewal call"): timestamp "last Monday" isn\'t a date I can read. Use ISO 8601, like 2026-11-09T15:00:00+05:30.',
    );
  });

  it("rejects a date that is not on the calendar", () => {
    expect(importError([meeting({ timestamp: "2026-11-31T10:00:00+05:30" })]).message).toContain(
      'timestamp "2026-11-31T10:00:00+05:30" isn\'t a date I can read',
    );
  });

  it("rejects a record with neither turns nor content", () => {
    expect(importError([meeting({ turns: undefined })]).message).toBe(
      'Record 1 ("Acme renewal call") needs either turns or content.',
    );
  });

  it("rejects a record with both turns and content", () => {
    expect(importError([meeting({ content: "Shane: Hi" })]).message).toBe(
      'Record 1 ("Acme renewal call") has both turns and content. Keep one.',
    );
  });

  it("lists every problem in the details", () => {
    const error = importError([
      meeting({ timestamp: undefined }),
      meeting({ title: "Fine" }),
      meeting({ title: "Third", type: undefined }),
    ]);
    expect(error.details).toEqual([
      'Record 1 ("Acme renewal call") is missing a timestamp.',
      'Record 3 ("Third") is missing a type.',
    ]);
  });

  it("names the chat message that is missing a timestamp", () => {
    const error = importError([
      { timestamp: "2026-11-03T10:00:00+05:30", role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(error.message).toBe("Message 2 is missing a timestamp.");
  });

  it("rejects a timezone it does not recognise", () => {
    expect(importError([meeting()], "Mars/Olympus").code).toBe("invalid_timezone");
  });
});

describe("prepareImport: timestamps without a timezone", () => {
  it("reads them in the user's timezone and counts them", () => {
    const prepared = prepareImport([meeting({ timestamp: "2026-11-09T15:00:00" })], KOLKATA);
    expect(prepared.records[0]?.startedAt).toBe("2026-11-09T09:30:00.000Z");
    expect(prepared.records[0]?.tz).toBe(KOLKATA);
    expect(prepared.assumedTimezone).toBe(1);
  });

  it("accepts a date with no time as midnight", () => {
    const prepared = prepareImport([meeting({ timestamp: "2026-11-09" })], KOLKATA);
    expect(prepared.records[0]?.startedAt).toBe("2026-11-08T18:30:00.000Z");
  });

  it("follows daylight saving in the user's timezone", () => {
    const newYork = "America/New_York";
    const times = ["2026-07-01T12:00:00", "2026-12-01T12:00:00", "2026-11-01T12:00:00"].map(
      (timestamp) => prepareImport([meeting({ timestamp })], newYork).records[0]?.startedAt,
    );
    // Summer is UTC-4; winter, and the afternoon after the clocks go back on 1 Nov, are UTC-5.
    expect(times).toEqual(["2026-07-01T16:00:00.000Z", "2026-12-01T17:00:00.000Z", "2026-11-01T17:00:00.000Z"]);
  });

  it("counts a record whose turns have no timezone", () => {
    const value = [meeting({ turns: [{ speaker: "Shane", text: "Hi", timestamp: "2026-11-09T15:01:00" }] })];
    expect(prepareImport(value, KOLKATA).assumedTimezone).toBe(1);
  });

  it("does not count records that carry an offset", () => {
    expect(prepareImport([meeting()], KOLKATA).assumedTimezone).toBe(0);
  });
});

describe("importInto", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("stores the records and reports the range", () => {
    const value = [meeting({ title: "Later" }), meeting({ title: "Earlier", timestamp: "2026-11-02T11:00:00+05:30" })];
    const result = importInto(store, prepareImport(value, KOLKATA), KOLKATA);
    expect(result).toEqual({
      imported: 2,
      skipped: 0,
      range: { from: "2026-11-02T05:30:00.000Z", to: "2026-11-09T09:30:00.000Z" },
      warnings: [],
    });
    expect(store.listRecords()).toHaveLength(2);
  });

  it("skips a file imported twice", () => {
    const value = [meeting(), meeting({ title: "Second" })];
    importInto(store, prepareImport(value, KOLKATA), KOLKATA);
    const again = importInto(store, prepareImport(value, KOLKATA), KOLKATA);
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.warnings).toEqual(["2 records were already loaded and were skipped."]);
    expect(store.listRecords()).toHaveLength(2);
  });

  it("treats a reformatted copy of a record as a duplicate", () => {
    importInto(store, prepareImport([meeting()], KOLKATA), KOLKATA);
    const padded = meeting({ title: "  Acme renewal call ", timestamp: "2026-11-09T04:00:00-05:30" });
    const again = importInto(store, parseAndPrepare(JSON.stringify([padded], null, 4)), KOLKATA);
    expect(again.warnings).toEqual(["1 record was already loaded and was skipped."]);
  });

  it("stores nothing when any record is invalid", () => {
    expect(() => importInto(store, prepareImport([meeting(), meeting({ type: "memo" })], KOLKATA), KOLKATA)).toThrow(
      ImportError,
    );
    expect(store.listRecords()).toEqual([]);
  });

  it("says which timezone was assumed", () => {
    const value = [meeting({ timestamp: "2026-11-09T15:00:00" }), meeting({ title: "B", timestamp: "2026-11-10" })];
    expect(importInto(store, prepareImport(value, KOLKATA), KOLKATA).warnings).toEqual([
      "2 records had no timezone. They were read as Asia/Kolkata.",
    ]);
  });

  it("flags a record longer than the context budget", () => {
    const long = meeting({ title: "All-day workshop", turns: [{ speaker: "Shane", text: "word ".repeat(70_000) }] });
    expect(importInto(store, prepareImport([long], KOLKATA), KOLKATA).warnings).toEqual([
      '"All-day workshop" is too long to read in one go. Answers about it will use the parts that match the question.',
    ]);
  });
});

describe("prepareSample", () => {
  const sample = JSON.parse(readFileSync(new URL("../../data/sample.json", import.meta.url), "utf8")) as unknown;
  // Wednesday 11 November 2026, 11:30 in Kolkata.
  const now = new Date("2026-11-11T06:00:00Z");

  it("places every sample record a fixed number of days before today", () => {
    const { records, assumedTimezone } = prepareSample(sample, KOLKATA, now);
    expect(records.map((record) => [record.title, record.startedAt])).toEqual([
      ["Acme onboarding kickoff", "2026-11-02T05:30:00.000Z"],
      ["Support lead interviews", "2026-11-04T13:00:00.000Z"],
      ["CRM shortlist review", "2026-11-06T08:30:00.000Z"],
      ["Acme renewal call", "2026-11-09T09:30:00.000Z"],
    ]);
    // The sample is meant to be read in the user's zone, so no warning.
    expect(assumedTimezone).toBe(0);
  });

  it("counts days in the user's timezone, not the server's", () => {
    // 20:00 UTC on 10 Nov is already 01:30 on 11 Nov in Kolkata.
    const lateEvening = new Date("2026-11-10T20:00:00Z");
    const inKolkata = prepareSample(sample, KOLKATA, lateEvening).records.at(-1)?.startedAt;
    const inUtc = prepareSample(sample, "UTC", lateEvening).records.at(-1)?.startedAt;
    expect(inKolkata).toBe("2026-11-09T09:30:00.000Z");
    expect(inUtc).toBe("2026-11-08T15:00:00.000Z");
  });

  it("is skipped when loaded twice on the same day", () => {
    const store = new Store(":memory:");
    importInto(store, prepareSample(sample, KOLKATA, now), KOLKATA);
    const again = importInto(store, prepareSample(sample, KOLKATA, now), KOLKATA);
    expect(again).toMatchObject({ imported: 0, skipped: 4 });
    store.close();
  });
});

describe("splitContent", () => {
  it("splits prose into paragraphs with no speaker", () => {
    expect(splitContent("First idea.\n\nSecond idea.\r\n\r\nThird.")).toEqual([
      { speaker: null, text: "First idea.", ts: null },
      { speaker: null, text: "Second idea.", ts: null },
      { speaker: null, text: "Third.", ts: null },
    ]);
  });

  it("does not treat a single label line as a transcript", () => {
    expect(splitContent("Decision: we keep the current plan.")).toEqual([
      { speaker: null, text: "Decision: we keep the current plan.", ts: null },
    ]);
  });

  it("does not take times or links for speakers", () => {
    const segments = splitContent("Met at 10:30 today.\nNotes at https://example.com/notes");
    expect(segments.every((segment) => segment.speaker === null)).toBe(true);
  });
});

describe("shortTitle", () => {
  it("keeps a short text as it is", () => {
    expect(shortTitle("  What does   HubSpot cost? ")).toBe("What does HubSpot cost?");
  });

  it("cuts a long text at a word and marks the cut", () => {
    const title = shortTitle(
      "Can you compare the current pricing of the five tools we shortlisted on Monday, per seat?",
    );
    expect(title).toBe("Can you compare the current pricing of the five tools we…");
  });
});

function parseAndPrepare(text: string) {
  return prepareImport(parseImportText(text), KOLKATA);
}
