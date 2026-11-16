import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordSummary } from "../../shared/types.ts";
import type { ImportState } from "../state/records.ts";
import { WelcomeCard } from "./WelcomeCard.tsx";

const KOLKATA = "Asia/Kolkata";
const records: RecordSummary[] = [
  { id: "acme", type: "meeting", title: "Acme renewal call", startedAt: "2026-11-12T04:00:00Z", participants: [] },
  { id: "crm", type: "meeting", title: "CRM shortlist review", startedAt: "2026-11-09T04:00:00Z", participants: [] },
];

const render = (stored: RecordSummary[], importState: ImportState) =>
  renderToStaticMarkup(
    <WelcomeCard
      records={stored}
      importState={importState}
      timezone={KOLKATA}
      onLoadSample={() => {}}
      onUpload={() => {}}
      onOpenImport={() => {}}
      onDrag={() => {}}
      onStartWithout={() => {}}
      onAsk={() => {}}
    />,
  );

describe("WelcomeCard", () => {
  it("offers the three ways in when nothing is loaded", () => {
    const html = render([], { phase: "idle" });
    expect(html).toContain("What do you want to remember?");
    expect(html).toContain("Load sample history");
    expect(html).toContain("Upload JSON");
    expect(html).toContain("Start without history");
  });

  it("after an import, says what was loaded, its warnings, and suggests questions", () => {
    const result = {
      imported: 2,
      skipped: 0,
      range: { from: records[1]!.startedAt, to: records[0]!.startedAt },
      warnings: ["2 records had no timezone. They were read as Asia/Kolkata."],
    };
    const html = render(records, { phase: "success", result });
    expect(html).toContain("Loaded 2 records · Mon 9 Nov to Thu 12 Nov");
    expect(html).toContain("2 records had no timezone. They were read as Asia/Kolkata.");
    expect(html).toContain("What did we decide in the Acme renewal call?");
  });

  it("shows an import error with its details, and the drop hint while dragging", () => {
    const failed = render([], { phase: "error", message: "Record 3 is missing a timestamp.", details: ["records[2].startedAt"] });
    expect(failed).toContain("Record 3 is missing a timestamp.");
    expect(failed).toContain("records[2].startedAt");
    expect(render([], { phase: "dragging" })).toContain("Drop the file to load it");
  });

  it("disables the buttons while importing", () => {
    expect(render([], { phase: "importing" })).toMatch(/<button[^>]*disabled=""[^>]*>Load sample history/);
  });
});
