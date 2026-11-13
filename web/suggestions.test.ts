import { describe, expect, it } from "vitest";
import type { RecordSummary } from "../shared/types.ts";
import { suggestedQuestions } from "./suggestions.ts";

const record = (id: string, type: RecordSummary["type"], title: string, startedAt: string): RecordSummary => ({
  id,
  type,
  title,
  startedAt,
  participants: [],
});

describe("suggestedQuestions", () => {
  it("asks about the newest meetings and a date, leaving out chats", () => {
    const records = [
      record("chat", "chat", "Postgres prices", "2026-11-13T05:00:00Z"),
      record("acme", "meeting", "Acme renewal call", "2026-11-12T04:00:00Z"),
      record("notes", "note", "Support interviews", "2026-11-06T04:00:00Z"),
      record("crm", "meeting", "CRM shortlist review", "2026-11-09T04:00:00Z"),
    ];
    expect(suggestedQuestions(records, "Asia/Kolkata")).toEqual([
      "What did we decide in the Acme renewal call?",
      "What happened on Mon 9 Nov?",
      "What are the action items from the CRM shortlist review?",
    ]);
  });

  it("gives fewer questions for fewer records, and none for none", () => {
    expect(suggestedQuestions([record("acme", "meeting", "Acme renewal call", "2026-11-12T04:00:00Z")], "UTC")).toEqual([
      "What did we decide in the Acme renewal call?",
    ]);
    expect(suggestedQuestions([], "UTC")).toEqual([]);
  });
});
