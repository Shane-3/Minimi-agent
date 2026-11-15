import { describe, expect, it } from "vitest";
import type { Check, Evidence, MemoryRecord } from "../../shared/types.ts";
import type { Retrieval } from "../memory/retrieve.ts";
import {
  BAD_ARITHMETIC,
  checkAnswer,
  NOT_A_DATE,
  NOT_FOUND,
  plainChars,
  QUOTE_NOT_FOUND,
  QUOTE_NOT_ON_PAGE,
  WRONG_WEEKDAY,
  type GroundingInput,
} from "./grounding.ts";

const KOLKATA = "Asia/Kolkata";
// Friday 13 November 2026, 11:30 in Kolkata.
const NOW = new Date("2026-11-13T06:00:00Z");

// The sample's fictional Acme call, on Thu 5 Nov.
const call: MemoryRecord = {
  id: "sample-acme-renewal",
  type: "meeting",
  title: "Acme renewal call",
  startedAt: "2026-11-05T09:30:00.000Z",
  participants: ["Shane", "Priya (Acme)"],
  tz: KOLKATA,
  source: "sample",
  segments: [
    { id: 1, seq: 0, speaker: "Priya (Acme)", text: "We'd also like to add 15 seats, going from 40 to 55.", ts: null },
    { id: 2, seq: 1, speaker: "Shane", text: "Then let's agree on that: onboarding starts Monday and finishes within five weeks.", ts: null },
    { id: 3, seq: 2, speaker: "Shane", text: "The export file was 9600 rows and took 0.5 hours to load.", ts: null },
  ],
};

function retrievalWith(records: MemoryRecord[], dates: Retrieval["dates"] = []): Retrieval {
  return {
    index: records.map(({ id, type, title, startedAt, participants }) => ({ id, type, title, startedAt, participants })),
    storedRange: { from: records[0]!.startedAt, to: records.at(-1)!.startedAt },
    dates,
    focus: [],
    loaded: records.map((record) => ({ record, partial: false })),
    allLoaded: true,
  };
}

const source = (snippet: string, publishedDate: string | null = "2026-11-10"): Evidence => ({
  title: "Plan A pricing",
  url: "https://example.com/pricing",
  site: "example.com",
  publishedDate,
  snippet,
  official: true,
});

function check(answer: string, overrides: Partial<GroundingInput> = {}): Check[] {
  return checkAnswer({
    answer,
    question: "What did we agree?",
    retrieval: retrievalWith([call]),
    history: [],
    evidence: [],
    timezone: KOLKATA,
    now: NOW,
    ...overrides,
  });
}

/** One check, found by the text it marks. */
function only(checks: Check[], text: string): Check {
  const found = checks.filter((item) => item.text === text);
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe("checkAnswer: figures", () => {
  it('matches "$15/user/mo" in an answer with "15 USD per seat" in a source', () => {
    const checks = check("Plan A is $15/user/mo.", { evidence: [source("Plan A costs 15 USD per seat, billed monthly.")] });
    expect(only(checks, "$15")).toMatchObject({ kind: "figure", verified: true });
  });

  it('matches "15 USD per seat" in an answer with "$15/user/mo" in a source', () => {
    const checks = check("Plan A is 15 USD per seat.", { evidence: [source("Plan A: $15/user/mo")] });
    expect(only(checks, "15")).toMatchObject({ verified: true });
  });

  it("flags a figure that is in no record or source, and says why", () => {
    const answer = "Plan A is $18 per seat.";
    const checks = check(answer, { evidence: [source("Plan A costs 15 USD per seat.")] });
    const flagged = only(checks, "$18");
    expect(flagged).toMatchObject({ kind: "figure", verified: false, reason: NOT_FOUND });
    expect(answer.slice(flagged.start, flagged.start + flagged.text.length)).toBe("$18");
  });

  it("verifies figures from the records, including ones written as words there", () => {
    const checks = check("Seats go from 40 to 55, and onboarding takes 5 weeks.");
    expect(checks.map((item) => [item.text, item.verified])).toEqual([
      ["40", true],
      ["55", true],
      ["5", true],
    ]);
  });

  it("treats 9,600 and 9600, and 0.50 and 0.5, as the same value", () => {
    const checks = check("It was 9,600 rows in 0.50 hours.");
    expect(checks.every((item) => item.verified)).toBe(true);
  });

  it("verifies a figure the user gave in the question", () => {
    const checks = check("You shortlisted 5 tools.", { question: "On Monday we shortlisted 5 CRM tools." });
    expect(only(checks, "5")).toMatchObject({ verified: true });
  });

  it("leaves out list numbers, link addresses, clock times, years and codes like Q4", () => {
    const answer = [
      "1. The call was at 15:00 in 2026, about the Q4 plan.",
      "2. See [the page](https://example.com/plans/77).",
    ].join("\n");
    expect(check(answer).filter((item) => item.kind === "figure")).toEqual([]);
  });
});

describe("checkAnswer: shown arithmetic", () => {
  it("verifies a sum that adds up", () => {
    const checks = check("Seats: 40 + 15 = 55.");
    expect(checks.map((item) => [item.text, item.verified])).toEqual([
      ["40", true],
      ["15", true],
      ["55", true],
    ]);
  });

  it("flags a result that does not add up, even when the number appears elsewhere", () => {
    const checks = check("Seats: 40 + 15 = 54.");
    expect(only(checks, "54")).toMatchObject({ verified: false, reason: BAD_ARITHMETIC });
  });

  it("works out sums with currency signs and a bold result", () => {
    const checks = check("12 seats: 12 × $14 = **$168**; 12 × $50 = $600; 12 × $9 = **$109**.", {
      question: "What would 12 seats cost?",
      evidence: [source("Plans: $14, $50 and $9 per user per month.")],
    });
    expect(only(checks, "$168")).toMatchObject({ verified: true });
    expect(only(checks, "$600")).toMatchObject({ verified: true });
    expect(only(checks, "$109")).toMatchObject({ verified: false, reason: BAD_ARITHMETIC });
    expect(checks.filter((item) => item.text === "$14" || item.text === "$50")).toEqual([
      expect.objectContaining({ verified: true }),
      expect.objectContaining({ verified: true }),
    ]);
  });

  it("accepts a rounded result", () => {
    expect(only(check("Rows per hour: 9600 / 0.5 ≈ 19200."), "19200")).toMatchObject({ verified: true });
  });
});

describe("checkAnswer: dates", () => {
  it("verifies a record's day, today, and a source's date, in each way they are written", () => {
    const checks = check("Agreed on Thu 5 Nov (Nov 5, 2026); checked Fri 13 Nov; the page is from 2026-11-10.", {
      evidence: [source("Plan details.")],
    });
    expect(checks.map((item) => [item.text, item.verified])).toEqual([
      ["Thu 5 Nov", true],
      ["Nov 5, 2026", true],
      ["Fri 13 Nov", true],
      ["2026-11-10", true],
    ]);
  });

  it("flags a weekday that does not match the date", () => {
    // 14 Nov 2026 is a Saturday.
    expect(only(check("Onboarding starts Mon 14 Nov."), "Mon 14 Nov")).toMatchObject({
      verified: false,
      reason: WRONG_WEEKDAY,
    });
  });

  it("reads a date with no year as the next one when only that fits the weekday", () => {
    // Today is Fri 13 Nov 2026; Sat 14 Nov is tomorrow, not 14 Nov 2025 (a Friday).
    const tomorrow = check("Onboarding starts Sat 14 Nov.", { question: "Does onboarding start Sat 14 Nov?" });
    expect(only(tomorrow, "Sat 14 Nov")).toMatchObject({ verified: true });
  });

  it("does not let a wrong weekday pass by matching another year", () => {
    // 22 Oct 2026 is a Thursday; 22 Oct 2027 is a Friday, but that is a year away.
    expect(only(check("Arjun was off on Fri 22 Oct."), "Fri 22 Oct")).toMatchObject({ verified: false, reason: WRONG_WEEKDAY });
  });

  it("flags a date in no record or source", () => {
    expect(only(check("Onboarding starts Sat 14 Nov."), "Sat 14 Nov")).toMatchObject({ verified: false, reason: NOT_FOUND });
  });

  it("flags a date that does not exist", () => {
    expect(only(check("Due 31 Nov."), "31 Nov")).toMatchObject({ verified: false, reason: NOT_A_DATE });
  });

  it("verifies a date written in a source's text", () => {
    const checks = check("Announced on 2 Nov.", { evidence: [source("Announced 2 November 2026: new plans.", null)] });
    expect(only(checks, "2 Nov")).toMatchObject({ verified: true });
  });

  it("verifies every day a date phrase in the question covers", () => {
    const lastWeek: Retrieval["dates"] = [
      { text: "last week", label: "Mon 2 Nov to Sun 8 Nov", from: "2026-11-01T18:30:00.000Z", to: "2026-11-08T18:30:00.000Z", recordIds: [] },
    ];
    const checks = check("Nothing on Wed 4 Nov.", { retrieval: retrievalWith([call], lastWeek) });
    expect(only(checks, "Wed 4 Nov")).toMatchObject({ verified: true });
  });

  it("verifies the day a record means by a weekday name, counted from when it was said", () => {
    // Said on Thu 5 Nov: "onboarding starts Monday" is Mon 9 Nov (or, read the other way, Mon 2 Nov).
    expect(only(check("Onboarding starts Mon 9 Nov."), "Mon 9 Nov")).toMatchObject({ verified: true });
    expect(only(check("Onboarding started Mon 2 Nov."), "Mon 2 Nov")).toMatchObject({ verified: true });
    expect(only(check("Onboarding starts Tue 10 Nov."), "Tue 10 Nov")).toMatchObject({ verified: false, reason: NOT_FOUND });
  });

  it("verifies tomorrow and yesterday from an earlier chat message, counted from when it was sent", () => {
    const history = [{ id: 9, role: "user" as const, text: "I'll send it tomorrow.", ts: "2026-11-03T11:00:00.000Z" }];
    expect(only(check("You said you'd send it on Wed 4 Nov.", { history }), "Wed 4 Nov")).toMatchObject({ verified: true });
  });

  it("does not read words that start like a month, or a heading over a list, as dates", () => {
    const answer = "**Decisions**\n\n1. Seats go to 55.\n2. Monitoring 5 dashboards.";
    expect(check(answer).filter((item) => item.kind === "date")).toEqual([]);
  });

  it("reads full and short month and weekday names", () => {
    const checks = check("Agreed Thursday 5 November; also Thurs Nov 5th.");
    expect(checks.map((item) => [item.text, item.verified])).toEqual([
      ["Thursday 5 November", true],
      ["Thurs Nov 5th", true],
    ]);
  });

  it("checks a count of days between the two dates of a sentence", () => {
    // Thu 5 Nov to Mon 9 Nov is 4 days.
    const wrong = check("Onboarding starts Mon 9 Nov, six days after the call on Thu 5 Nov.");
    expect(only(wrong, "six days")).toMatchObject({ kind: "figure", verified: false, reason: "These dates are 4 days apart" });
    const right = check("Onboarding starts Mon 9 Nov, 4 days after the call on Thu 5 Nov.");
    expect(only(right, "4 days")).toMatchObject({ verified: true });
    expect(right.filter((item) => item.text === "4")).toEqual([]);
  });

  it("counts weeks as seven days", () => {
    expect(only(check("Mon 9 Nov is one week after Mon 2 Nov."), "one week")).toMatchObject({ verified: true });
  });

  it("leaves a count alone when it is not a gap between two dates", () => {
    // "Within five weeks" is a duration, not a gap between the two dates.
    const checks = check("Agreed on Thu 5 Nov: onboarding starts Mon 9 Nov and finishes within five weeks.");
    expect(checks.filter((item) => item.text.includes("week"))).toEqual([]);
    // One date only: the count cannot be worked out, so it is not marked.
    expect(check("It shipped 4 days after Thu 5 Nov.").filter((item) => item.text === "4 days")).toEqual([]);
  });

  it("does not check the numbers inside a date as figures", () => {
    expect(check("Agreed on Thu 5 Nov.").filter((item) => item.kind === "figure")).toEqual([]);
  });
});

describe("checkAnswer: quotes", () => {
  it("verifies a quote that is in the record as written, from that speaker", () => {
    const checks = check('> **Priya (Acme):** "We\'d also like to add 15 seats, going from 40 to 55."');
    expect(checks).toEqual([
      expect.objectContaining({ kind: "quote", text: "We'd also like to add 15 seats, going from 40 to 55.", verified: true }),
    ]);
  });

  it("accepts curly quotes, a context note after the name, and cuts marked with ...", () => {
    const answer = "> **Shane (Acme renewal call, Thu 5 Nov):** “Then let’s agree on that ... finishes within five weeks.”";
    // The date in the label is a claim too, and is checked as one.
    expect(check(answer)).toEqual([
      expect.objectContaining({ kind: "date", text: "Thu 5 Nov", verified: true }),
      expect.objectContaining({ kind: "quote", verified: true }),
    ]);
  });

  it("flags reworded quotes", () => {
    const checks = check('> **Shane:** "Onboarding starts Monday and ends within five weeks."');
    expect(checks).toEqual([expect.objectContaining({ kind: "quote", verified: false, reason: QUOTE_NOT_FOUND })]);
  });

  it("flags a quote given to the wrong speaker, naming who said it", () => {
    const checks = check('> **Shane:** "We\'d also like to add 15 seats"');
    expect(checks).toEqual([
      expect.objectContaining({ kind: "quote", verified: false, reason: "In the record, Priya (Acme) said this" }),
    ]);
  });

  it("verifies a quote of the user's own earlier message", () => {
    const checks = check('> **You (chat, Tue 3 Nov):** "What do the plans cost?"', {
      history: [{ id: 9, role: "user", text: "What do the plans cost?", ts: "2026-11-03T11:00:00.000Z" }],
    });
    expect(checks).toEqual([
      expect.objectContaining({ kind: "date", text: "Tue 3 Nov", verified: true }),
      expect.objectContaining({ kind: "quote", verified: true }),
    ]);
  });

  it("verifies a quote from a web page, named by its site", () => {
    const evidence = [source("Plan A costs 15 USD per seat, billed monthly.")];
    expect(check('> **example.com:** "Plan A costs 15 USD per seat"', { evidence })).toEqual([
      expect.objectContaining({ kind: "quote", verified: true }),
    ]);
    expect(check('> **www.example.com:** "15 USD per seat, billed monthly."', { evidence })).toEqual([
      expect.objectContaining({ kind: "quote", verified: true }),
    ]);
  });

  it("flags a web quote that is not in the page text, or is from a different site", () => {
    const evidence = [source("Plan A costs 15 USD per seat."), { ...source("Plan B is free."), site: "other.example.org" }];
    expect(check('> **example.com:** "Plan A costs 18 USD per seat"', { evidence })).toEqual([
      expect.objectContaining({ verified: false, reason: QUOTE_NOT_ON_PAGE }),
    ]);
    expect(check('> **example.com:** "Plan B is free"', { evidence })).toEqual([
      expect.objectContaining({ verified: false, reason: "These words are from other.example.org" }),
    ]);
  });

  it("marks where the quote is in the answer", () => {
    const answer = 'Agreed.\n> **Shane:** "onboarding starts Monday"';
    const [quote] = check(answer);
    expect(answer.slice(quote!.start, quote!.start + quote!.text.length)).toBe("onboarding starts Monday");
  });
});

describe("checkAnswer: the whole answer", () => {
  it("returns the marks in reading order", () => {
    const checks = check('Agreed on Thu 5 Nov: 55 seats.\n> **Priya (Acme):** "going from 40 to 55"');
    expect(checks.map((item) => item.kind)).toEqual(["date", "figure", "quote"]);
  });

  it("finds nothing to check in a plain sentence", () => {
    expect(check("Nothing was decided about the office move.")).toEqual([]);
  });
});

describe("plainChars", () => {
  it("folds typographic characters one for one, so positions stay the same", () => {
    const text = "12‑month, 10 %, “quoted” and it’s";
    expect(plainChars(text)).toBe("12-month, 10 %, \"quoted\" and it's");
    expect(plainChars(text)).toHaveLength(text.length);
  });
});
