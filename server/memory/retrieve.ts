// Finds the records a question is about and decides what goes into the
// prompt. Runs before the model on every message, so the model cannot forget
// to look (memory is code, not a tool).
import type { MemoryRecord, RecordSummary, Segment } from "../../shared/types.ts";
import {
  CHARS_PER_TOKEN,
  PARTIAL_NEIGHBOUR_SEGMENTS,
  RECORD_CONTEXT_BUDGET_TOKENS,
  SEGMENT_OVERHEAD_TOKENS,
  TOPIC_SEARCH_LIMIT,
} from "../config.ts";
import { resolveDates, type ResolvedDate } from "./dates.ts";
import type { RecordSize, Store } from "./store.ts";

/** What a date phrase in the question matched. */
export interface DateFinding {
  /** The words in the question, e.g. "last Tuesday". */
  text: string;
  /** The days they mean, e.g. "Tue 3 Nov". */
  label: string;
  from: string;
  to: string;
  /** Records in that range, best topic match first. Several means several on the same day. */
  recordIds: string[];
  /** For a bare weekday: records on the same weekday a week earlier ("Monday two weeks running"). Only set when there are some. */
  earlier?: { label: string; recordIds: string[] };
  /** When nothing is on that date: the record on the same topic closest in time to it. */
  nearestId?: string;
  /**
   * When nothing is on that date: the start of the last record before it and
   * of the first after it, whatever their topic, so the answer can name the
   * nearest days with records without working them out itself.
   */
  before?: string;
  after?: string;
}

export interface LoadedRecord {
  /** All segments, or when `partial`, only the ones chosen to fit the budget (with their original `seq`). */
  record: MemoryRecord;
  partial: boolean;
}

export interface Retrieval {
  /** Every record, newest first, so the model knows what exists and what does not. */
  index: RecordSummary[];
  /** First and last record time, or null when nothing is stored. */
  storedRange: { from: string; to: string } | null;
  dates: DateFinding[];
  /** The records the question is about: shown as memory chips and named in the status line. */
  focus: RecordSummary[];
  /** Records placed in the prompt, oldest first so they read as a timeline. */
  loaded: LoadedRecord[];
  /** True when everything stored fit the budget and was loaded whole. */
  allLoaded: boolean;
}

export interface RetrieveOptions {
  timezone: string;
  now: Date;
  /** Defaults to the configured context budget; tests pass a small one. */
  budgetTokens?: number;
  /** The live chat this question belongs to: already in the conversation, so not loaded again as memory. */
  excludeRecordId?: string;
}

export function retrieve(store: Store, message: string, options: RetrieveOptions): Retrieval {
  const budget = options.budgetTokens ?? RECORD_CONTEXT_BUDGET_TOKENS;
  const index = store.listRecords().filter((record) => record.id !== options.excludeRecordId);
  if (index.length === 0) {
    return { index, storedRange: null, dates: [], focus: [], loaded: [], allLoaded: true };
  }

  const byId = new Map(index.map((record) => [record.id, record]));
  const resolved = resolveDates(message, options.timezone, options.now);
  const query = ftsQuery(keywords(message, resolved));
  const topic = query === null ? new Map<string, TopicMatch>() : topicMatches(store, query, byId);
  const dates = resolved.map((date) => findDate(date, index, topic));
  const focus = chooseFocus(dates, topic, byId);

  const sizes = store.recordSizes();
  const tokensOf = (id: string) => estimateTokens(sizes.get(id));
  const total = index.reduce((sum, record) => sum + tokensOf(record.id), 0);

  const storedRange = { from: index[index.length - 1]!.startedAt, to: index[0]!.startedAt };

  // The usual case: everything fits, so everything is loaded whole and a
  // paraphrased question cannot miss its record. Matching above still picks
  // the focus and answers "is there anything on that date?".
  if (total <= budget) {
    const loaded = [...index].reverse().flatMap((summary) => {
      const record = store.getRecord(summary.id);
      return record === null ? [] : [{ record, partial: false }];
    });
    return { index, storedRange, dates, focus, loaded, allLoaded: true };
  }

  const loaded: LoadedRecord[] = [];
  let remaining = budget;
  for (const id of rankCandidates(dates, topic, focus, index)) {
    if (remaining <= 0) break;
    const size = tokensOf(id);
    const record = store.getRecord(id);
    if (record === null) continue;
    if (size <= remaining) {
      loaded.push({ record, partial: false });
      remaining -= size;
    } else if (size > budget) {
      // Too long to ever load whole: take the parts that match the question.
      const partial = partialRecord(store, record, query, remaining);
      if (partial !== null) {
        loaded.push(partial);
        remaining -= partial.record.segments.reduce((sum, segment) => sum + segmentTokens(segment), 0);
      }
    }
    // A record that would fit an empty budget but not what is left is skipped:
    // higher-ranked records already filled the space, and it stays in the index.
  }

  loaded.sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
  return { index, storedRange, dates, focus, loaded, allLoaded: false };
}

// ---------------------------------------------------------------------------
// Topic: keyword search

// Words that say how a question is asked, not what it is about. Without
// them, "What did we decide about the discount?" would match every record
// where something was decided.
const STOPWORDS = new Set(
  (
    "a about above after again all also am an and any are as at be been before being below between both but by " +
    "can could did do does doing done during each few for from further had has have having he her here hers him " +
    "his how i if in into is it its itself just me more most my no nor not now of off on once only or other our " +
    "ours out over own same she should so some still such than that the their theirs them then there these they " +
    "this those through to too under until up us very was we were what when where which while who whom why will " +
    "with would you your yours yet ever any anything something everything " +
    // Question framing.
    "tell told say said says ask asked asking decide decided decides deciding discuss discussed discussing talk " +
    "talked talking mention mentioned happen happened happening agree agreed remember know think thought please " +
    "summarise summarize summary recap give show list find get got"
  ).split(" "),
);

/** The words worth searching for: the question minus its date phrases and stopwords. */
export function keywords(message: string, dates: ResolvedDate[]): string[] {
  let text = message;
  for (const date of dates) text = text.replace(date.text, " ");
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) => word.length >= 2 && !STOPWORDS.has(word)))];
}

/**
 * An FTS5 query matching any of the words. Each word is quoted, and words
 * contain only letters and digits, so nothing in a message can be read as
 * FTS syntax (AND, NEAR, *, unbalanced quotes).
 */
export function ftsQuery(words: string[]): string | null {
  return words.length === 0 ? null : words.map((word) => `"${word}"`).join(" OR ");
}

interface TopicMatch {
  /**
   * bm25 score of the record's best-matching segment: lower is better. The
   * best segment, not the sum, because the question is whether the topic came
   * up in this record, not how often. A sum let a call that mentioned the
   * discount twice push out one that mentioned it once.
   */
  score: number;
  segmentIds: number[];
}

function topicMatches(store: Store, query: string, byId: Map<string, RecordSummary>): Map<string, TopicMatch> {
  const matches = new Map<string, TopicMatch>();
  for (const hit of store.searchSegments(query, TOPIC_SEARCH_LIMIT)) {
    if (!byId.has(hit.recordId)) continue;
    const match = matches.get(hit.recordId) ?? { score: 0, segmentIds: [] };
    match.score = Math.min(match.score, hit.score);
    match.segmentIds.push(hit.segmentId);
    matches.set(hit.recordId, match);
  }
  return matches;
}

function byTopic(topic: Map<string, TopicMatch>) {
  // Records with no keyword match sort after those with one.
  return (a: RecordSummary, b: RecordSummary) =>
    (topic.get(a.id)?.score ?? 0) - (topic.get(b.id)?.score ?? 0) || b.startedAt.localeCompare(a.startedAt);
}

// ---------------------------------------------------------------------------
// Dates and focus

function findDate(date: ResolvedDate, index: RecordSummary[], topic: Map<string, TopicMatch>): DateFinding {
  const inRange = (from: string, to: string) =>
    index.filter((record) => record.startedAt >= from && record.startedAt < to).sort(byTopic(topic));

  const finding: DateFinding = {
    text: date.text,
    label: date.label,
    from: date.from,
    to: date.to,
    recordIds: inRange(date.from, date.to).map((record) => record.id),
  };

  if (date.earlier !== undefined) {
    const earlierIds = inRange(date.earlier.from, date.earlier.to).map((record) => record.id);
    if (earlierIds.length > 0) finding.earlier = { label: date.earlier.label, recordIds: earlierIds };
  }

  if (finding.recordIds.length === 0) {
    const middle = (Date.parse(date.from) + Date.parse(date.to)) / 2;
    const nearest = index
      .filter((record) => topic.has(record.id))
      .sort((a, b) => Math.abs(Date.parse(a.startedAt) - middle) - Math.abs(Date.parse(b.startedAt) - middle))[0];
    if (nearest !== undefined) finding.nearestId = nearest.id;

    const starts = index.map((record) => record.startedAt).sort();
    const before = starts.filter((start) => start < date.from).at(-1);
    const after = starts.find((start) => start >= date.to);
    if (before !== undefined) finding.before = before;
    if (after !== undefined) finding.after = after;
  }

  return finding;
}

/** Topic matches scoring at least this share of the best one are in focus. */
const FOCUS_SHARE_OF_BEST = 0.5;
const MAX_TOPIC_FOCUS = 5;

/**
 * The records the question is about. A date in the question decides it;
 * without one, the strongest keyword matches do, so "the Acme discount"
 * brings both Acme calls but not every record that mentions a number.
 */
function chooseFocus(
  dates: DateFinding[],
  topic: Map<string, TopicMatch>,
  byId: Map<string, RecordSummary>,
): RecordSummary[] {
  const ids: string[] = [];
  if (dates.length > 0) {
    for (const date of dates) {
      ids.push(...(date.recordIds.length > 0 ? date.recordIds : date.nearestId === undefined ? [] : [date.nearestId]));
    }
  } else {
    const ranked = [...topic.entries()].sort((a, b) => a[1].score - b[1].score);
    const best = ranked[0]?.[1].score ?? 0;
    // bm25 scores are negative, so "at least half as good" means at most half the best.
    ids.push(
      ...ranked
        .filter(([, match]) => match.score <= best * FOCUS_SHARE_OF_BEST)
        .slice(0, MAX_TOPIC_FOCUS)
        .map(([id]) => id),
    );
  }
  return [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
}

/** Load order when not everything fits: the focus, then the week-earlier alternatives, then other keyword matches. */
function rankCandidates(
  dates: DateFinding[],
  topic: Map<string, TopicMatch>,
  focus: RecordSummary[],
  index: RecordSummary[],
): string[] {
  const ids = [
    ...focus.map((record) => record.id),
    ...dates.flatMap((date) => date.earlier?.recordIds ?? []),
    ...[...topic.entries()].sort((a, b) => a[1].score - b[1].score).map(([id]) => id),
  ];
  // Nothing matched at all ("summarise everything"): the most recent records.
  if (ids.length === 0) ids.push(...index.map((record) => record.id));
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Budget

function estimateTokens(size: RecordSize | undefined): number {
  if (size === undefined) return 0;
  return Math.ceil(size.chars / CHARS_PER_TOKEN) + size.segments * SEGMENT_OVERHEAD_TOKENS;
}

function segmentTokens(segment: Segment): number {
  return Math.ceil((segment.text.length + (segment.speaker?.length ?? 0)) / CHARS_PER_TOKEN) + SEGMENT_OVERHEAD_TOKENS;
}

/**
 * The parts of a long record that fit `budget`: each matching segment with
 * its neighbours, best match first, so the strongest context survives a
 * tight budget. With no match (found by date alone), the opening segments.
 */
function partialRecord(store: Store, record: MemoryRecord, query: string | null, budget: number): LoadedRecord | null {
  const hits = query === null ? [] : store.searchSegments(query, TOPIC_SEARCH_LIMIT, record.id);
  const seqOf = new Map(record.segments.map((segment) => [segment.id, segment.seq]));
  const chosen = new Set<number>();
  let used = 0;

  const add = (seq: number): boolean => {
    const segment = record.segments[seq];
    if (segment === undefined || chosen.has(seq)) return true;
    const cost = segmentTokens(segment);
    if (used + cost > budget) return false;
    chosen.add(seq);
    used += cost;
    return true;
  };

  for (const hit of hits) {
    const seq = seqOf.get(hit.segmentId);
    if (seq === undefined) continue;
    add(seq);
    for (let distance = 1; distance <= PARTIAL_NEIGHBOUR_SEGMENTS; distance += 1) {
      add(seq - distance);
      add(seq + distance);
    }
  }

  if (chosen.size === 0) {
    for (const segment of record.segments) {
      if (!add(segment.seq)) break;
    }
  }
  if (chosen.size === 0) return null;

  return {
    record: { ...record, segments: record.segments.filter((segment) => chosen.has(segment.seq)) },
    partial: true,
  };
}
