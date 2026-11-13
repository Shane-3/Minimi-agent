// Deterministic checks for eval answers. An LLM judge would be a second model
// call site (AGENTS.md rule 3), so each expectation is written as text the
// answer must or must not contain.

export interface Check {
  name: string;
  pass: (answer: string) => boolean;
}

/**
 * Some models write typographic characters where the records have plain
 * ones: non-breaking or thin spaces ("3\u202fNov"), non-breaking hyphens
 * ("12\u2011month") and curly quotes. They read the same, so every check
 * reads them as their plain forms.
 */
function plain(answer: string): string {
  return answer
    .replace(/[\u00a0\u2007\u2009\u200a\u202f]/g, " ")
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

export function contains(name: string, pattern: RegExp): Check {
  return { name, pass: (answer) => pattern.test(plain(answer)) };
}

export function lacks(name: string, pattern: RegExp): Check {
  return { name, pass: (answer) => !pattern.test(plain(answer)) };
}

/**
 * Both appear, and `first` is mentioned before the last mention of `second`.
 * The last mention, because a correct timeline may open by naming the latest
 * day ("the latest was on 5 Nov") before listing the days oldest first.
 */
export function inOrder(name: string, first: string, second: string): Check {
  return {
    name,
    pass: (raw) => {
      const answer = plain(raw);
      const a = answer.indexOf(first);
      const b = answer.lastIndexOf(second);
      return a !== -1 && b !== -1 && a < b;
    },
  };
}

/** Every pattern matches within `distance` characters of where `anchor` matches. */
export function near(name: string, anchor: RegExp, patterns: RegExp[], distance = 250): Check {
  return {
    name,
    pass: (raw) => {
      const answer = plain(raw);
      for (const match of answer.matchAll(new RegExp(anchor.source, `${anchor.flags.replace("g", "")}g`))) {
        const start = Math.max(0, (match.index ?? 0) - distance);
        const window = answer.slice(start, (match.index ?? 0) + match[0].length + distance);
        if (patterns.every((pattern) => pattern.test(window))) return true;
      }
      return false;
    },
  };
}

/** At least one quote in the answer format: > **Speaker:** "words". */
export const quotesASpeaker = contains("quotes a speaker", /^>\s*\*\*[^*\n]+\*\*/m);

const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/**
 * Every number in the answer appears in the records, as digits or as a word
 * ("5" for "five"). Dates and times are taken out first: they come from the
 * turn context, not the transcripts. A light stand-in for the grounding
 * check built in step 8.
 */
export function numbersFrom(recordsText: string): Check {
  const source = recordsText.toLowerCase();
  const known = (value: string) => {
    if (new RegExp(`(^|[^\\d.])${value.replace(".", "\\.")}([^\\d]|$)`).test(source)) return true;
    const word = NUMBER_WORDS[Number(value)];
    return word !== undefined && new RegExp(`\\b${word}\\b`).test(source);
  };
  return {
    name: "every number is in the records",
    pass: (raw) => {
      const withoutDates = plain(raw)
        // List numbering ("1.", "2)") is layout, not a figure.
        .replace(/^\s*\d+[.)]\s/gm, " ")
        .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b(?:\\s+\\d{4})?`, "gi"), " ")
        .replace(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ")
        .replace(/\b\d{1,2}:\d{2}\b/g, " ")
        .replace(/\b20\d{2}\b/g, " ");
      const numbers = withoutDates.match(/\d+(?:\.\d+)?/g) ?? [];
      return numbers.every(known);
    },
  };
}
