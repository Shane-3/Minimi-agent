// Turning grounding checks into marks the answer's Markdown can carry.
import type { Check, Segment } from "../shared/types.ts";

/** Links to "#check-<n>" are drawn as unverified marks, not links. */
export const MARK_PREFIX = "#check-";

/**
 * Wraps each unverified item in the answer as a link to `#check-<n>`, where n
 * is its index in `checks`, so the renderer can draw it with its reason. Raw
 * HTML is off in the renderer, so a link is the one inline wrapper available.
 * Items inside an existing link or code span are left alone: a link cannot
 * hold a link. They still count in the note under the answer.
 */
export function markUnverified(answer: string, checks: Check[]): string {
  const protectedRanges = [...answer.matchAll(/\[[^\]\n]*\]\([^)\s]*\)|`[^`\n]*`/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const marks = checks
    .map((check, index) => ({ check, index }))
    .filter(({ check }) => !check.verified)
    .filter(({ check }) => answer.slice(check.start, check.start + check.text.length) === check.text)
    .filter(({ check }) => !protectedRanges.some((range) => check.start < range.end && check.start + check.text.length > range.start))
    .sort((a, b) => a.check.start - b.check.start);

  let out = "";
  let at = 0;
  for (const { check, index } of marks) {
    if (check.start < at) continue; // overlaps the previous mark
    const escaped = check.text.replace(/[[\]\\]/g, (char) => `\\${char}`);
    out += `${answer.slice(at, check.start)}[${escaped}](${MARK_PREFIX}${index})`;
    at = check.start + check.text.length;
  }
  return out + answer.slice(at);
}

const KIND_NAMES: { [kind in Check["kind"]]: [string, string] } = {
  figure: ["figure", "figures"],
  date: ["date", "dates"],
  quote: ["quote", "quotes"],
};

/**
 * The note under an answer: null when there was nothing to check.
 * `checks` null means the check itself failed.
 */
export function verificationNote(checks: Check[] | null): { text: string; warning: boolean } | null {
  if (checks === null) return { text: "Verification unavailable for this answer", warning: true };
  if (checks.length === 0) return null;
  const unverified = checks.filter((check) => !check.verified);
  if (unverified.length === 0) return { text: "All figures match the records and sources I read", warning: false };

  const parts = (Object.keys(KIND_NAMES) as Check["kind"][]).flatMap((kind) => {
    const n = unverified.filter((check) => check.kind === kind).length;
    return n === 0 ? [] : [`${n} ${KIND_NAMES[kind][n === 1 ? 0 : 1]}`];
  });
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)!}`;
  return { text: `${list} could not be verified`, warning: true };
}

function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** The segments that hold any of the quoted words, for highlighting in the record viewer. */
export function quotedSegmentIds(segments: Segment[], quotes: string[]): Set<number> {
  const ids = new Set<number>();
  for (const quote of quotes) {
    // A quote cut with "..." is found by its longest piece.
    const piece = quote
      .split(/\s*(?:\.{3}|…)\s*/)
      .map((part) => plain(part).replace(/^[\s.,;:!?'"-]+|[\s.,;:!?'"-]+$/g, ""))
      .sort((a, b) => b.length - a.length)[0];
    if (piece === undefined || piece.length < 3) continue;
    const found = segments.find((segment) => plain(segment.text).includes(piece));
    if (found !== undefined) ids.add(found.id);
  }
  return ids;
}
