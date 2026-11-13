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
}

// The ways a correct answer says the records hold nothing on it. Widened
// three times after correct answers ("do not mention", "do not contain
// anything about", "none of them mention") were marked as failures.
const NO_RECORD = /no record|nothing (?:is |was )?(?:recorded|stored|on|about)|(?:don't|do not) have (?:any )?(?:record|anything)|no (?:meeting|note|chat)s?|isn't (?:anything|any record)|there (?:is|are) no|not (?:in|mentioned in) (?:your|the|any) records|(?:do|does|did)(?: not|n't) (?:mention|contain|include|cover|say anything|have anything)|none (?:of (?:them|the records|your records) )?(?:mention|contain|include|cover)|no mention|not mentioned/i;
const NOT_DECIDED = /nothing (?:was|has been) decided|no decision|not (?:yet )?decided|(?:wasn't|was not|hasn't been|has not been) decided|undecided|did(?:n't| not) decide/i;

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
  ];
}
