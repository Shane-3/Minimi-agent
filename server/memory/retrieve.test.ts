import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDates } from "./dates.ts";
import { importInto, loadSampleInto, prepareImport, prepareSample } from "./importer.ts";
import { ftsQuery, keywords, retrieve, type Retrieval } from "./retrieve.ts";
import { Store } from "./store.ts";

const KOLKATA = "Asia/Kolkata";
// Wednesday 11 November 2026, 11:30 in Kolkata. The sample then sits on:
// Thu 29 Oct Acme kickoff, Tue 3 Nov Postgres hosting, Thu 5 Nov Acme renewal,
// Fri 6 Nov support interviews, Mon 9 Nov CRM shortlist.
const NOW = new Date("2026-11-11T06:00:00Z");
const sample = JSON.parse(readFileSync(new URL("../../data/sample.json", import.meta.url), "utf8")) as unknown;

let store: Store;

beforeEach(() => {
  store = new Store(":memory:");
});

afterEach(() => {
  store.close();
});

function loadSample(): void {
  loadSampleInto(store, prepareSample(sample, KOLKATA, NOW), KOLKATA);
}

function importRecords(records: unknown[]): void {
  importInto(store, prepareImport(records, KOLKATA), KOLKATA);
}

function ask(message: string, budgetTokens?: number, excludeRecordId?: string): Retrieval {
  return retrieve(store, message, { timezone: KOLKATA, now: NOW, budgetTokens, excludeRecordId });
}

const focusIds = (result: Retrieval) => result.focus.map((record) => record.id);
const loadedIds = (result: Retrieval) => result.loaded.map((loaded) => loaded.record.id);

describe("retrieve: nothing stored", () => {
  it("returns an empty context", () => {
    expect(ask("What did we decide on Monday?")).toEqual({
      index: [],
      storedRange: null,
      dates: [],
      focus: [],
      loaded: [],
      allLoaded: true,
    });
  });
});

describe("retrieve: when everything fits", () => {
  beforeEach(loadSample);

  it("loads every record whole, oldest first, and lists them all in the index", () => {
    const result = ask("On Monday we shortlisted 5 CRM tools. Has pricing changed?");
    expect(result.allLoaded).toBe(true);
    expect(loadedIds(result)).toEqual([
      "sample-acme-kickoff",
      "sample-postgres-hosting",
      "sample-postgres-prices-chat",
      "sample-acme-renewal",
      "sample-support-interviews",
      "sample-crm-shortlist",
    ]);
    expect(result.loaded.every((loaded) => !loaded.partial)).toBe(true);
    expect(result.loaded.find((loaded) => loaded.record.id === "sample-crm-shortlist")?.record.segments).toHaveLength(8);
    expect(result.index).toHaveLength(6);
    expect(result.storedRange).toEqual({ from: "2026-10-29T05:30:00.000Z", to: "2026-11-09T08:30:00.000Z" });
  });

  it("focuses on the record from the date in the question", () => {
    const result = ask("On Monday we shortlisted 5 CRM tools. Has pricing changed?");
    expect(focusIds(result)).toEqual(["sample-crm-shortlist"]);
    expect(result.dates).toMatchObject([{ text: "On Monday", label: "Mon 9 Nov", recordIds: ["sample-crm-shortlist"] }]);
  });

  it("finds last Tuesday's records: the Postgres meeting and the Postgres prices chat", () => {
    const focus = focusIds(ask("What did we decide about Postgres hosting last Tuesday?"));
    expect(focus.sort()).toEqual(["sample-postgres-hosting", "sample-postgres-prices-chat"]);
  });

  it("focuses on keyword matches when the question has no date", () => {
    expect(focusIds(ask("Who did we interview for the support lead role?"))).toEqual(["sample-support-interviews"]);
    expect(focusIds(ask("Which Postgres providers are we looking at?"))).toEqual(["sample-postgres-hosting"]);
  });

  it("brings every day a topic came up, for a timeline", () => {
    const result = ask("What did we decide about the Acme discount?");
    expect(focusIds(result).sort()).toEqual(["sample-acme-kickoff", "sample-acme-renewal"]);
  });

  it("keeps the week-earlier record for an ambiguous weekday", () => {
    const result = ask("What did we agree on Thursday?");
    expect(result.dates[0]).toMatchObject({
      label: "Thu 5 Nov",
      recordIds: ["sample-acme-renewal"],
      earlier: { label: "Thu 29 Oct", recordIds: ["sample-acme-kickoff"] },
    });
    expect(focusIds(result)).toEqual(["sample-acme-renewal"]);
  });

  it("reports a date with nothing on it, and no nearest record when the topic matches nothing", () => {
    const result = ask("What happened on 28 October?");
    expect(result.dates).toEqual([
      expect.objectContaining({ label: "Wed 28 Oct", recordIds: [] }),
    ]);
    expect(result.dates[0]?.nearestId).toBeUndefined();
    expect(result.focus).toEqual([]);
    // Before the first record: only a later day with records.
    expect(result.dates[0]?.before).toBeUndefined();
    expect(result.dates[0]?.after).toBe("2026-10-29T05:30:00.000Z");
  });

  it("gives the nearest days with any records either side of an empty date", () => {
    const result = ask("What happened on Wednesday?");
    expect(result.dates[0]).toMatchObject({ label: "Wed 4 Nov", recordIds: [] });
    expect(result.dates[0]?.before?.slice(0, 10)).toBe("2026-11-03");
    expect(result.dates[0]?.after?.slice(0, 10)).toBe("2026-11-05");
  });

  it("offers the nearest record on the same topic when the date has none", () => {
    // Wednesday 4 Nov has no record; the discount came up on Thu 5 Nov and Thu 29 Oct.
    const result = ask("What did Priya say about the discount on Wednesday?");
    expect(result.dates[0]).toMatchObject({ label: "Wed 4 Nov", recordIds: [], nearestId: "sample-acme-renewal" });
    expect(focusIds(result)).toEqual(["sample-acme-renewal"]);
  });

  it("lists several records on the same day, best topic match first", () => {
    importRecords([
      {
        type: "note",
        title: "Hiring budget",
        timestamp: "2026-11-03T18:00:00+05:30",
        content: "The hiring budget for next quarter covers two support roles.",
      },
    ]);
    // 3 November now holds the Postgres meeting, the sample's Postgres prices chat and this note.
    const postgres = ask("What did we say about Postgres last Tuesday?").dates[0]?.recordIds ?? [];
    expect(postgres).toHaveLength(3);
    expect(postgres.slice(0, 2).sort()).toEqual(["sample-postgres-hosting", "sample-postgres-prices-chat"]);
    const hiring = ask("What about the hiring budget last Tuesday?");
    expect(hiring.dates[0]?.recordIds).toHaveLength(3);
    expect(hiring.focus[0]?.title).toBe("Hiring budget");
  });

  it("leaves out the live chat the question belongs to", () => {
    importRecords([{ timestamp: "2026-11-11T11:00:00+05:30", role: "user", content: "What did we decide about Acme?" }]);
    // Found by title: the sample has a chat of its own.
    const chatId = store.listRecords().find((record) => record.title === "What did we decide about Acme?")!.id;
    const result = ask("What did we decide about Acme?", undefined, chatId);
    expect(result.index.map((record) => record.id)).not.toContain(chatId);
    expect(loadedIds(result)).not.toContain(chatId);
  });

  it("is not confused by search syntax in the question", () => {
    const result = ask('Acme AND "discount* NEAR( OR -');
    expect(focusIds(result).sort()).toEqual(["sample-acme-kickoff", "sample-acme-renewal"]);
  });
});

describe("retrieve: over the budget", () => {
  it("loads the focus first and leaves the rest in the index", () => {
    loadSample();
    const everything = ask("anything").loaded.length;
    expect(everything).toBe(6);

    // Room for about two of the short sample records. Loaded records are
    // listed oldest first, so the check is that the focus is among them, whole.
    const result = ask("On Monday we shortlisted 5 CRM tools. Has pricing changed?", 400);
    expect(result.allLoaded).toBe(false);
    expect(result.loaded.find((loaded) => loaded.record.id === "sample-crm-shortlist")?.partial).toBe(false);
    expect(result.loaded.length).toBeLessThan(6);
    expect(result.index).toHaveLength(6);
  });

  it("keeps a follow-up on the records the chat was about", () => {
    loadSample();
    const followUp = { questions: ["What did Priya say about the discount?"], answers: [], recordIds: ["sample-acme-renewal"] };
    // "Why?" has nothing of its own to search for: the last answer's record is its focus, and is loaded.
    const why = retrieve(store, "Why?", { timezone: KOLKATA, now: NOW, budgetTokens: 400, followUp });
    expect(focusIds(why)).toEqual(["sample-acme-renewal"]);
    expect(loadedIds(why)).toContain("sample-acme-renewal");
    // A follow-up with its own topic keeps that focus, and still loads the chat's records after it.
    const crm = retrieve(store, "And the CRM shortlist?", { timezone: KOLKATA, now: NOW, budgetTokens: 800, followUp });
    expect(focusIds(crm)).toEqual(["sample-crm-shortlist"]);
    expect(loadedIds(crm)).toEqual(expect.arrayContaining(["sample-crm-shortlist", "sample-acme-renewal"]));
  });

  it("searches for the people the chat's last answers named", () => {
    loadSample();
    // Meera speaks only in the CRM review; the follow-up names nobody, the last answer did.
    const followUp = { questions: [], answers: ["Meera leaned towards HubSpot."], recordIds: [] };
    const result = retrieve(store, "Anyone else?", { timezone: KOLKATA, now: NOW, budgetTokens: 400, followUp });
    expect(loadedIds(result)).toContain("sample-crm-shortlist");
  });

  it("fills the budget left with the rest of the matched chat group, for words the question does not share", () => {
    importRecords([
      { type: "chat", title: "WhatsApp: Workshop", timestamp: "2026-09-16T16:45:00+05:30", turns: [{ speaker: "Arif", text: "250 battery packs received from the supplier." }] },
      { type: "chat", title: "WhatsApp: Workshop", timestamp: "2026-10-07T15:20:00+05:30", turns: [{ speaker: "Arif", text: "The last 150 packs are in. All 400 received now." }] },
      // Longer than the whole budget, and about something else.
      { type: "note", title: "Long notes", timestamp: "2026-11-01T10:00:00+05:30", content: Array.from({ length: 400 }, (_, i) => `Paragraph ${i} about the office plants.`).join("\n\n") },
    ]);
    const result = ask("Did all the batteries arrive?", 300);
    expect(result.allLoaded).toBe(false);
    // The second message never says "battery", but it is in the same group as the one that does.
    expect(result.loaded.map((loaded) => loaded.record.segments[0]?.text)).toEqual([
      "250 battery packs received from the supplier.",
      "The last 150 packs are in. All 400 received now.",
    ]);
  });

  it("loads the most recent records when nothing matches", () => {
    loadSample();
    const result = ask("Give me an overview", 400);
    expect(loadedIds(result)).toContain("sample-crm-shortlist");
    expect(result.loaded.length).toBeLessThan(5);
  });

  describe("a record longer than the whole budget", () => {
    // 200 routine turns with one that matters in the middle.
    const turns = Array.from({ length: 200 }, (_, seq) => ({
      speaker: seq % 2 === 0 ? "Dana" : "Sam",
      text:
        seq === 120
          ? "The zebra crossing project was approved by the council."
          : `We went through routine item number ${seq} on the list.`,
    }));
    const allHands = { type: "meeting", title: "All-hands", timestamp: "2026-11-10T10:00:00+05:30", turns };

    beforeEach(() => {
      importRecords([allHands]);
    });

    it("loads the matching segment with its neighbours, in order, and marks the record partial", () => {
      const result = ask("What happened with the zebra crossing project?", 300);
      expect(result.loaded).toHaveLength(1);
      const [loaded] = result.loaded;
      expect(loaded?.partial).toBe(true);
      expect(loaded?.record.segments.map((segment) => segment.seq)).toEqual([118, 119, 120, 121, 122]);
      expect(loaded?.record.segments[2]?.text).toContain("zebra crossing");
      expect(focusIds(result)).toEqual([loaded?.record.id]);
    });

    it("loads the opening segments when the record was found by date alone", () => {
      const result = ask("What happened yesterday?", 100);
      const [loaded] = result.loaded;
      expect(loaded?.partial).toBe(true);
      const seqs = loaded?.record.segments.map((segment) => segment.seq) ?? [];
      expect(seqs[0]).toBe(0);
      expect(seqs).toEqual(seqs.map((_, index) => index));
      expect(seqs.length).toBeLessThan(200);
    });

    it("stays within the budget", () => {
      const result = ask("What happened with the zebra crossing project?", 300);
      const used = result.loaded
        .flatMap((loaded) => loaded.record.segments)
        .reduce((sum, segment) => sum + Math.ceil((segment.text.length + (segment.speaker?.length ?? 0)) / 4) + 3, 0);
      expect(used).toBeLessThanOrEqual(300);
    });
  });
});

describe("keywords", () => {
  it("keeps the topic words and drops question words and date phrases", () => {
    const message = "What did we decide about the Acme discount on Monday?";
    expect(keywords(message, resolveDates(message, KOLKATA, NOW))).toEqual(["acme", "discount"]);
  });

  it("keeps short codes and numbers", () => {
    expect(keywords("HR plan for Q4 with 12 seats", [])).toEqual(["hr", "plan", "q4", "12", "seats"]);
  });
});

describe("ftsQuery", () => {
  it("quotes every word and joins them with OR", () => {
    expect(ftsQuery(["acme", "discount"])).toBe('"acme" OR "discount"');
  });

  it("returns null when there is nothing to search for", () => {
    expect(ftsQuery([])).toBeNull();
  });
});
