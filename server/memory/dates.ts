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

/** The calendar date `days` before today, as seen in `timeZone`. */
export function daysBefore(now: Date, days: number, timeZone: string): { year: number; month: number; day: number } {
  const today = partsInZone(now, timeZone);
  // Date.UTC rolls day 0 or -3 back into the previous month, which is the
  // calendar arithmetic we want. No time of day is involved, so no DST issue.
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day - days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
