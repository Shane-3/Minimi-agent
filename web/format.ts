// Dates as the interface shows them: "Mon 9 Nov", in the user's timezone (U10).

/** The browser's IANA timezone, sent with every question and import. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Mon 9 Nov". */
export function dayLabel(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).formatToParts(
    new Date(iso),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
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
