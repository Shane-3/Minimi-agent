import { describe, expect, it } from "vitest";
import { parseImportText, prepareImport } from "../server/memory/importer.ts";
import { EXAMPLE_JSON } from "./importExample.ts";

describe("the upload example", () => {
  it("imports cleanly, with no warnings", () => {
    const prepared = prepareImport(parseImportText(EXAMPLE_JSON), "Asia/Kolkata");
    expect(prepared.records.map((record) => record.type)).toEqual(["meeting", "chat", "note"]);
    expect(prepared.assumedTimezone).toBe(0);
    expect(prepared.longTitles).toEqual([]);
    // The note's content is split into its two paragraphs.
    expect(prepared.records[2]!.segments).toHaveLength(2);
  });
});
