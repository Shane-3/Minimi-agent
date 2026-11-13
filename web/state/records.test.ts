import { describe, expect, it } from "vitest";
import type { RecordSummary } from "../../shared/types.ts";
import { initialRecords, recordsReducer, type RecordsState } from "./records.ts";

const call: RecordSummary = { id: "a", type: "meeting", title: "Acme renewal call", startedAt: "2026-11-12T09:30:00Z", participants: [] };
const note: RecordSummary = { id: "b", type: "note", title: "Support interviews", startedAt: "2026-11-06T09:30:00Z", participants: [] };

const ready: RecordsState = recordsReducer(initialRecords, { type: "loaded", records: [call, note] });

describe("recordsReducer", () => {
  it("loads, and keeps the list on screen while it reloads", () => {
    expect(initialRecords.phase).toBe("loading");
    expect(ready).toMatchObject({ phase: "ready", records: [call, note] });
    expect(recordsReducer(ready, { type: "load_start" })).toBe(ready);
    expect(recordsReducer(initialRecords, { type: "load_failed", message: "Your records can't be read right now." })).toMatchObject({
      phase: "error",
      loadError: "Your records can't be read right now.",
    });
  });

  it("marks a record while it is removed, then drops it", () => {
    const removing = recordsReducer(ready, { type: "remove_start", id: "a" });
    expect(removing.removing).toEqual(["a"]);
    const removed = recordsReducer(removing, { type: "removed", id: "a" });
    expect(removed).toMatchObject({ records: [note], removing: [] });
  });

  it("keeps a record whose removal failed and says why", () => {
    const failed = recordsReducer(recordsReducer(ready, { type: "remove_start", id: "a" }), {
      type: "remove_failed",
      id: "a",
      message: "The record couldn't be removed. Try again.",
    });
    expect(failed).toMatchObject({ records: [call, note], removing: [], actionError: "The record couldn't be removed. Try again." });
  });

  it("moves an import through dragging, importing and its result", () => {
    let state = recordsReducer(ready, { type: "drag", over: true });
    expect(state.import.phase).toBe("dragging");
    state = recordsReducer(state, { type: "drag", over: false });
    expect(state.import.phase).toBe("idle");

    state = recordsReducer(state, { type: "import_start" });
    expect(recordsReducer(state, { type: "drag", over: true }).import.phase).toBe("importing");

    const result = { imported: 2, skipped: 0, range: { from: note.startedAt, to: call.startedAt }, warnings: [] };
    expect(recordsReducer(state, { type: "imported", result }).import).toEqual({ phase: "success", result });
    expect(recordsReducer(state, { type: "import_failed", message: "This file isn't valid JSON.", details: [] }).import).toEqual({
      phase: "error",
      message: "This file isn't valid JSON.",
      details: [],
    });
  });

  it("empties the list when all memory is cleared", () => {
    expect(recordsReducer(ready, { type: "cleared" })).toMatchObject({ records: [], import: { phase: "idle" } });
  });
});
