// Eval cases 1 to 7 (REQUIREMENTS.md §7): recall without web search.
// Expected dates come from the sample as loaded today, so the cases pass on
// any day they are run.
import { contains, inOrder, lacks, near, numbersFrom, quotesASpeaker, type Check } from "./checks.ts";

export interface EvalContext {
  /** "29 Oct" style label of a sample record's day, by id. */
  dayOf(recordId: string): string;
  /** "24 October": a day before the first record, with nothing on it. */
  emptyDayBeforeRange: string;
  /** "3 Nov" style labels of the first and last record's day. Which records those are depends on the weekday the sample was loaded. */
  rangeFrom: string;
  rangeTo: string;
  /** All record text, for checking that numbers come from the records. */
  recordsText: string;
}

export interface EvalCase {
  id: number;
  name: string;
  question: string;
  checks: Check[];
  /** The answer must come from a web search, not the model's own knowledge (F11). */
  needsSearch?: boolean;
}

// The ways a correct answer says the records hold nothing on it. Widened
// three times after correct answers ("do not mention", "do not contain
// anything about", "none of them mention") were marked as failures.
const NO_RECORD = /no record|nothing (?:is |was )?(?:recorded|stored|on|about)|(?:don't|do not) have (?:any |a )?(?:record|anything)|no (?:meeting|note|chat)s?|isn't (?:anything|any record)|there (?:is|are) no|not (?:in|mentioned in) (?:your|the|any) records|(?:do|does|did)(?: not|n't) (?:mention|contain|include|cover|say anything|have anything)|none (?:of (?:them|the|your|my)\b[^.]{0,60}? )?(?:mention|contain|include|cover)|no mention|not mentioned/i;
const NOT_DECIDED = /nothing (?:was|has been) decided|no decision|not (?:yet )?decided|(?:wasn't|was not|hasn't been|has not been) decided|undecided|did(?:n't| not) decide/i;

/** A per-claim status from the re-check contract (ARCHITECTURE.md §5). */
const STATUS = /no announced change|\bchanged\b|couldn['’]t verify|could not verify|cannot verify|can't verify/i;
/** A Markdown link to a web page. */
const LINK = /\]\(https?:\/\//;
/** A source's date, or the date an undated page was checked. */
const SOURCE_DATE = /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b|\bchecked\b|\bundated\b/i;

export function evalCases(context: EvalContext): EvalCase[] {
  const grounded = numbersFrom(context.recordsText);
  return [
    {
      id: 1,
      name: "Summary of a named meeting",
      question: "Summarise the Acme renewal call.",
      checks: [
        contains("the 12-month renewal", /12[- ]month|twelve[- ]month/i),
        contains("seats going to 55", /\b55\b/),
        contains("onboarding within five weeks", /five weeks|5 weeks/i),
        contains("onboarding starts Monday", /Monday/),
        near("the discount left open", /discount/i, [/open|not (?:yet )?(?:decided|agreed|approved)|no decision|undecided|unresolved|pending/i]),
        quotesASpeaker,
        grounded,
      ],
    },
    {
      id: 2,
      name: "What did we decide about X?",
      question: "What did we decide about the CRM shortlist?",
      checks: [
        ...["HubSpot", "Pipedrive", "Zoho", "Freshsales", "Salesforce"].map((tool) =>
          contains(`names ${tool}`, new RegExp(tool, "i")),
        ),
        contains("quotes the decision", /shortlist is those five/i),
        near("says who decided", /shortlist is those five/i, [/Shane/]),
        contains("keeps the final pick apart as not decided", /(?:not|n't|no)\b.{0,60}\b(?:pick|chose|choose|decid|select)|not (?:yet )?decided|undecided/i),
        grounded,
      ],
    },
    {
      id: 3,
      name: "Decision asked, none made",
      question: "What did we decide about Postgres hosting?",
      checks: [
        contains("says nothing was decided", NOT_DECIDED),
        lacks("does not claim a provider was chosen", /(?:decided|agreed|chose|picked|went) (?:to go with|on|for) (?:Neon|Supabase|Amazon RDS|RDS)/i),
        quotesASpeaker,
        grounded,
      ],
    },
    {
      id: 4,
      name: "Action items",
      question: "What are the action items from the Acme renewal call?",
      checks: [
        near("Shane sends the order form by Monday", /order form/i, [/Shane/, /Monday/]),
        near("Rahul shares the checklist by Tuesday", /checklist/i, [/Rahul/, /Tuesday/]),
        grounded,
      ],
    },
    {
      id: 5,
      name: "Same topic on two days",
      question: "How did the Acme onboarding start date discussion develop?",
      checks: [
        inOrder(
          "both days, oldest first",
          context.dayOf("sample-acme-kickoff"),
          context.dayOf("sample-acme-renewal"),
        ),
        contains("names the latest", /latest|most recent|final|now (?:agreed|set|decided)/i),
        contains("gives the agreed start", /Monday/),
        grounded,
      ],
    },
    {
      id: 6,
      name: "Date with no record",
      question: `What did we discuss on ${context.emptyDayBeforeRange}?`,
      checks: [
        contains("says there is no record", NO_RECORD),
        contains("states where the range starts", new RegExp(context.rangeFrom)),
        contains("states where the range ends", new RegExp(context.rangeTo)),
      ],
    },
    {
      id: 7,
      name: "Topic with no record",
      question: "What did we decide about the office move?",
      checks: [
        contains("says there is no record", NO_RECORD),
        lacks("does not invent a decision", /decided to move|(?:we|you) (?:are|will be) moving|new office (?:is|will)/i),
        grounded,
      ],
    },
    {
      id: 8,
      name: "Recall an earlier question, then re-check it",
      question: "What did I ask on 3 November? Is it still correct?",
      needsSearch: true,
      checks: [
        contains("recalls what was asked", /small managed Postgres|what (?:do|did) Neon|charge for a small/i),
        // The earlier answer's own figure, from the stored chat: Supabase Pro at $25 a month.
        contains("recalls what the answer said", /\$25\b/),
        // One result per claim: a status, a linked source and a date near each provider.
        ...["Neon", "Supabase", "RDS"].map((provider) =>
          near(`${provider}: status, source and date`, new RegExp(provider, "i"), [STATUS, LINK, SOURCE_DATE]),
        ),
      ],
    },
    {
      id: 9,
      name: "Five shortlisted tools, pricing changes",
      question: "On Monday we shortlisted 5 CRM tools. Has pricing changed for any of them?",
      needsSearch: true,
      checks: [
        // One result per tool: a status, a linked source and a date near its name.
        ...["HubSpot", "Pipedrive", "Zoho", "Freshsales", "Salesforce"].map((tool) =>
          near(`${tool}: status, source and date`, new RegExp(tool, "i"), [STATUS, LINK, SOURCE_DATE]),
        ),
        // The records hold no prices, so nothing can be shown to have changed.
        contains("says there is no stored price to compare", /no stored|not stored|no (?:recorded|saved|stored) (?:price|pricing|value|baseline)|no baseline|nothing (?:stored|recorded) to compare/i),
        lacks("claims no change it cannot show", /\*\*[^*\n]+\*\*\s*:?\s*\**changed\b/i),
      ],
    },
    {
      id: 10,
      name: "General question, not about the records",
      question: "What's the difference between Postgres and MySQL for a small SaaS?",
      checks: [
        // A real user asks things that are not in their history; "no record" is the wrong answer.
        lacks("does not answer with no record", NO_RECORD),
        contains("talks about Postgres", /Postgres/i),
        contains("talks about MySQL", /MySQL/i),
      ],
    },
  ];
}
