// Turns an uploaded file (or the bundled sample) into records ready to store.
// Validation is all or nothing: one bad record rejects the whole file, so a
// user never ends up with half a history and no idea which half.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ImportResult, RecordType } from "../../shared/types.ts";
import { CHARS_PER_TOKEN, IMPORT_MAX_BYTES, RECORD_CONTEXT_BUDGET_TOKENS } from "../config.ts";
import {
  addDays,
  isValidTimeZone,
  mostRecentMonthDayBefore,
  mostRecentWeekdayBefore,
  partsInZone,
  todayIn,
  weekdayOfPreviousWeek,
  WEEKDAYS,
  zonedToUtc,
  type CalendarDate,
  type LocalDateTime,
} from "./dates.ts";
import type { InsertResult, NewRecord, NewSegment, Store } from "./store.ts";

export type ImportErrorCode = "too_large" | "invalid_json" | "empty" | "wrong_shape" | "invalid_timezone";

/** A file that cannot be imported. `message` is written for the user. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  /** Every problem found, when there is more than one. */
  readonly details: string[];

  constructor(code: ImportErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}

/** Validated records plus what the import summary needs to report. */
export interface PreparedImport {
  records: NewRecord[];
  /** Records whose timestamp had no offset and were read in the user's timezone. */
  assumedTimezone: number;
  /** Titles of records too long to fit the context budget whole. */
  longTitles: string[];
}

const MAX_TITLE_CHARS = 60;
const MAX_DETAILS = 10;

// ---------------------------------------------------------------------------
// Step 1: text to JSON

/** Shared with the API, which says the same when a request body is over its limit. */
export const TOO_LARGE_MESSAGE = `This file is over ${IMPORT_MAX_BYTES / 1024 / 1024} MB. Split it and upload the parts.`;

export function parseImportText(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > IMPORT_MAX_BYTES) {
    throw new ImportError("too_large", TOO_LARGE_MESSAGE);
  }
  // Editors on Windows often save JSON with a byte-order mark, which JSON.parse rejects.
  const body = text.replace(/^﻿/, "");
  if (body.trim() === "") {
    throw new ImportError("empty", "No records found in this file.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    const line = jsonErrorLine(body, error instanceof Error ? error.message : "");
    const where = line === null ? "" : ` (line ${line})`;
    throw new ImportError("invalid_json", `This file isn't valid JSON${where}.`);
  }
}

// V8 reports either "(line 3 column 5)" or "at position 42", or neither,
// depending on the error. Use whichever is there.
function jsonErrorLine(text: string, message: string): number | null {
  const lineMatch = /\(line (\d+) column \d+\)/.exec(message);
  if (lineMatch !== null) return Number(lineMatch[1]);
  const positionMatch = /at position (\d+)/.exec(message);
  if (positionMatch !== null) {
    return text.slice(0, Number(positionMatch[1])).split("\n").length;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2: shape

// Messages are phrased to follow the field name: "Record 3: title must be text."
const text = () => z.string({ error: "must be text" }).trim().min(1, { error: "can't be empty" });

const turnSchema = z.object(
  {
    speaker: text().optional(),
    text: text(),
    timestamp: z.string({ error: "must be text" }).optional(),
  },
  { error: "must be an object with speaker and text" },
);

const recordFields = {
  type: z.enum(["meeting", "chat", "note"], { error: 'must be "meeting", "chat" or "note"' }),
  title: text().optional(),
  participants: z.array(text(), { error: "must be a list of names" }).optional(),
  turns: z.array(turnSchema, { error: "must be a list" }).min(1, { error: "needs at least one turn" }).optional(),
  content: text().optional(),
};

const importRecordSchema = z.object(
  { ...recordFields, timestamp: z.string({ error: "must be text" }) },
  { error: "must be an object" },
);

// The sample is anchored to the calendar instead of fixed timestamps, so the
// questions it is built for work on whatever day it is loaded:
//   { "mostRecent": "monday" }            "On Monday we shortlisted..."
//   { "mostRecent": "thursday", "weeksEarlier": 1 }
//   { "previousWeek": "tuesday" }         "last Tuesday"
//   { "date": "11-03" }                   "on 3 November" (month-day)
const MIDNIGHT = { hour: 0, minute: 0, second: 0, millisecond: 0 };

const weekdaySchema = z.enum(WEEKDAYS,{ error: "must be a weekday in lower case, like monday" });

const anchorSchema = z.union(
  [
    z.object({ mostRecent: weekdaySchema, weeksEarlier: z.number().int().min(0).optional() }).strict(),
    z.object({ previousWeek: weekdaySchema }).strict(),
    z
      .object({
        date: z
          .string()
          .regex(/^\d{2}-\d{2}$/)
          // Checked against a non-leap year, so 29 February is refused: it would vanish three years in four.
          .refine((value) => isRealDateTime({ ...MIDNIGHT, year: 2025, ...monthDay(value) })),
      })
      .strict(),
  ],
  { error: 'must be { "mostRecent": weekday }, { "previousWeek": weekday } or { "date": "MM-DD" }' },
);

const sampleRecordSchema = z.object(
  {
    ...recordFields,
    id: z.string().regex(/^sample-[a-z0-9-]+$/, { error: 'must start with "sample-"' }),
    when: anchorSchema,
    time: z.string().regex(/^\d{2}:\d{2}$/, { error: "must look like 15:00" }),
  },
  { error: "must be an object" },
);

type Anchor = z.infer<typeof anchorSchema>;

function monthDay(value: string): { month: number; day: number } {
  return { month: Number(value.slice(0, 2)), day: Number(value.slice(3, 5)) };
}

const chatMessageSchema = z.object(
  {
    timestamp: z.string({ error: "must be text" }),
    role: text(),
    content: text(),
  },
  { error: "must be an object with timestamp, role and content" },
);

type ImportRecordInput = z.infer<typeof importRecordSchema>;
type ChatMessageInput = z.infer<typeof chatMessageSchema>;

// How a missing field is named in "Record 3 is missing a timestamp."
const MISSING_FIELD: { [field: string]: string } = {
  type: "a type",
  timestamp: "a timestamp",
  text: "its text",
  role: "a role",
  content: "its content",
  id: "an id",
  when: "a when",
  time: "a time",
};

// Accepts { records: [...] }, a bare array of records, or a chat export.
function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.records)) return value.records;
  throw new ImportError(
    "wrong_shape",
    'This file isn\'t in a format I can read. Expected a list of records, or an object with a "records" list.',
  );
}

// A chat export is a list of messages with a role, e.g. [{ timestamp, role, content }].
function isChatExport(items: unknown[]): boolean {
  const first = items[0];
  return isObject(first) && "role" in first && !("type" in first);
}

function validateItems<T>(items: unknown[], schema: z.ZodType<T>, noun: string): T[] {
  const result = z.array(schema).safeParse(items);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => describeIssue(issue, items, noun));
  throw shapeError(problems);
}

function describeIssue(issue: z.ZodError["issues"][number], items: unknown[], noun: string): string {
  const [index, field, turnIndex, turnField] = issue.path;
  if (typeof index !== "number") return issue.message;

  const item = items[index];
  let where = `${noun} ${index + 1}${titleSuffix(item)}`;
  if (field === undefined) return `${where} ${issue.message}.`;

  let name = String(field);
  let path: PropertyKey[] = [field];
  if (field === "turns" && typeof turnIndex === "number") {
    where += `, turn ${turnIndex + 1}`;
    if (turnField === undefined) return `${where} ${issue.message}.`;
    name = String(turnField);
    path = [field, turnIndex, turnField];
  }

  // Zod does not say whether the value was absent or wrong, so look it up.
  if (valueAt(item, path) === undefined) {
    return `${where} is missing ${MISSING_FIELD[name] ?? `"${name}"`}.`;
  }
  return `${where}: ${name} ${issue.message}.`;
}

function shapeError(problems: string[]): ImportError {
  const shown = problems.slice(0, MAX_DETAILS);
  if (problems.length > MAX_DETAILS) shown.push(`And ${problems.length - MAX_DETAILS} more.`);
  return new ImportError("wrong_shape", problems[0] ?? "This file isn't in a format I can read.", shown);
}

// ---------------------------------------------------------------------------
// Step 3: normalise

export function prepareImport(value: unknown, timezone: string): PreparedImport {
  if (!isValidTimeZone(timezone)) {
    throw new ImportError("invalid_timezone", `"${timezone}" isn't a timezone I recognise.`);
  }
  const items = listOf(value);
  if (items.length === 0) {
    throw new ImportError("empty", "No records found in this file.");
  }
  return isChatExport(items) ? prepareChatExport(items, timezone) : prepareRecords(items, timezone);
}

function prepareRecords(items: unknown[], timezone: string): PreparedImport {
  const inputs = validateItems(items, importRecordSchema, "Record");
  const problems: string[] = [];
  const prepared: PreparedImport = { records: [], assumedTimezone: 0, longTitles: [] };

  inputs.forEach((input, index) => {
    const where = `Record ${index + 1}${titleSuffix(input)}`;
    const record = normaliseRecord(input, timezone, where, problems);
    if (record === null) return;
    prepared.records.push(record.record);
    if (record.assumedTimezone) prepared.assumedTimezone += 1;
  });

  if (problems.length > 0) throw shapeError(problems);
  prepared.longTitles = longTitles(prepared.records);
  return prepared;
}

function normaliseRecord(
  input: ImportRecordInput,
  timezone: string,
  where: string,
  problems: string[],
): { record: NewRecord; assumedTimezone: boolean } | null {
  const started = parseTimestamp(input.timestamp, timezone);
  if (started === null) {
    problems.push(`${where}: timestamp ${unreadableTime(input.timestamp)}`);
    return null;
  }

  let segments: NewSegment[];
  if (input.turns !== undefined && input.content !== undefined) {
    problems.push(`${where} has both turns and content. Keep one.`);
    return null;
  } else if (input.turns !== undefined) {
    segments = [];
    let assumedInTurns = false;
    for (const [turnIndex, turn] of input.turns.entries()) {
      let ts: string | null = null;
      if (turn.timestamp !== undefined) {
        const parsed = parseTimestamp(turn.timestamp, timezone);
        if (parsed === null) {
          problems.push(`${where}, turn ${turnIndex + 1}: timestamp ${unreadableTime(turn.timestamp)}`);
          return null;
        }
        ts = parsed.instant.toISOString();
        assumedInTurns ||= parsed.assumed;
      }
      segments.push({ speaker: turn.speaker ?? null, text: turn.text, ts });
    }
    started.assumed ||= assumedInTurns;
  } else if (input.content !== undefined) {
    segments = splitContent(input.content);
  } else {
    problems.push(`${where} needs either turns or content.`);
    return null;
  }

  const startedAt = started.instant.toISOString();
  const title = input.title ?? shortTitle(segments[0]?.text ?? input.type);
  const participants = input.participants ?? speakersOf(segments);
  return {
    record: {
      type: input.type,
      title,
      startedAt,
      tz: started.zone,
      participants,
      source: "import",
      contentHash: contentHash(input.type, title, startedAt, participants, segments),
      segments,
    },
    assumedTimezone: started.assumed,
  };
}

// A chat export becomes one chat record per day in the user's timezone, so a
// question about "3 November" finds that day's messages, not the whole export.
// When it spans several days, every part carries the conversation's title and
// "part 1 of 2", so the records panel shows they belong together.
function prepareChatExport(items: unknown[], timezone: string): PreparedImport {
  const messages = validateItems(items, chatMessageSchema, "Message");
  const problems: string[] = [];
  const days = new Map<string, { message: ChatMessageInput; instant: Date }[]>();
  let assumedTimezone = false;

  messages.forEach((message, index) => {
    const parsed = parseTimestamp(message.timestamp, timezone);
    if (parsed === null) {
      problems.push(`Message ${index + 1}: timestamp ${unreadableTime(message.timestamp)}`);
      return;
    }
    assumedTimezone ||= parsed.assumed;
    const local = partsInZone(parsed.instant, timezone);
    const day = `${local.year}-${local.month}-${local.day}`;
    const list = days.get(day) ?? [];
    list.push({ message, instant: parsed.instant });
    days.set(day, list);
  });
  if (problems.length > 0) throw shapeError(problems);

  // Days in time order, whatever order the file listed the messages in.
  const parts = [...days.values()].map((dayMessages) =>
    dayMessages.sort((a, b) => a.instant.getTime() - b.instant.getTime()),
  );
  parts.sort((a, b) => (a[0]?.instant.getTime() ?? 0) - (b[0]?.instant.getTime() ?? 0));

  const firstUser = parts.flat().find(({ message }) => message.role === "user") ?? parts[0]?.[0];
  const conversationTitle = shortTitle(firstUser?.message.content ?? "Chat");

  const records: NewRecord[] = [];
  for (const [index, dayMessages] of parts.entries()) {
    const segments: NewSegment[] = dayMessages.map(({ message, instant }) => ({
      speaker: message.role,
      text: message.content,
      ts: instant.toISOString(),
    }));
    const title = parts.length === 1 ? conversationTitle : `${conversationTitle} (part ${index + 1} of ${parts.length})`;
    const startedAt = segments[0]?.ts ?? new Date(0).toISOString();
    records.push({
      type: "chat",
      title,
      startedAt,
      tz: timezone,
      participants: [],
      source: "import",
      contentHash: contentHash("chat", title, startedAt, [], segments),
      segments,
    });
  }

  return {
    records,
    // Counted per record, like the other formats: every day of this export was read the same way.
    assumedTimezone: assumedTimezone ? records.length : 0,
    longTitles: longTitles(records),
  };
}

// ---------------------------------------------------------------------------
// Timestamps

interface ParsedTimestamp {
  instant: Date;
  /** The offset written in the file, or the user's zone when there was none. */
  zone: string;
  /** True when the file gave no offset and the user's zone was assumed. */
  assumed: boolean;
}

// ISO 8601 date, optional time, optional offset. A space is accepted in place
// of the "T" because spreadsheet exports often write it that way.
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export function parseTimestamp(value: string, timezone: string): ParsedTimestamp | null {
  const match = ISO_TIMESTAMP.exec(value.trim());
  if (match === null) return null;

  const local: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0").slice(0, 3)),
  };
  if (!isRealDateTime(local)) return null;

  const offset = match[8];
  if (offset === undefined) {
    return { instant: zonedToUtc(local, timezone), zone: timezone, assumed: true };
  }

  const offsetMinutes = parseOffset(offset);
  if (offsetMinutes === null) return null;
  const wallClockAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond,
  );
  return {
    instant: new Date(wallClockAsUtc - offsetMinutes * 60_000),
    zone: offset.toUpperCase() === "Z" ? "UTC" : formatOffset(offsetMinutes),
    assumed: false,
  };
}

function parseOffset(offset: string): number | null {
  if (offset.toUpperCase() === "Z") return 0;
  const digits = offset.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  // Real offsets run from -12:00 to +14:00.
  if (minutes >= 60 || hours > 14) return null;
  const sign = offset.startsWith("-") ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  return `${sign}${hours}:${String(absolute % 60).padStart(2, "0")}`;
}

// Rejects dates the regex allows but the calendar does not, like 31 November.
function isRealDateTime(local: LocalDateTime): boolean {
  if (local.month < 1 || local.month > 12) return false;
  if (local.hour > 23 || local.minute > 59 || local.second > 59) return false;
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  return date.getUTCDate() === local.day && date.getUTCMonth() === local.month - 1;
}

function unreadableTime(value: string): string {
  return `"${value}" isn't a date I can read. Use ISO 8601, like 2026-11-09T15:00:00+05:30.`;
}

// ---------------------------------------------------------------------------
// Content

// "Name: text" at the start of a line. A colon must be followed by a space,
// so times (10:30) and links (https://) are not taken for speakers.
const SPEAKER_LINE = /^(\p{L}[^:\n]{0,59}):\s+(\S.*)$/u;

/**
 * Splits a single content string into segments. Speaker labels are used when
 * at least two lines have one; a note with a single "Decision:" line is more
 * likely prose than a transcript. Otherwise each paragraph is a segment.
 */
export function splitContent(content: string): NewSegment[] {
  const lines = content.split(/\r?\n/);
  const labelled = lines.filter((line) => SPEAKER_LINE.test(line.trim())).length;
  if (labelled >= 2) return splitOnSpeakers(lines);

  return content
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => ({ speaker: null, text: paragraph, ts: null }));
}

function splitOnSpeakers(lines: string[]): NewSegment[] {
  const segments: NewSegment[] = [];
  let current: NewSegment | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const match = SPEAKER_LINE.exec(line);
    if (match !== null) {
      current = { speaker: (match[1] ?? "").trim(), text: match[2] ?? "", ts: null };
      segments.push(current);
    } else if (line !== "") {
      if (current === null) {
        // Text before the first speaker label keeps no speaker.
        current = { speaker: null, text: line, ts: null };
        segments.push(current);
      } else {
        current.text += `\n${line}`;
      }
    }
  }
  return segments;
}

function speakersOf(segments: NewSegment[]): string[] {
  const speakers = new Set<string>();
  for (const segment of segments) {
    if (segment.speaker !== null) speakers.add(segment.speaker);
  }
  return [...speakers];
}

/** A title made in code from the first words of a message, never by a model. */
export function shortTitle(source: string): string {
  const flat = source.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TITLE_CHARS) return flat;
  const cut = flat.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Hashes the normalised record, so the same file imported twice is caught
// even if its whitespace or key order changed.
function contentHash(
  type: RecordType,
  title: string,
  startedAt: string,
  participants: string[],
  segments: NewSegment[],
): string {
  const canonical = JSON.stringify([
    type,
    title,
    startedAt,
    participants,
    segments.map((segment) => [segment.speaker, segment.text, segment.ts]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function longTitles(records: NewRecord[]): string[] {
  const budgetChars = RECORD_CONTEXT_BUDGET_TOKENS * CHARS_PER_TOKEN;
  return records
    .filter((record) => record.segments.reduce((sum, segment) => sum + segment.text.length, 0) > budgetChars)
    .map((record) => record.title);
}

// ---------------------------------------------------------------------------
// The sample

/**
 * Places the bundled sample on real dates relative to `now`, then validates it
 * like any file. Records keep their fixed ids and are marked as the sample.
 */
export function prepareSample(value: unknown, timezone: string, now: Date): PreparedImport {
  if (!isValidTimeZone(timezone)) {
    throw new ImportError("invalid_timezone", `"${timezone}" isn't a timezone I recognise.`);
  }
  const items = validateItems(listOf(value), sampleRecordSchema, "Sample record");
  const today = todayIn(now, timezone);
  const inputs = items.map(({ id: _id, when, time, ...rest }) => {
    const date = anchorDate(when, today);
    return { ...rest, timestamp: `${date.year}-${pad(date.month)}-${pad(date.day)}T${time}:00` };
  });

  const prepared = prepareImport({ records: inputs }, timezone);
  return {
    ...prepared,
    records: prepared.records.map((record, index) => ({ ...record, id: items[index]?.id, source: "sample" as const })),
    // The sample is meant to be read in the user's zone, so that is not worth a warning.
    assumedTimezone: 0,
  };
}

function anchorDate(anchor: Anchor, today: CalendarDate): CalendarDate {
  if ("mostRecent" in anchor) {
    return addDays(mostRecentWeekdayBefore(today, anchor.mostRecent), -7 * (anchor.weeksEarlier ?? 0));
  }
  if ("previousWeek" in anchor) {
    return weekdayOfPreviousWeek(today, anchor.previousWeek);
  }
  const { month, day } = monthDay(anchor.date);
  return mostRecentMonthDayBefore(today, month, day);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Step 4: store and report

export function importInto(store: Store, prepared: PreparedImport, timezone: string): ImportResult {
  return summarise(prepared, store.insertRecords(prepared.records), timezone);
}

/** Loads the sample in place of any earlier copy, so it never appears twice. */
export function loadSampleInto(store: Store, prepared: PreparedImport, timezone: string): ImportResult {
  return summarise(prepared, store.replaceSample(prepared.records), timezone);
}

function summarise(prepared: PreparedImport, { inserted, skipped }: InsertResult, timezone: string): ImportResult {
  const times = prepared.records.map((record) => record.startedAt).sort();

  const warnings: string[] = [];
  if (skipped > 0) {
    warnings.push(
      skipped === 1
        ? "1 record was already loaded and was skipped."
        : `${skipped} records were already loaded and were skipped.`,
    );
  }
  if (prepared.assumedTimezone > 0) {
    warnings.push(
      prepared.assumedTimezone === 1
        ? `1 record had no timezone. It was read as ${timezone}.`
        : `${prepared.assumedTimezone} records had no timezone. They were read as ${timezone}.`,
    );
  }
  for (const title of prepared.longTitles) {
    warnings.push(`"${title}" is too long to read in one go. Answers about it will use the parts that match the question.`);
  }

  return {
    imported: inserted,
    skipped,
    range: { from: times[0] ?? "", to: times[times.length - 1] ?? "" },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleSuffix(item: unknown): string {
  return isObject(item) && typeof item.title === "string" && item.title.trim() !== ""
    ? ` ("${shortTitle(item.title)}")`
    : "";
}

function valueAt(item: unknown, path: PropertyKey[]): unknown {
  let current: unknown = item;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === "number") current = current[key];
    else if (isObject(current) && typeof key === "string") current = current[key];
    else return undefined;
  }
  return current;
}
