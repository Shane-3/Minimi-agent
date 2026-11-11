// Dates in the user's timezone: calendar arithmetic with the built-in Intl
// API, and the resolver that turns "last Tuesday" into a range of days.
// Models are unreliable at weekday arithmetic, so this is done in code.
import * as chrono from "chrono-node";

/** A wall-clock date and time with no zone attached. Month is 1 to 12. */
export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // h23 so midnight is 00, not 24.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** What a wall clock in `timeZone` shows at `instant`. */
export function partsInZone(instant: Date, timeZone: string): LocalDateTime {
  const values: { [part: string]: number } = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
    millisecond: instant.getUTCMilliseconds(),
  };
}

/** Minutes the zone is ahead of UTC at that instant (+330 for Asia/Kolkata). */
function offsetMinutes(instant: number, timeZone: string): number {
  const p = partsInZone(new Date(instant), timeZone);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
  return Math.round((wallClockAsUtc - instant) / 60_000);
}

/**
 * The instant at which a wall clock in `timeZone` shows `local`.
 *
 * The offset depends on the instant we are looking for, so it is guessed from
 * the wall-clock time read as UTC and then checked once. The second pass fixes
 * the guess when a daylight-saving change falls between the two.
 */
export function zonedToUtc(local: LocalDateTime, timeZone: string): Date {
  const wallClockAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    local.millisecond,
  );
  const firstOffset = offsetMinutes(wallClockAsUtc, timeZone);
  let instant = wallClockAsUtc - firstOffset * 60_000;
  const secondOffset = offsetMinutes(instant, timeZone);
  if (secondOffset !== firstOffset) {
    instant = wallClockAsUtc - secondOffset * 60_000;
  }
  return new Date(instant);
}

// ---------------------------------------------------------------------------
// Calendar dates. These carry no time of day, so daylight saving never
// affects them; the timezone matters only when deciding what "today" is.

/** A day on the calendar. Month is 1 to 12. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Today's date as seen in `timeZone`. */
export function todayIn(now: Date, timeZone: string): CalendarDate {
  const { year, month, day } = partsInZone(now, timeZone);
  return { year, month, day };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  // Date.UTC rolls day 0 or day 35 into the next or previous month, which is
  // exactly the calendar arithmetic needed.
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** 0 for Sunday through 6 for Saturday. */
export function weekdayIndex(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The most recent `weekday` strictly before `today`. On a Monday, the most recent Monday is a week ago. */
export function mostRecentWeekdayBefore(today: CalendarDate, weekday: Weekday): CalendarDate {
  const back = (weekdayIndex(today) - WEEKDAYS.indexOf(weekday) + 7) % 7 || 7;
  return addDays(today, -back);
}

/**
 * `weekday` in the week before the current one. Weeks run Monday to Sunday,
 * so on Wednesday 11 November the previous week is 2 to 8 November.
 */
export function weekdayOfPreviousWeek(today: CalendarDate, weekday: Weekday): CalendarDate {
  const daysSinceMonday = (weekdayIndex(today) + 6) % 7;
  const daysFromMonday = (WEEKDAYS.indexOf(weekday) + 6) % 7;
  return addDays(today, -daysSinceMonday - 7 + daysFromMonday);
}

/**
 * The most recent `month`/`day` on or before `today`. On 3 November, "3
 * November" means today; on 2 November it means last year's.
 */
export function mostRecentMonthDay(today: CalendarDate, month: number, day: number): CalendarDate {
  const reachedThisYear = today.month > month || (today.month === month && today.day >= day);
  return { year: reachedThisYear ? today.year : today.year - 1, month, day };
}

/** Monday of the week `date` is in. Weeks run Monday to Sunday. */
export function mondayOf(date: CalendarDate): CalendarDate {
  return addDays(date, -((weekdayIndex(date) + 6) % 7));
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** The last day of the month `date` is in. */
function endOfMonth(date: CalendarDate): CalendarDate {
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(date.year, date.month, 0));
  return { year: date.year, month: date.month, day: last.getUTCDate() };
}

// ---------------------------------------------------------------------------
// Resolving date phrases

/** A run of whole days in the user's timezone. */
export interface DayRange {
  /** First and last day covered, both included. */
  start: CalendarDate;
  end: CalendarDate;
  /** Start of the first day and start of the day after the last, as ISO 8601 UTC. A record is in range when from <= startedAt < to. */
  from: string;
  to: string;
  /** For people and prompts, e.g. "Tue 3 Nov" or "Mon 2 Nov to Sun 8 Nov". */
  label: string;
}

export interface ResolvedDate extends DayRange {
  /** The words in the message, e.g. "last Tuesday". */
  text: string;
  /**
   * For a bare weekday ("on Monday"): the same weekday a week earlier. The
   * most recent one is used, and the answer names this one if it also has
   * records ("Monday two weeks running").
   */
  earlier?: DayRange;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon 9 Nov", with the year added when it is not the current one. */
export function formatDay(date: CalendarDate, today: CalendarDate): string {
  const base = `${DAY_NAMES[weekdayIndex(date)]} ${date.day} ${MONTH_NAMES[date.month - 1]}`;
  return date.year === today.year ? base : `${base} ${date.year}`;
}

function dayRange(start: CalendarDate, end: CalendarDate, today: CalendarDate, timeZone: string): DayRange {
  const startOfDay = (date: CalendarDate) => zonedToUtc({ ...date, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
  const label =
    compareDates(start, end) === 0 ? formatDay(start, today) : `${formatDay(start, today)} to ${formatDay(end, today)}`;
  return {
    start,
    end,
    from: startOfDay(start).toISOString(),
    to: startOfDay(addDays(end, 1)).toISOString(),
    label,
  };
}

// chrono numbers weekdays 0 (Sunday) to 6, like Date.getDay().
const PREVIOUS = /\b(last|past|previous)\b/i;
const THIS = /\bthis\b/i;
const NEXT = /\bnext\b/i;
const AGO = /\bago\b/i;
const UNIT = /\b(day|week|month|year)s?\b/i;

/**
 * Finds the date phrases in a message and turns each into a range of days in
 * the user's timezone. Phrases that point to the future, or are ambiguous
 * like "3/11" (3 November or 11 March), are left out rather than guessed.
 *
 * The rules, for a message sent on Wednesday 11 November:
 * - "Monday": the most recent Monday before today (9 Nov), and the one before it (2 Nov) as `earlier`.
 *   On a Monday, "Monday" means a week ago: today is called "today".
 * - "last Tuesday": Tuesday of the previous week (3 Nov). Weeks run Monday to Sunday.
 * - "this Monday": Monday of the current week.
 * - "yesterday", "today", "3 days ago": that day.
 * - "3 November": the most recent 3 November on or before today. With a year, that exact day.
 * - "two weeks ago": the whole week that was two weeks ago (26 Oct to 1 Nov).
 * - "two months ago", "last month", "last year": the whole month or year.
 * - "last week", "this week", "this month": the whole previous week, or the current one up to today.
 */
export function resolveDates(message: string, timeZone: string, now: Date): ResolvedDate[] {
  const today = todayIn(now, timeZone);
  // chrono reads dates in the server's timezone. Giving it the user's
  // calendar date at noon, as a server-local time, makes its "today" the
  // user's today. Only calendar days are read back from it, never instants.
  const reference = new Date(today.year, today.month - 1, today.day, 12, 0, 0);

  const resolved: ResolvedDate[] = [];
  for (const result of chrono.parse(message, reference)) {
    const range = rangeFor(result, today);
    if (range === null) continue;
    const resolvedDate: ResolvedDate = { text: result.text, ...dayRange(range.start, range.end, today, timeZone) };
    if (range.earlier !== undefined) {
      resolvedDate.earlier = dayRange(range.earlier, range.earlier, today, timeZone);
    }
    resolved.push(resolvedDate);
  }
  return resolved;
}

interface CalendarRange {
  start: CalendarDate;
  end: CalendarDate;
  earlier?: CalendarDate;
}

function rangeFor(result: chrono.ParsedResult, today: CalendarDate): CalendarRange | null {
  // Numeric dates like 3/11 mean 3 November in India and 11 March in the US.
  if (result.tags().has("parser/SlashDateFormatParser")) return null;
  if (NEXT.test(result.text)) return null;

  const start = componentRange(result.start, result.text, today);
  if (start === null) return null;
  if (result.end === undefined || result.end === null) return start;

  // "from 2 to 5 November": one range from the start of the first to the end of the second.
  const end = componentRange(result.end, result.text, today);
  if (end === null) return start;
  return { start: start.start, end: end.end };
}

function componentRange(
  components: chrono.ParsedComponents,
  text: string,
  today: CalendarDate,
): CalendarRange | null {
  const certain = (key: chrono.Component) => components.isCertain(key);
  const unit = UNIT.exec(text)?.[1]?.toLowerCase();

  // A weekday on its own: "Monday", "last Tuesday", "this Friday".
  if (certain("weekday") && !certain("day")) {
    const weekday = WEEKDAYS[components.get("weekday") ?? 0] ?? "monday";
    if (PREVIOUS.test(text)) {
      const day = weekdayOfPreviousWeek(today, weekday);
      return { start: day, end: day };
    }
    if (THIS.test(text)) {
      const day = addDays(mondayOf(today), (WEEKDAYS.indexOf(weekday) + 6) % 7);
      return compareDates(day, today) > 0 ? null : { start: day, end: day };
    }
    const day = mostRecentWeekdayBefore(today, weekday);
    return { start: day, end: day, earlier: addDays(day, -7) };
  }

  // "two weeks ago", "last month", "this week".
  if (unit !== undefined && unit !== "day" && (AGO.test(text) || PREVIOUS.test(text) || THIS.test(text))) {
    if (THIS.test(text)) return periodContaining(today, unit, today);
    // For "ago", chrono has already counted back; for "last", step back one unit.
    const anchor = AGO.test(text) ? dateOf(components) : stepBack(today, unit);
    return anchor === null ? null : periodContaining(anchor, unit, today);
  }

  // A full date: "yesterday", "3 days ago", "3 November 2026".
  if (certain("day") && certain("month") && certain("year")) {
    const day = dateOf(components);
    return day === null || compareDates(day, today) > 0 ? null : { start: day, end: day };
  }

  // A day and month with no year: the most recent one.
  if (certain("day") && certain("month")) {
    const day = mostRecentMonthDay(today, components.get("month") ?? 1, components.get("day") ?? 1);
    return isRealDate(day) ? { start: day, end: day } : null;
  }

  // A month on its own ("in October"): the most recent one, up to today.
  if (certain("month") && !certain("day")) {
    const month = components.get("month") ?? 1;
    const year = certain("year") ? (components.get("year") ?? today.year) : month > today.month ? today.year - 1 : today.year;
    return periodContaining({ year, month, day: 1 }, "month", today);
  }

  // A time with no date ("at 3pm") says nothing about which day.
  return null;
}

function dateOf(components: chrono.ParsedComponents): CalendarDate | null {
  const year = components.get("year");
  const month = components.get("month");
  const day = components.get("day");
  if (year === null || month === null || day === null) return null;
  return { year, month, day };
}

function stepBack(today: CalendarDate, unit: string): CalendarDate {
  if (unit === "week") return addDays(today, -7);
  if (unit === "month") return { year: today.month === 1 ? today.year - 1 : today.year, month: today.month === 1 ? 12 : today.month - 1, day: 1 };
  return { year: today.year - 1, month: 1, day: 1 };
}

/** The whole week, month or year containing `date`, cut off at today. */
function periodContaining(date: CalendarDate, unit: string, today: CalendarDate): CalendarRange | null {
  let start: CalendarDate;
  let end: CalendarDate;
  if (unit === "week") {
    start = mondayOf(date);
    end = addDays(start, 6);
  } else if (unit === "month") {
    start = { year: date.year, month: date.month, day: 1 };
    end = endOfMonth(date);
  } else if (unit === "year") {
    start = { year: date.year, month: 1, day: 1 };
    end = { year: date.year, month: 12, day: 31 };
  } else {
    start = date;
    end = date;
  }
  if (compareDates(start, today) > 0) return null;
  return { start, end: compareDates(end, today) > 0 ? today : end };
}

// 31 November parses as a day and a month, but is not on the calendar.
function isRealDate(date: CalendarDate): boolean {
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCMonth() === date.month - 1 && check.getUTCDate() === date.day;
}
