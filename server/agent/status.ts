// What the user sees while the answer is being prepared: a status line in
// plain words and chips for the records the answer draws on.
import type { Evidence, MemoryChip, Source } from "../../shared/types.ts";
import { formatDay, partsInZone, todayIn } from "../memory/dates.ts";
import type { Retrieval } from "../memory/retrieve.ts";

/** Sent the moment a question arrives, before any lookup, so the first status is never late. */
export const FIRST_STATUS = "Looking through your records";

/** "Reading CRM shortlist review · Mon 9 Nov", or a count when several records match. */
export function statusFor(retrieval: Retrieval, timezone: string, now: Date): string {
  if (retrieval.index.length === 0) return "No records loaded yet";
  const [first] = retrieval.focus;
  if (first !== undefined && retrieval.focus.length === 1) {
    const day = formatDay(partsInZone(new Date(first.startedAt), timezone), todayIn(now, timezone));
    return `Reading ${first.title} · ${day}`;
  }
  if (retrieval.focus.length > 1) return `Reading ${retrieval.focus.length} records on this`;
  return `Reading ${retrieval.index.length === 1 ? "1 record" : `${retrieval.index.length} records`}`;
}

export function chipsFor(retrieval: Retrieval): MemoryChip[] {
  return retrieval.focus.map(({ id, title, type, startedAt }) => ({ id, title, type, startedAt }));
}

/**
 * The pages to list under an answer: those it links to, in the order the
 * search ranked them. Pages the search returned but the answer did not use
 * are left out, so the list shows what the answer rests on.
 */
export function sourcesFor(evidence: Evidence[], answer: string): Source[] {
  return evidence
    .filter((page) => answer.includes(page.url))
    .map(({ title, url, site, publishedDate, official }) => ({ title, url, site, publishedDate, official }));
}
