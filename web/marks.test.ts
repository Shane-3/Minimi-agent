import { describe, expect, it } from "vitest";
import type { Check, Segment } from "../shared/types.ts";
import { markUnverified, quotedSegmentIds, verificationNote } from "./marks.ts";

const figure = (text: string, start: number, verified: boolean): Check => ({
  kind: "figure",
  text,
  start,
  verified,
  ...(verified ? {} : { reason: "Not found in the sources I read" }),
});

describe("markUnverified", () => {
  it("wraps unverified items only, pointing at their index in the checks", () => {
    const answer = "Team is $15, Pro is $18.";
    const checks = [figure("$15", 8, true), figure("$18", 20, false)];
    expect(markUnverified(answer, checks)).toBe("Team is $15, Pro is [$18](#check-1).");
  });

  it("leaves items inside a link or code span unmarked", () => {
    const answer = "See [plan $18](https://example.com) and `$19`.";
    const checks = [figure("$18", 10, false), figure("$19", 41, false)];
    expect(markUnverified(answer, checks)).toBe(answer);
  });

  it("escapes brackets in a marked quote", () => {
    const answer = '> **Shane:** "add [sic] seats"';
    const quote: Check = { kind: "quote", text: "add [sic] seats", start: 14, verified: false, reason: "Not in the record" };
    expect(markUnverified(answer, [quote])).toBe('> **Shane:** "[add \\[sic\\] seats](#check-0)"');
  });

  it("skips a check whose position does not match the text", () => {
    expect(markUnverified("Pro is $18.", [figure("$18", 2, false)])).toBe("Pro is $18.");
  });
});

describe("verificationNote", () => {
  it("says when all items match, when some do not, and when the check failed", () => {
    expect(verificationNote([figure("5", 0, true)])).toEqual({ text: "All figures match the records and sources I read", warning: false });
    expect(verificationNote([figure("5", 0, false)])).toEqual({ text: "1 figure could not be verified", warning: true });
    expect(verificationNote(null)).toEqual({ text: "Verification unavailable for this answer", warning: true });
    expect(verificationNote([])).toBeNull();
  });

  it("counts each kind", () => {
    const checks: Check[] = [
      figure("5", 0, false),
      figure("6", 2, false),
      { kind: "date", text: "Mon 14 Nov", start: 4, verified: false },
      { kind: "quote", text: "words", start: 20, verified: false },
    ];
    expect(verificationNote(checks)?.text).toBe("2 figures, 1 date and 1 quote could not be verified");
  });
});

describe("quotedSegmentIds", () => {
  const segments: Segment[] = [
    { id: 1, seq: 0, speaker: "Priya", text: "We’d also like to add 15 seats.", ts: null },
    { id: 2, seq: 1, speaker: "Shane", text: "Then let's agree on that: onboarding starts Monday.", ts: null },
  ];

  it("finds the quoted segments, with curly quotes and cuts", () => {
    expect(quotedSegmentIds(segments, ["We'd also like to add 15 seats", "Then let's agree ... onboarding starts Monday"])).toEqual(
      new Set([1, 2]),
    );
  });

  it("finds nothing for words not in the record", () => {
    expect(quotedSegmentIds(segments, ["We will cancel"])).toEqual(new Set());
  });
});
