// Calendar arithmetic in a named timezone, using only the built-in Intl API.
// The date-phrase resolver (build step 3) is added to this file.

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

/** The most recent `month`/`day` strictly before `today`: 3 November means last year's once it is 3 November again. */
export function mostRecentMonthDayBefore(today: CalendarDate, month: number, day: number): CalendarDate {
  const reachedThisYear = today.month > month || (today.month === month && today.day > day);
  return { year: reachedThisYear ? today.year : today.year - 1, month, day };
}
