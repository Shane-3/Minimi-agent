// The grounding check (REQUIREMENTS F15, F16): after an answer is written,
// code confirms that each figure, date and quote in it appears in what the
// model was given (the loaded records, the conversation, the question and
// the web sources), and marks it verified or unverified. It never calls a
// model and never changes the answer; it only labels it.
import type { Check, Evidence, MemoryRecord, ThreadMessage } from "../../shared/types.ts";
import {
  addDays,
  compareDates,
  mostRecentMonthDay,
  partsInZone,
  todayIn,
  weekdayIndex,
  type CalendarDate,
} from "../memory/dates.ts";
import type { Retrieval } from "../memory/retrieve.ts";

export interface GroundingInput {
  answer: string;
  question: string;
  retrieval: Retrieval;
  /** Earlier messages of this conversation, which the answer may quote. */
  history: ThreadMessage[];
  /** Pages the web searches returned. */
  evidence: Evidence[];
  timezone: string;
  now: Date;
}

// Tooltip wording for unverified items (FRONTEND.md, verification marks).
export const NOT_FOUND = "Not found in the sources I read";
export const WRONG_WEEKDAY = "The weekday does not match this date";
export const NOT_A_DATE = "This date does not exist";
export const BAD_ARITHMETIC = "The arithmetic does not add up";
export const QUOTE_NOT_FOUND = "These words are not in the record as quoted";
export const QUOTE_NOT_ON_PAGE = "These words are not in the page text I read";

// ---------------------------------------------------------------------------
// Text

/**
 * Typographic characters folded to plain ones, one for one, so offsets into
 * the answer stay the same: non-breaking and thin spaces, special hyphens
 * and dashes, curly quotes.
 */
export function plainChars(text: string): string {
  return text
    .replace(/[     ]/g, " ")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"');
}

/** For comparing quotes: plain characters, lower case, single spaces. */
function comparable(text: string): string {
  return plainChars(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/** Replaces a stretch of text with spaces, keeping every other offset where it was. */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end);
}

// ---------------------------------------------------------------------------
// Numbers

const NUMBER_WORDS: { [word: string]: number } = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100,
};

/** "9,600" and "9600.00" are the same value: compared as canonical numbers. */
function canonical(digits: string): string {
  return String(Number(digits.replace(/,/g, "")));
}

/** Every value written in the text, as digits or as a number word. */
function numbersIn(text: string): Set<string> {
  const values = new Set<string>();
  for (const match of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) values.add(canonical(match[0]));
  for (const match of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    const value = NUMBER_WORDS[match[0]];
    if (value !== undefined) values.add(String(value));
  }
  return values;
}

// A figure in the answer: an optional currency sign, then digits. Not
// preceded by a letter or digit, so "Q4" and "v18" are left alone.
const FIGURE = /(?<![\p{L}\d.])(?:[$€£₹]\s?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu;

// ---------------------------------------------------------------------------
// Dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Whole names or their usual short forms only, so "Decisions" or "Monitoring"
// is not read as a month or a weekday.
const MONTH =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const WEEKDAY =
  "(Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:r(?:s(?:day)?)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\\.?,?";
// Spaces inside a date stay on one line: "Decisions\n\n1." is a heading and a list.
const GAP = "[ \\t]+";

// "Mon 9 Nov", "9 November 2026", "Nov 9, 2026", "2026-11-09".
const DAY_MONTH = new RegExp(`\\b(?:${WEEKDAY}${GAP})?(\\d{1,2})(?:st|nd|rd|th)?${GAP}${MONTH}(?:,?${GAP}(\\d{4}))?\\b`, "gi");
const MONTH_DAY = new RegExp(`\\b(?:${WEEKDAY}${GAP})?${MONTH}${GAP}(\\d{1,2})(?:st|nd|rd|th)?(?:,?${GAP}(\\d{4}))?\\b`, "gi");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

interface FoundDate {
  start: number;
  end: number;
  text: string;
  weekday: number | null;
  day: number;
  month: number;
  year: number | null;
}

function datesIn(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const weekdayOf = (name: string | undefined) => (name === undefined ? null : DAYS.indexOf(name.slice(0, 3).toLowerCase()));
  const monthOf = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  for (const match of text.matchAll(DAY_MONTH)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      weekday: weekdayOf(match[1]),
      day: Number(match[2]),
      month: monthOf(match[3]!),
      year: match[4] === undefined ? null : Number(match[4]),
    });
  }
  for (const match of text.matchAll(MONTH_DAY)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      weekday: weekdayOf(match[1]),
      day: Number(match[3]),
      month: monthOf(match[2]!),
      year: match[4] === undefined ? null : Number(match[4]),
    });
  }
  for (const match of text.matchAll(ISO_DATE)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      weekday: null,
      day: Number(match[3]),
      month: Number(match[2]),
      year: Number(match[1]),
    });
  }
  // Where two patterns matched overlapping text, keep the longer.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter((date, index) => index === 0 || date.start >= found[index - 1]!.end);
}

const dayKey = (date: CalendarDate) =>
  `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
const monthDayKey = (month: number, day: number) => `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

function isRealDate(date: CalendarDate): boolean {
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCMonth() === date.month - 1 && check.getUTCDate() === date.day;
}

// ---------------------------------------------------------------------------
// What the answer may draw on

interface Corpus {
  /** Every value written anywhere in the records, conversation, question or sources. */
  numbers: Set<string>;
  /** Days known to be true: record days, the question's dates, today, source dates, dates in the text. */
  days: Set<string>;
  /** The same days without the year, for answers that write "9 Nov". */
  monthDays: Set<string>;
  /** Everything said, by whom, for checking quotes. A web page "speaks" as its site. */
  segments: { speaker: string; text: string; page: boolean }[];
}

function buildCorpus(input: GroundingInput): Corpus {
  const { retrieval, history, evidence, question, timezone, now } = input;
  const texts: string[] = [question];
  const segments: Corpus["segments"] = [];

  const loaded: MemoryRecord[] = retrieval.loaded.map((loaded) => loaded.record);
  for (const record of loaded) {
    texts.push(record.title, record.participants.join(", "));
    for (const segment of record.segments) {
      texts.push(segment.text);
      segments.push({ speaker: segment.speaker ?? "", text: segment.text, page: false });
    }
  }
  for (const message of history) {
    texts.push(message.text);
    segments.push({ speaker: message.role, text: message.text, page: false });
  }
  for (const page of evidence) {
    texts.push(page.title, page.snippet);
    segments.push({ speaker: page.site, text: `${page.title}\n${page.snippet}`, page: true });
  }
  const corpusText = plainChars(texts.join("\n"));

  const days = new Set<string>();
  const monthDays = new Set<string>();
  const addDay = (date: CalendarDate) => {
    days.add(dayKey(date));
    monthDays.add(monthDayKey(date.month, date.day));
  };
  const dayOf = (iso: string): CalendarDate => {
    const { year, month, day } = partsInZone(new Date(iso), timezone);
    return { year, month, day };
  };

  addDay(todayIn(now, timezone));
  for (const record of retrieval.index) addDay(dayOf(record.startedAt));
  for (const message of history) if (message.ts !== null) addDay(dayOf(message.ts));
  for (const page of evidence) {
    if (page.publishedDate !== null) {
      const [year, month, day] = page.publishedDate.split("-").map(Number);
      addDay({ year: year!, month: month!, day: day! });
    }
  }
  // Every day a date phrase in the question covers ("last week" is seven).
  // At most 62 days, so "last year" cannot vouch for every day of a year.
  for (const finding of retrieval.dates) {
    const last = dayOf(new Date(Date.parse(finding.to) - 1).toISOString());
    for (let day = dayOf(finding.from), steps = 0; compareDates(day, last) <= 0 && steps < 62; day = addDays(day, 1), steps += 1) {
      addDay(day);
    }
  }
  // "I'll send it by Monday" said on Thu 12 Nov vouches for Mon 16 Nov. A
  // weekday alone could mean the last one or the next one, so both count.
  for (const record of loaded) {
    for (const segment of record.segments) addNamedDays(segment.text, dayOf(segment.ts ?? record.startedAt), addDay);
  }
  for (const message of history) if (message.ts !== null) addNamedDays(message.text, dayOf(message.ts), addDay);
  for (const date of datesIn(corpusText)) {
    if (date.year !== null) days.add(dayKey({ year: date.year, month: date.month, day: date.day }));
    monthDays.add(monthDayKey(date.month, date.day));
  }

  return { numbers: numbersIn(corpusText), days, monthDays, segments };
}

const NAMED_DAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|yesterday)\b/g;
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Adds the days that "Monday", "tomorrow" or "yesterday" in `text` can mean, said on `said`. */
function addNamedDays(text: string, said: CalendarDate, addDay: (date: CalendarDate) => void): void {
  for (const match of text.toLowerCase().matchAll(NAMED_DAY)) {
    const word = match[1]!;
    if (word === "tomorrow") addDay(addDays(said, 1));
    else if (word === "yesterday") addDay(addDays(said, -1));
    else {
      const ahead = (WEEKDAY_NAMES.indexOf(word) - weekdayIndex(said) + 7) % 7 || 7;
      addDay(addDays(said, ahead));
      addDay(addDays(said, ahead - 7));
    }
  }
}

// ---------------------------------------------------------------------------
// The check

export function checkAnswer(input: GroundingInput): Check[] {
  const corpus = buildCorpus(input);
  const checks: Check[] = [];
  let text = plainChars(input.answer);
  const today = todayIn(input.now, input.timezone);

  // Link addresses are not figures or dates.
  for (const match of text.matchAll(/\]\(([^)\s]+)\)|https?:\/\/[^\s)]+/g)) text = blank(text, match.index, match.index + match[0].length);

  // Quotes first: their words are checked as a whole, not number by number.
  for (const quote of quotesIn(text)) {
    checks.push(checkQuote(quote, corpus));
    text = blank(text, quote.start, quote.start + quote.text.length);
  }

  // Before the dates are blanked, since a count is checked against them.
  for (const count of dayCountsIn(text, today)) {
    checks.push(count);
    text = blank(text, count.start, count.start + count.text.length);
  }

  for (const date of datesIn(text)) {
    checks.push(checkDate(date, corpus, today));
    text = blank(text, date.start, date.end);
  }

  // Not figures: clock times, years on their own, and list numbering.
  for (const pattern of [/\b\d{1,2}:\d{2}\b/g, /\b(?:19|20)\d{2}\b/g, /^[ \t]*\d+[.)][ \t]/gm]) {
    for (const match of text.matchAll(pattern)) text = blank(text, match.index, match.index + match[0].length);
  }

  // Shown arithmetic (F16): the result is checked by doing the sum.
  for (const sum of sumsIn(text)) {
    checks.push(sum.check);
    text = blank(text, sum.resultStart, sum.resultEnd);
  }

  for (const match of text.matchAll(FIGURE)) {
    const value = canonical(match[0].replace(/^[$€£₹]\s?/, ""));
    const verified = corpus.numbers.has(value);
    checks.push({ kind: "figure", text: match[0], start: match.index, verified, ...(verified ? {} : { reason: NOT_FOUND }) });
  }

  // The marks are shown in reading order.
  return checks.sort((a, b) => a.start - b.start);
}

/**
 * The calendar day a date in the answer means, or null when no such day
 * exists. With no year written, an answer can mean the most recent such day
 * or the next one ("onboarding starts Mon 16 Nov"), so take whichever fits
 * the weekday.
 */
function calendarOf(date: FoundDate, today: CalendarDate): CalendarDate | null {
  const recent = mostRecentMonthDay(today, date.month, date.day).year;
  const years = date.year !== null ? [date.year] : [recent, recent + 1];
  const real = years
    .map((year) => ({ year, month: date.month, day: date.day }))
    .filter((candidate) => isRealDate(candidate));
  return real.find((candidate) => date.weekday === null || date.weekday === weekdayIndex(candidate)) ?? real[0] ?? null;
}

function checkDate(date: FoundDate, corpus: Corpus, today: CalendarDate): Check {
  const base = { kind: "date" as const, text: date.text, start: date.start };
  const calendar = calendarOf(date, today);
  if (calendar === null) return { ...base, verified: false, reason: NOT_A_DATE };
  if (date.weekday !== null && date.weekday !== weekdayIndex(calendar)) {
    return { ...base, verified: false, reason: WRONG_WEEKDAY };
  }
  const known = date.year === null ? corpus.monthDays.has(monthDayKey(date.month, date.day)) : corpus.days.has(dayKey(calendar));
  return known ? { ...base, verified: true } : { ...base, verified: false, reason: NOT_FOUND };
}

// ---------------------------------------------------------------------------
// Day counts: "Mon 19 Oct, four days after Thu 15 Oct"

// A count tied to a relation between two days. "Within five weeks" is not
// one, so it is left to the figure check.
const DAY_COUNT = new RegExp(
  String.raw`\b(\d+|${Object.keys(NUMBER_WORDS).join("|")})[ \t]+(days?|weeks?)[ \t]+(?:after|before|later|earlier|from|since|until|ahead of|behind)\b`,
  "gi",
);

/** The sentence around [from, to): up to the nearest line break or sentence end either side. */
function sentenceAround(text: string, from: number, to: number): string {
  const before = text.slice(0, from);
  const start = Math.max(before.lastIndexOf("\n"), ...[". ", "! ", "? "].map((end) => before.lastIndexOf(end) + 1)) + 1;
  const after = text.slice(to);
  const ends = ["\n", ". ", "! ", "? "].map((end) => after.indexOf(end)).filter((index) => index >= 0);
  return text.slice(start, ends.length === 0 ? text.length : to + Math.min(...ends) + 1);
}

/**
 * Counts of days between the two dates of a sentence, checked by working the
 * gap out. A count in a sentence without exactly two dates is not checked here.
 */
function dayCountsIn(text: string, today: CalendarDate): Check[] {
  const checks: Check[] = [];
  for (const match of text.matchAll(DAY_COUNT)) {
    const dates = datesIn(sentenceAround(text, match.index, match.index + match[0].length))
      .map((date) => calendarOf(date, today))
      .filter((date): date is CalendarDate => date !== null);
    if (dates.length !== 2) continue;
    const [a, b] = dates as [CalendarDate, CalendarDate];
    const gap = Math.abs(Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / 86_400_000;
    const word = match[1]!.toLowerCase();
    const count = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]!;
    const claimed = match[2]!.toLowerCase().startsWith("week") ? count * 7 : count;
    const phrase = `${match[1]} ${match[2]}`;
    checks.push({
      kind: "figure",
      text: phrase,
      start: match.index,
      verified: claimed === gap,
      ...(claimed === gap ? {} : { reason: `These dates are ${gap} ${gap === 1 ? "day" : "days"} apart` }),
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Quotes: > **Speaker:** "words"

interface Quote {
  /** The quoted words, without the quotation marks. */
  text: string;
  start: number;
  /** The speaker label as written, e.g. "Meera (CRM shortlist review, Mon 9 Nov)". */
  label: string;
}

function quotesIn(text: string): Quote[] {
  const quotes: Quote[] = [];
  for (const line of text.matchAll(/^[ \t]*>[ \t]*\*\*([^*\n]+?)\*\*[ \t]*:?[ \t]*(.*)$/gm)) {
    const label = line[1]!.replace(/:\s*$/, "").trim();
    const rest = line[2] ?? "";
    const restStart = line.index + line[0].length - rest.length;
    const marked = [...rest.matchAll(/"([^"\n]+)"/g)];
    if (marked.length > 0) {
      for (const match of marked) quotes.push({ text: match[1]!, start: restStart + match.index + 1, label });
    } else if (rest.trim() !== "") {
      // A quote written without quotation marks: the whole line is the quote.
      const leading = rest.length - rest.trimStart().length;
      quotes.push({ text: rest.trim(), start: restStart + leading, label });
    }
  }
  return quotes;
}

// How the answer may name the people in a chat record.
const SPEAKER_ALIASES: { [written: string]: string } = { you: "user", user: "user", me: "user", assistant: "assistant", "minimi-agent": "assistant" };

/**
 * The speakers a label could mean: the label as written, or without its
 * trailing "(context)". A web page is named by its site, with or without "www.".
 */
function speakerCandidates(label: string): string[] {
  const full = label.toLowerCase().replace(/^www\./, "");
  const short = full.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return [...new Set([full, short, SPEAKER_ALIASES[full] ?? "", SPEAKER_ALIASES[short] ?? ""])].filter((name) => name !== "");
}

function checkQuote(quote: Quote, corpus: Corpus): Check {
  const base = { kind: "quote" as const, text: quote.text, start: quote.start };
  // A quote may be cut with "..."; each piece must appear as written.
  const pieces = quote.text
    .split(/\s*(?:\.{3}|…)\s*/)
    .map((piece) => comparable(piece).replace(/^[\s.,;:!?'"-]+|[\s.,;:!?'"-]+$/g, ""))
    .filter((piece) => piece.length >= 3);
  if (pieces.length === 0) return { ...base, verified: true };

  const said = (segment: { text: string }) => pieces.every((piece) => comparable(segment.text).includes(piece));
  const candidates = speakerCandidates(quote.label);
  const bySpeaker = corpus.segments.filter((segment) => candidates.includes(segment.speaker.toLowerCase()));
  if (bySpeaker.some(said)) return { ...base, verified: true };

  const elsewhere = corpus.segments.find(said);
  if (elsewhere !== undefined && elsewhere.speaker !== "") {
    const reason = elsewhere.page
      ? `These words are from ${elsewhere.speaker}`
      : `In the record, ${displayName(elsewhere.speaker)} said this`;
    return { ...base, verified: false, reason };
  }
  const fromPage = bySpeaker.length > 0 && bySpeaker.every((segment) => segment.page);
  return { ...base, verified: false, reason: fromPage ? QUOTE_NOT_ON_PAGE : QUOTE_NOT_FOUND };
}

function displayName(speaker: string): string {
  if (speaker === "user") return "you";
  if (speaker === "assistant") return "the assistant";
  return speaker;
}

// ---------------------------------------------------------------------------
// Arithmetic: "40 + 15 = 55", "0.318 × 730 ≈ 232.14"

function sumsIn(text: string): { check: Check; resultStart: number; resultEnd: number }[] {
  const sums: { check: Check; resultStart: number; resultEnd: number }[] = [];
  // Amounts may carry a currency sign ("12 × $14 = $168"), and answers often
  // put the result in bold ("= **$168**").
  const number = String.raw`\d[\d,]*(?:\.\d+)?`;
  const currency = String.raw`(?:[$€£₹]\s?)?`;
  const pattern = new RegExp(
    String.raw`${currency}(${number})\s*([+\-×x*/÷])\s*${currency}(${number})\s*(?:=|≈|~)\s*(?:\*\*|__)?(${currency}${number})`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const left = Number(match[1]!.replace(/,/g, ""));
    const right = Number(match[3]!.replace(/,/g, ""));
    const resultText = match[4]!;
    const result = Number(resultText.replace(/^[$€£₹]\s?/, "").replace(/,/g, ""));
    const operator = match[2]!;
    const worked =
      operator === "+" ? left + right
      : operator === "-" ? left - right
      : operator === "/" || operator === "÷" ? left / right
      : left * right;
    // Rounded results ("≈ 232.14") are allowed half a percent, or a cent.
    const correct = Math.abs(worked - result) <= Math.max(0.01, Math.abs(result) * 0.005);
    const resultStart = match.index + match[0].length - resultText.length;
    sums.push({
      check: {
        kind: "figure",
        text: resultText,
        start: resultStart,
        verified: correct,
        ...(correct ? {} : { reason: BAD_ARITHMETIC }),
      },
      resultStart,
      resultEnd: resultStart + resultText.length,
    });
  }
  return sums;
}
