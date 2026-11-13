import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDates, type ResolvedDate } from "./dates.ts";
import { prepareSample } from "./importer.ts";

const KOLKATA = "Asia/Kolkata";
// Wednesday 11 November 2026, 11:30 in Kolkata.
const WEDNESDAY = new Date("2026-11-11T06:00:00Z");

/** The phrase found and the days it covers, in a form that reads like the test name. */
function labels(message: string, timeZone = KOLKATA, now = WEDNESDAY): string[] {
  return resolveDates(message, timeZone, now).map((date) => `${date.text} = ${date.label}`);
}

function only(message: string, timeZone = KOLKATA, now = WEDNESDAY): ResolvedDate {
  const dates = resolveDates(message, timeZone, now);
  expect(dates).toHaveLength(1);
  return dates[0]!;
}

describe("resolveDates: weekday names", () => {
  it("reads a bare weekday as the most recent one, and keeps the week before as an alternative", () => {
    const monday = only("On Monday we shortlisted 5 CRM tools");
    expect(monday.text).toBe("On Monday");
    expect(monday.label).toBe("Mon 9 Nov");
    expect(monday.earlier?.label).toBe("Mon 2 Nov");
  });

  it("reads other weekdays the same way", () => {
    expect(labels("What happened on Friday?")).toEqual(["on Friday = Fri 6 Nov"]);
    expect(labels("Sunday")).toEqual(["Sunday = Sun 8 Nov"]);
  });

  it("reads today's weekday as a week ago, since today is called today", () => {
    expect(labels("What did we agree on Wednesday?")).toEqual(["on Wednesday = Wed 4 Nov"]);
  });

  it("reads 'this' as the current week, and leaves out days still to come", () => {
    expect(labels("this Monday")).toEqual(["this Monday = Mon 9 Nov"]);
    expect(labels("this Friday")).toEqual([]);
  });

  it("leaves out 'next', which is in the future", () => {
    expect(labels("next Monday")).toEqual([]);
  });
});

describe("resolveDates: last Tuesday", () => {
  // Weeks run Monday to Sunday, so "last Tuesday" is the previous week's,
  // never yesterday. Expected dates are written out by hand.
  it.each([
    ["Mon 9 Nov", "2026-11-09", "Tue 3 Nov"],
    ["Tue 10 Nov", "2026-11-10", "Tue 3 Nov"],
    ["Wed 11 Nov", "2026-11-11", "Tue 3 Nov"],
    ["Sun 15 Nov", "2026-11-15", "Tue 3 Nov"],
    ["Mon 16 Nov", "2026-11-16", "Tue 10 Nov"],
  ])("asked on %s, means the previous week's Tuesday", (_label, today, expected) => {
    expect(only("What did we discuss last Tuesday?", KOLKATA, new Date(`${today}T06:00:00Z`)).label).toBe(expected);
  });

  it("works inside a longer phrase", () => {
    expect(labels("Summarise last Friday's call")).toEqual(["last Friday = Fri 6 Nov"]);
  });

  it("does not offer a week-earlier alternative, since 'last' already picks the week", () => {
    expect(only("last Tuesday").earlier).toBeUndefined();
  });
});

describe("resolveDates: absolute dates", () => {
  it("reads a day and month as the most recent one", () => {
    expect(labels("What did I ask on 3 November?")).toEqual(["on 3 November = Tue 3 Nov"]);
    expect(labels("November 3rd")).toEqual(["November 3rd = Tue 3 Nov"]);
  });

  it("reads a day and month later in the year as last year's, not a future date", () => {
    expect(labels("1 December")).toEqual(["1 December = Mon 1 Dec 2025"]);
  });

  it("includes today", () => {
    expect(labels("on 11 November")).toEqual(["on 11 November = Wed 11 Nov"]);
  });

  it("uses the year when one is given", () => {
    expect(labels("3 November 2025")).toEqual(["3 November 2025 = Mon 3 Nov 2025"]);
    expect(labels("2026-11-03")).toEqual(["2026-11-03 = Tue 3 Nov"]);
  });

  it("reads a month on its own as the whole month", () => {
    expect(labels("What did we decide in October?")).toEqual(["October = Thu 1 Oct to Sat 31 Oct"]);
  });

  it("leaves out numeric dates, which mean different days in different countries", () => {
    expect(labels("on 3/11")).toEqual([]);
  });
});

describe("resolveDates: relative dates", () => {
  it("reads single days", () => {
    expect(labels("yesterday")).toEqual(["yesterday = Tue 10 Nov"]);
    expect(labels("today")).toEqual(["today = Wed 11 Nov"]);
    expect(labels("the day before yesterday")).toEqual(["the day before yesterday = Mon 9 Nov"]);
    expect(labels("3 days ago")).toEqual(["3 days ago = Sun 8 Nov"]);
  });

  it("reads 'two weeks ago' as the whole week it falls in", () => {
    expect(labels("What happened two weeks ago?")).toEqual(["two weeks ago = Mon 26 Oct to Sun 1 Nov"]);
    // chrono reads a preceding "about" as "approximately"; the days are the same.
    expect(labels("What did we talk about two weeks ago?")).toEqual(["about two weeks ago = Mon 26 Oct to Sun 1 Nov"]);
    expect(labels("a week ago")).toEqual(["a week ago = Mon 2 Nov to Sun 8 Nov"]);
  });

  it("reads 'last week' and 'this week' as whole weeks, cut off at today", () => {
    expect(labels("last week")).toEqual(["last week = Mon 2 Nov to Sun 8 Nov"]);
    expect(labels("this week")).toEqual(["this week = Mon 9 Nov to Wed 11 Nov"]);
  });

  it("reads months and years as whole months and years", () => {
    expect(labels("last month")).toEqual(["last month = Thu 1 Oct to Sat 31 Oct"]);
    expect(labels("two months ago")).toEqual(["two months ago = Tue 1 Sep to Wed 30 Sep"]);
    expect(labels("last year")).toEqual(["last year = Wed 1 Jan 2025 to Wed 31 Dec 2025"]);
  });
});

describe("resolveDates: other messages", () => {
  it("finds nothing in a message without a date", () => {
    expect(labels("What did we decide about the Acme discount?")).toEqual([]);
    expect(labels("May I ask what Priya wanted?")).toEqual([]);
  });

  it("ignores a time with no day", () => {
    expect(labels("the call at 3pm")).toEqual([]);
  });

  it("finds every date in a message", () => {
    expect(labels("Compare Monday's call with last Tuesday's")).toEqual(["Monday = Mon 9 Nov", "last Tuesday = Tue 3 Nov"]);
  });

  it("joins a weekday and a date separated by a comma, as in 'Tuesday, 3 November'", () => {
    expect(labels("Tuesday, 3 November")).toEqual(["Tuesday, 3 November = Tue 3 Nov"]);
    // The same rule joins "last Tuesday, yesterday" into one date. A known
    // limit of the library, kept visible here rather than worked around.
    expect(labels("last Tuesday, yesterday")).toEqual(["last Tuesday, yesterday = Tue 10 Nov"]);
  });
});

describe("resolveDates: timezones", () => {
  // 20:00 UTC on Sunday 15 Nov is already 01:30 on Monday 16 Nov in Kolkata.
  const sundayEvening = new Date("2026-11-15T20:00:00Z");

  it("decides what today is in the user's timezone", () => {
    expect(labels("yesterday", "UTC", sundayEvening)).toEqual(["yesterday = Sat 14 Nov"]);
    expect(labels("yesterday", KOLKATA, sundayEvening)).toEqual(["yesterday = Sun 15 Nov"]);
  });

  it("moves 'last Tuesday' to the next week once the user's week has turned over", () => {
    expect(only("last Tuesday", "UTC", sundayEvening).label).toBe("Tue 3 Nov");
    expect(only("last Tuesday", KOLKATA, sundayEvening).label).toBe("Tue 10 Nov");
  });

  it("gives the range as instants at the user's midnight", () => {
    const yesterday = only("yesterday", KOLKATA, sundayEvening);
    expect([yesterday.from, yesterday.to]).toEqual(["2026-11-14T18:30:00.000Z", "2026-11-15T18:30:00.000Z"]);
  });

  it("works for a timezone behind UTC", () => {
    // 05:00 UTC on Wednesday is still 21:00 on Tuesday in Los Angeles.
    const yesterday = only("yesterday", "America/Los_Angeles", WEDNESDAY_EARLY);
    expect(yesterday.label).toBe("Mon 9 Nov");
    expect([yesterday.from, yesterday.to]).toEqual(["2026-11-09T08:00:00.000Z", "2026-11-10T08:00:00.000Z"]);
  });

  it("follows a daylight-saving change inside the range", () => {
    // New York leaves daylight saving on Sunday 1 Nov, so this week starts at
    // UTC-4 and the next one at UTC-5.
    const week = only("two weeks ago", "America/New_York");
    expect([week.from, week.to]).toEqual(["2026-10-26T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  });

  describe("whatever timezone the server runs in", () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it.each([
      ["Pacific/Kiritimati", -840],
      ["Pacific/Pago_Pago", 660],
      ["UTC", 0],
    ])("gives the same answer with the server in %s", (zone, offset) => {
      process.env.TZ = zone;
      // Proves the switch took effect in this worker, so the test is not vacuous.
      expect(new Date(2026, 10, 15, 12).getTimezoneOffset()).toBe(offset);
      expect(labels("last Tuesday and yesterday and 3 November", KOLKATA, sundayEvening)).toEqual([
        "last Tuesday = Tue 10 Nov",
        "yesterday = Sun 15 Nov",
        "3 November = Tue 3 Nov",
      ]);
    });
  });
});

const WEDNESDAY_EARLY = new Date("2026-11-11T05:00:00Z");

describe("the sample's questions, asked on every day of the week", () => {
  const sample = JSON.parse(readFileSync(new URL("../../data/sample.json", import.meta.url), "utf8")) as unknown;

  it.each(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"])(
    "on %s, each question finds exactly its record",
    (today) => {
      const now = new Date(`${today}T06:00:00Z`);
      const records = prepareSample(sample, KOLKATA, now).records;
      const found = (question: string) => {
        const [date] = resolveDates(question, KOLKATA, now);
        if (date === undefined) return [];
        return records
          .filter((record) => record.startedAt >= date.from && record.startedAt < date.to)
          .map((record) => record.id);
      };

      expect(found("On Monday we shortlisted 5 CRM tools. Has pricing changed?")).toEqual(["sample-crm-shortlist"]);
      // In that week, last Tuesday is 3 November: the Postgres meeting and the 3 November chat.
      expect(found("What did we decide about Postgres hosting last Tuesday?")).toEqual([
        "sample-postgres-hosting",
        "sample-postgres-prices-chat",
      ]);
      expect(found("What did I ask on 3 November? Is it still correct?")).toEqual([
        "sample-postgres-hosting",
        "sample-postgres-prices-chat",
      ]);
    },
  );
});
