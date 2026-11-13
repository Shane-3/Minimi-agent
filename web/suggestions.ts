// Suggested questions after loading history (U7), built from the records loaded.
import type { RecordSummary } from "../shared/types.ts";
import { dayLabel } from "./format.ts";

/**
 * Up to three questions about the newest imported records: a decision, a
 * date, and action items. Past chats are left out; they are answers already.
 */
export function suggestedQuestions(records: RecordSummary[], timeZone: string): string[] {
  const newest = records
    .filter((record) => record.type !== "chat")
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const meetings = newest.filter((record) => record.type === "meeting");
  const questions: string[] = [];

  const first = meetings[0];
  if (first !== undefined) questions.push(`What did we decide in the ${first.title}?`);

  // A date question for a different record, so the three cover more ground.
  const dated = newest.find((record) => record.id !== first?.id);
  if (dated !== undefined) questions.push(`What happened on ${dayLabel(dated.startedAt, timeZone)}?`);

  const second = meetings.find((record) => record.id !== first?.id && record.id !== dated?.id) ?? meetings[1];
  if (second !== undefined && second.id !== first?.id) questions.push(`What are the action items from the ${second.title}?`);

  return questions;
}
