// Dates as the interface shows them: "Mon 9 Nov", in the user's timezone (U10).

/** The browser's IANA timezone, sent with every question and import. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Fixed names, as the server writes them in answers: browsers differ (some
// write "Sept"), and a chip must match the answer beside it.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar day of an instant in a timezone. */
function calendarDay(iso: string, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", timeZone }).formatToParts(
    new Date(iso),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** "Mon 9 Nov", or "Mon 9 Nov 2025" with `withYear`. */
export function dayLabel(iso: string, timeZone: string, withYear = false): string {
  const { year, month, day } = calendarDay(iso, timeZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const label = `${weekday} ${day} ${MONTHS[month - 1]}`;
  return withYear ? `${label} ${year}` : label;
}

/** "09:30", 24-hour. */
export function timeLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(iso));
}

/** "Mon 2 Nov to Tue 10 Nov", or one day when both ends fall on it. */
export function rangeLabel(from: string, to: string, timeZone: string): string {
  const first = dayLabel(from, timeZone);
  const last = dayLabel(to, timeZone);
  return first === last ? first : `${first} to ${last}`;
}

/** "1 record", "4 records". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? singular : plural}`;
}
