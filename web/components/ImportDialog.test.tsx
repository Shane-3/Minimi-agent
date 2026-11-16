import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordSummary } from "../../shared/types.ts";
import type { ImportState } from "../state/records.ts";
import { ImportDialog } from "./ImportDialog.tsx";
import { matchesFilter } from "./RecordsPanel.tsx";

const render = (importState: ImportState) =>
  renderToStaticMarkup(
    <ImportDialog open importState={importState} timezone="Asia/Kolkata" onUpload={() => {}} onDrag={() => {}} onClose={() => {}} />,
  );

describe("ImportDialog", () => {
  it("explains the format with an example, the fields and the limits, and offers the upload", () => {
    const html = render({ phase: "idle" });
    expect(html).toContain("Choose JSON file");
    expect(html).toContain("up to 5 MB");
    expect(html).toContain("&quot;records&quot;");
    for (const field of ["type", "timestamp", "turns", "content", "title", "participants"]) expect(html).toContain(`<code>${field}</code>`);
    expect(html).toContain("Download this example");
    expect(html).toContain("read in your timezone (Asia/Kolkata)");
  });

  it("shows the result of the upload, with its warnings", () => {
    const html = render({
      phase: "success",
      result: {
        imported: 3,
        skipped: 1,
        range: { from: "2026-11-09T04:30:00Z", to: "2026-11-11T13:00:00Z" },
        warnings: ["1 record was already loaded and was skipped."],
      },
    });
    expect(html).toContain("Loaded 3 records · Mon 9 Nov to Wed 11 Nov");
    expect(html).toContain("1 record was already loaded and was skipped.");
  });

  it("shows why an upload failed, with every problem when there are several", () => {
    const html = render({
      phase: "error",
      message: "Record 3 is missing a timestamp.",
      details: ["Record 3 is missing a timestamp.", "Record 5: type must be \"meeting\", \"chat\" or \"note\"."],
    });
    expect(html).toContain("Record 3 is missing a timestamp.");
    expect(html).toContain("Record 5: type must be");
  });
});

describe("matchesFilter", () => {
  const call: RecordSummary = { id: "a", type: "meeting", title: "Acme renewal call", startedAt: "2026-11-12T04:00:00Z", participants: ["Priya (Acme)"] };

  it("finds a record by any words of its title, type, day or people, in any case", () => {
    for (const filter of ["", "acme", "Renewal CALL", "meeting", "thu 12", "priya", "acme meeting"]) {
      expect(matchesFilter(call, filter, "Asia/Kolkata")).toBe(true);
    }
    expect(matchesFilter(call, "kickoff", "Asia/Kolkata")).toBe(false);
    expect(matchesFilter(call, "acme note", "Asia/Kolkata")).toBe(false);
  });
});
