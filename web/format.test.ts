import { describe, expect, it } from "vitest";
import { count, dayLabel, rangeLabel, timeLabel } from "./format.ts";

describe("format", () => {
  it("shows a day with its weekday, in the given timezone", () => {
    // 20:00 UTC on Sun 8 Nov is already Mon 9 Nov in Kolkata.
    expect(dayLabel("2026-11-08T20:00:00Z", "Asia/Kolkata")).toBe("Mon 9 Nov");
    expect(dayLabel("2026-11-08T20:00:00Z", "UTC")).toBe("Sun 8 Nov");
  });

  it("shows a 24-hour time", () => {
    expect(timeLabel("2026-11-09T04:00:00Z", "Asia/Kolkata")).toBe("09:30");
  });

  it("shows a range, or one day when it starts and ends on the same day", () => {
    expect(rangeLabel("2026-11-02T04:00:00Z", "2026-11-10T04:00:00Z", "Asia/Kolkata")).toBe("Mon 2 Nov to Tue 10 Nov");
    expect(rangeLabel("2026-11-02T04:00:00Z", "2026-11-02T10:00:00Z", "Asia/Kolkata")).toBe("Mon 2 Nov");
  });

  it("counts with the right noun", () => {
    expect(count(1, "record")).toBe("1 record");
    expect(count(4, "record")).toBe("4 records");
    expect(count(3500, "character")).toBe("3,500 characters");
  });
});
