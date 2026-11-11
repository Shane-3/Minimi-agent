import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store, StoreError, type NewRecord } from "./store.ts";

function record(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    type: "meeting",
    title: "Acme renewal call",
    startedAt: "2026-11-09T09:30:00.000Z",
    tz: "Asia/Kolkata",
    participants: ["Shane", "Priya"],
    source: "import",
    contentHash: "hash-1",
    segments: [
      { speaker: "Priya", text: "We can sign if onboarding is done by December.", ts: null },
      { speaker: "Shane", text: "Then we start onboarding on Monday.", ts: null },
    ],
    ...overrides,
  };
}

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("stores a record with its segments in order", () => {
    expect(store.insertRecords([record()])).toEqual({ inserted: 1, skipped: 0 });

    const [summary] = store.listRecords();
    expect(summary).toMatchObject({
      type: "meeting",
      title: "Acme renewal call",
      startedAt: "2026-11-09T09:30:00.000Z",
      participants: ["Shane", "Priya"],
    });

    const full = store.getRecord(summary!.id);
    expect(full?.tz).toBe("Asia/Kolkata");
    expect(full?.source).toBe("import");
    expect(full?.segments.map((segment) => [segment.seq, segment.speaker])).toEqual([
      [0, "Priya"],
      [1, "Shane"],
    ]);
  });

  it("lists records newest first", () => {
    store.insertRecords([
      record({ title: "Older", startedAt: "2026-11-02T10:00:00.000Z", contentHash: "a" }),
      record({ title: "Newer", startedAt: "2026-11-10T10:00:00.000Z", contentHash: "b" }),
    ]);
    expect(store.listRecords().map((summary) => summary.title)).toEqual(["Newer", "Older"]);
  });

  it("skips a record whose content hash is already stored", () => {
    store.insertRecords([record()]);
    expect(store.insertRecords([record(), record({ contentHash: "hash-2" })])).toEqual({ inserted: 1, skipped: 1 });
    expect(store.listRecords()).toHaveLength(2);
  });

  it("skips a record repeated inside the same batch", () => {
    expect(store.insertRecords([record(), record()])).toEqual({ inserted: 1, skipped: 1 });
  });

  it("returns null for an unknown record id", () => {
    expect(store.getRecord("missing")).toBeNull();
  });

  it("finds segments by full-text search, with stemming", () => {
    store.insertRecords([record()]);
    const hits = store.searchSegments("onboard", 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.recordId).toBe(store.listRecords()[0]?.id);
  });

  it("finds segments by the record title", () => {
    store.insertRecords([record()]);
    expect(store.searchSegments("renewal", 10)).toHaveLength(2);
  });

  it("removes a record, its segments and its search rows", () => {
    store.insertRecords([record()]);
    const id = store.listRecords()[0]!.id;

    expect(store.deleteRecord(id)).toBe(true);
    expect(store.getRecord(id)).toBeNull();
    expect(store.searchSegments("onboarding", 10)).toEqual([]);
    expect(store.deleteRecord(id)).toBe(false);
  });

  it("lets a removed record be imported again", () => {
    store.insertRecords([record()]);
    store.deleteRecord(store.listRecords()[0]!.id);
    expect(store.insertRecords([record()])).toEqual({ inserted: 1, skipped: 0 });
  });

  it("clears all memory", () => {
    store.insertRecords([record(), record({ contentHash: "hash-2" })]);
    store.clearAll();
    expect(store.listRecords()).toEqual([]);
    expect(store.searchSegments("onboarding", 10)).toEqual([]);
  });

  it("saves nothing from a batch when one record fails", () => {
    // An invalid type passes TypeScript here only through the cast; SQLite's CHECK rejects it.
    const bad = record({ contentHash: "bad", type: "memo" as NewRecord["type"] });
    expect(() => store.insertRecords([record(), bad])).toThrow(StoreError);
    expect(store.listRecords()).toEqual([]);
  });

  it("wraps a malformed search query in a StoreError", () => {
    expect(() => store.searchSegments('"unclosed', 10)).toThrow(StoreError);
  });
});
