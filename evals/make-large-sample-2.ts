// npx tsx evals/make-large-sample-2.ts
//
// Writes data/large-sample-2.json and data/large-sample-2-questions.md: a
// second large fictional history, different from the first, for testing by
// hand. Monsoon Bikes, Voltcell, QuickParcel, Atelier Mar, Fennel Cables and
// every person and event here are made up. It states no prices (AGENTS.md
// rule 4). WhatsApp groups and email threads import as "chat" records.
//
// It also exercises the importer: one record appears twice (skipped as a
// duplicate), two founder notes have no timezone (read in the browser's), and
// one all-hands transcript is longer than the record budget (read in part).
// A Lisbon studio writes in Lisbon time, so one late email lands on the next
// day in India.
//
// Sixteen weeks: week 1 starts Mon 27 Jul 2026, week 16 ends Fri 13 Nov.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../data/large-sample-2.json", import.meta.url));
const QUESTIONS_OUT = fileURLToPath(new URL("../data/large-sample-2-questions.md", import.meta.url));
const IST = "+05:30";
const WEEKS = 16;

// ---------------------------------------------------------------------------
// Dates

/** weekday: 1 = Monday ... 7 = Sunday. */
function dateOf(week: number, weekday: number): Date {
  return new Date(Date.UTC(2026, 6, 27 + (week - 1) * 7 + (weekday - 1)));
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (date: Date) => `${WEEKDAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
const day = (week: number, weekday: number) => label(dateOf(week, weekday));
const calendar = (year: number, month: number, date: number) => label(new Date(Date.UTC(year, month - 1, date)));

/** "2026-07-27T09:30:00+05:30"; offset null writes no offset at all. */
function stamp(date: Date, time: string, offset: string | null = IST): string {
  return `${date.toISOString().slice(0, 10)}T${time}:00${offset ?? ""}`;
}

// ---------------------------------------------------------------------------
// Records

interface Turn {
  speaker: string;
  text: string;
  timestamp?: string;
}

interface ImportRecord {
  type: "meeting" | "chat" | "note";
  title: string;
  timestamp: string;
  participants: string[];
  turns: Turn[];
}

const records: ImportRecord[] = [];
const speakersOf = (turns: { speaker: string }[]) => [...new Set(turns.map((turn) => turn.speaker))];

function meeting(week: number, weekday: number, time: string, title: string, turns: [string, string][]): ImportRecord {
  const record: ImportRecord = {
    type: "meeting",
    title,
    timestamp: stamp(dateOf(week, weekday), time),
    participants: speakersOf(turns.map(([speaker]) => ({ speaker }))),
    turns: turns.map(([speaker, text]) => ({ speaker, text })),
  };
  records.push(record);
  return record;
}

/** One day of a WhatsApp group: [time, speaker, text]. */
function whatsapp(week: number, weekday: number, group: string, messages: [string, string, string][]): void {
  const date = dateOf(week, weekday);
  const turns = messages.map(([time, speaker, text]) => ({ speaker, text, timestamp: stamp(date, time) }));
  records.push({ type: "chat", title: `WhatsApp: ${group}`, timestamp: turns[0]!.timestamp, participants: speakersOf(turns), turns });
}

/** An email thread: [time, from, body]. `offset` is the sender's zone, for the Lisbon studio. */
function email(week: number, weekday: number, subject: string, messages: [string, string, string][], offset = IST): ImportRecord {
  const date = dateOf(week, weekday);
  const turns = messages.map(([time, from, body]) => ({ speaker: from, text: body, timestamp: stamp(date, time, offset) }));
  const record: ImportRecord = { type: "chat", title: `Email: ${subject}`, timestamp: turns[0]!.timestamp, participants: speakersOf(turns), turns };
  records.push(record);
  return record;
}

/** A founder's note. `offset` null leaves the timezone out, as some notes apps do. */
function note(week: number, weekday: number, time: string, title: string, paragraphs: string[], offset: string | null = IST): void {
  records.push({
    type: "note",
    title,
    timestamp: stamp(dateOf(week, weekday), time, offset),
    participants: ["Ishaan"],
    turns: paragraphs.map((text) => ({ speaker: "Ishaan", text })),
  });
}

let seed = 20261115;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

// People: Ishaan (CEO), Kavya (COO), Rohan (engineering), Sana (supply), Meghna
// (marketing), Arif (workshop lead), Joel (sales), Tara (support), and later
// Farah (CTO, from week 15).

// ---------------------------------------------------------------------------
// Storyline 1: the M2 launch and the battery order.

const FIRST_LAUNCH = day(10, 5);
const LAUNCH = day(11, 5);

meeting(1, 1, "11:00", "Kickoff: Monsoon M2 plan", [
  ["Ishaan", `The M2 launches on ${FIRST_LAUNCH}. Everything this quarter works back from that date.`],
  ["Sana", `We need 400 battery packs from Voltcell. They've quoted delivery for ${day(5, 1)}.`],
  ["Rohan", "Firmware for the new motor controller will be ready by the end of August."],
  ["Meghna", "I'll start the launch campaign in September, once the date is certain."],
  ["Kavya", `Agreed: launch ${FIRST_LAUNCH}, 400 packs from Voltcell by ${day(5, 1)}.`],
]);

const voltcellConfirmation = email(2, 3, "Voltcell order confirmation", [
  ["10:05", "Priyanka (Voltcell)", `Order confirmed: 400 battery packs, model VC-48, delivery to your Hadapsar workshop on ${day(5, 1)}.`],
  ["10:40", "Sana", "Thanks Priyanka, confirmed on our side."],
]);
// The same email again, as an export tool might produce it: the importer skips it as a duplicate.
records.push(structuredClone(voltcellConfirmation));

email(4, 4, "Voltcell delivery delay", [
  ["16:20", "Priyanka (Voltcell)", `Sorry Sana, a cell shortage at our supplier pushes your delivery from ${day(5, 1)} to ${day(8, 1)}.`],
  ["17:02", "Sana", "That's tight for our launch. Please tell me at once if it slips again."],
]);

whatsapp(4, 5, "Founders", [
  ["21:10", "Ishaan", `Voltcell slipped to ${day(8, 1)}. Do we move the launch?`],
  ["21:14", "Kavya", `Not yet. ${day(8, 1)} still leaves time if nothing else slips. Let's decide after the homologation test.`],
]);

meeting(6, 3, "15:00", "Launch readiness #1", [
  ["Rohan", `Motor controller firmware is done. The homologation test is booked for ${day(9, 1)}.`],
  ["Sana", `Voltcell still says ${day(8, 1)} for the batteries.`],
  ["Meghna", "Campaign is ready to go live two weeks before launch."],
  ["Ishaan", `We keep ${FIRST_LAUNCH} for now and review after the test.`],
]);

email(8, 3, "Voltcell partial shipment", [
  ["09:30", "Priyanka (Voltcell)", `We shipped 250 of the 400 packs this morning. The remaining 150 will follow by ${day(11, 1)}.`],
  ["09:55", "Sana", "250 now is better than nothing. Please confirm the date for the last 150 as soon as you can."],
]);

whatsapp(8, 3, "Workshop floor", [
  ["16:45", "Arif", "250 battery packs received from Voltcell. Three have dented casings, set aside for return."],
  ["16:50", "Sana", "Thanks Arif. I'll raise the three with Voltcell."],
]);

email(9, 2, "Homologation test result", [
  ["18:00", "Rohan", `The M2 passed every test on ${day(9, 1)}. Only the paperwork is left; the certificate is expected on ${day(11, 2)}.`],
]);

meeting(9, 4, "11:00", "Launch date decision", [
  ["Rohan", `The certificate is expected on ${day(11, 2)}, three days after the planned launch. We can't sell without it.`],
  ["Meghna", "Moving by one week is fine for the campaign if we decide today."],
  ["Kavya", `Then the launch moves from ${FIRST_LAUNCH} to ${LAUNCH}.`],
  ["Ishaan", `Agreed: we launch on ${LAUNCH}. Meghna, please book Riverside Hall for that evening.`],
]);

email(11, 1, "Voltcell final shipment", [
  ["11:15", "Priyanka (Voltcell)", `The remaining 150 packs shipped today and will reach you on ${day(11, 3)}.`],
]);

email(11, 2, "M2 certificate received", [
  ["14:30", "Rohan", "The M2 type-approval certificate arrived today. We're clear to sell."],
]);

// Lisbon is UTC+1 until Sun 25 Oct, so 23:40 there is 04:10 the next morning in India.
email(11, 2, "Final logo files", [
  ["23:40", "Inês (Atelier Mar)", "Hello Meghna, the final M2 logo files are attached: all colour versions and the badge for the frame."],
], "+01:00");

whatsapp(11, 3, "Workshop floor", [
  ["15:20", "Arif", "The last 150 packs from Voltcell are in. All 400 received now, three still waiting to be returned."],
]);

whatsapp(11, 5, "Monsoon core", [
  ["19:05", "Meghna", "Riverside Hall is full. Thank you all for tonight."],
  ["21:02", "Joel", "85 preorders on launch day."],
  ["21:05", "Ishaan", "Proud of this team."],
]);

email(11, 6, "Launch recap", [
  ["12:10", "Meghna", "Launch recap: 85 preorders on day one and 112 by noon today. About 300 people came to Riverside Hall."],
]);

// ---------------------------------------------------------------------------
// Storyline 2: the brake cable recall. Target moved from Tue 20 Oct to Fri 30 Oct.

whatsapp(10, 1, "Workshop floor", [
  ["10:12", "Arif", "Found frayed brake cables on 12 bikes from batch B7 during servicing. Stopping all B7 work."],
  ["10:20", "Rohan", "Send me photos. Could be the new cable supplier."],
]);

meeting(10, 2, "10:00", "Brake cable issue", [
  ["Arif", "Twelve B7 bikes so far, all with cables from Fennel Cables' August batch."],
  ["Kavya", "Every B7 bike gets new cables. How many is that?"],
  ["Sana", "Batch B7 is 340 bikes."],
  ["Tara", "I'll contact all 340 customers this week and book them in."],
  ["Kavya", `Decided: we recall all 340 bikes of batch B7. Target to have them fixed by ${day(13, 2)}.`],
]);

meeting(13, 1, "10:00", "Weekly ops review", [
  ["Tara", `Recall update: 290 of 340 bikes fixed. We'll miss ${day(13, 2)}.`],
  ["Arif", "Most of the rest are customers who haven't brought their bikes in yet."],
  ["Kavya", `New target for the recall: ${day(14, 5)}.`],
]);

email(15, 5, "Recall status", [
  ["17:45", "Tara", "Recall status: 334 of 340 B7 bikes fixed. The other 6 customers haven't answered three calls and two emails each."],
]);

// ---------------------------------------------------------------------------
// Storyline 3: hiring a CTO. Dev is offered first and declines; Farah accepts.

note(5, 4, "19:00", "CTO interview: Farah", [
  "Farah led a 15-person hardware team at an electric scooter company.",
  "Strong on manufacturing and quality. Less hands-on with apps.",
]);

note(6, 1, "19:30", "CTO interview: Dev", [
  "Dev built the app and the cloud side at a fleet tracking startup.",
  "Excellent on software, has not worked with factories.",
]);

whatsapp(7, 5, "Founders", [
  ["22:00", "Ishaan", "I'd go with Dev. The app is where customers feel us."],
  ["22:06", "Kavya", "I'd go with Farah. Our problems this year are in the workshop, not the app."],
]);

meeting(8, 1, "17:00", "CTO decision", [
  ["Ishaan", "We need someone who can start this year."],
  ["Kavya", "I still lean Farah, but I can live with Dev."],
  ["Ishaan", "Decided: we offer the role to Dev first. Farah is our second choice."],
]);

email(8, 5, "Re: CTO offer", [
  ["11:20", "Dev", "Thank you for the offer. I've accepted a role elsewhere, so I have to decline."],
  ["12:00", "Ishaan", "Sorry to hear it, Dev. Best of luck."],
]);

whatsapp(9, 1, "Founders", [
  ["09:15", "Kavya", "Farah then?"],
  ["09:16", "Ishaan", "Farah. I'll call her today."],
]);

email(10, 3, "Re: CTO offer - Farah", [
  ["10:30", "Farah", `I'm delighted to accept. I can start on ${day(15, 1)}.`],
  ["10:45", "Ishaan", "Welcome to Monsoon Bikes, Farah."],
]);

whatsapp(15, 1, "Monsoon core", [
  ["09:30", "Ishaan", "Please welcome Farah, our new CTO, who starts today."],
  ["09:33", "Rohan", "Welcome Farah!"],
  ["09:40", "Farah", "Thanks everyone. Looking forward to the workshop tour."],
]);

// ---------------------------------------------------------------------------
// Storyline 4: the warehouse move. Chakan, lease signed Wed 14 Oct, move Sat 21 Nov.

const MOVE_DAY = calendar(2026, 11, 21);

meeting(7, 2, "16:00", "Warehouse options", [
  ["Sana", "Hadapsar is full. The two options are Chakan and Talegaon."],
  ["Arif", "Chakan is closer to most of our suppliers."],
  ["Joel", "Talegaon is easier for test-ride customers to reach."],
  ["Kavya", "No decision today. Sana, please get lease terms for both."],
]);

meeting(12, 3, "16:00", "Warehouse decision", [
  ["Sana", "Both landlords sent terms. Chakan can give us the space from mid-November."],
  ["Kavya", `Decided: we move to Chakan. Lease signed today; move day is ${MOVE_DAY}.`],
  ["Arif", "I'll plan the workshop layout so we lose no more than one day of assembly."],
]);

// ---------------------------------------------------------------------------
// Storyline 5: QuickParcel pilot, 30 bikes, extended to 80.

meeting(10, 4, "14:00", "QuickParcel pilot", [
  ["Joel", `QuickParcel wants 30 bikes for a four-week pilot with their riders, starting ${day(12, 1)}.`],
  ["Rohan", "We'll add remote diagnostics so we see battery health during the pilot."],
  ["Ishaan", "Agreed: 30 bikes for four weeks."],
]);

email(14, 1, "QuickParcel pilot results", [
  ["15:00", "Neha (QuickParcel)", `Riders averaged 62 km a day with no breakdowns. We'd like to go from 30 to 80 bikes from ${day(16, 1)}.`],
  ["15:30", "Joel", `Great results. Confirmed: 80 bikes from ${day(16, 1)}.`],
]);

whatsapp(16, 1, "Monsoon core", [
  ["18:20", "Joel", "All 80 QuickParcel bikes handed over today."],
]);

// ---------------------------------------------------------------------------
// Storyline 6: a Bengaluru showroom. Discussed Wed 12 Aug; decided Thu 22 Oct to wait.

meeting(3, 3, "17:30", "Bengaluru showroom?", [
  ["Ishaan", "A Bengaluru showroom would double our test rides."],
  ["Kavya", "Not before the M2 is out and stable. We'd split the team."],
  ["Ishaan", "Let's come back to it after launch."],
]);

meeting(13, 4, "18:00", "Founders: showroom and priorities", [
  ["Kavya", "With the recall still open, a second city now is a risk."],
  ["Ishaan", "I agree, reluctantly."],
  ["Ishaan", "Decided: no Bengaluru showroom until Q2 2027. We revisit in March."],
]);

// ---------------------------------------------------------------------------
// The all-hands: longer than the record budget. The warranty change is said
// part-way through, among routine questions.

const askers = ["Joel", "Tara", "Arif", "Sana", "Meghna", "Rohan"];
const topics = [
  "the assembly line rota",
  "test-ride bookings",
  "the support queue",
  "spare parts stock",
  "the campaign after launch",
  "firmware updates",
  "the Chakan move",
  "service intervals",
  "training for new mechanics",
  "the QuickParcel pilot",
];
const allHands: [string, string][] = [
  ["Ishaan", "Welcome to the Q3 all-hands. We'll go through each team, then open questions."],
];
for (let index = 0; index < 340; index += 1) {
  const asker = pick(askers);
  const topic = pick(topics);
  allHands.push([asker, `Question on ${topic}: what changes for my team over the next few weeks, and who should I go to with problems?`]);
  allHands.push([
    pick(["Kavya", "Ishaan", "Rohan"]),
    `On ${topic}, nothing changes this month. Bring problems to the weekly ops review first, and to me directly if it's urgent.`,
  ]);
  if (index === 170) {
    allHands.push(["Kavya", "One announcement: from 1 January, the battery warranty goes from two years to three years for every M2."]);
    allHands.push(["Tara", "Does that cover bikes already sold?"]);
    allHands.push(["Kavya", "Yes, every M2 sold so far gets the third year too."]);
  }
}
allHands.push(["Ishaan", "Thanks everyone. Slides are in the shared drive."]);
meeting(14, 5, "16:00", "All-hands: Q3 review", allHands);

// ---------------------------------------------------------------------------
// Routine: weekly ops reviews (Mondays), sales huddles (Thursdays), support
// digests (Fridays), founder notes, and chatter.

const assembled: number[] = [];
for (let week = 1; week <= WEEKS; week += 1) {
  const bikes = between(38, 72);
  assembled.push(bikes);
  if (week !== 13) {
    meeting(week, 1, "10:00", "Weekly ops review", [
      ["Arif", `Last week we assembled ${bikes} bikes. Backlog is ${between(5, 30)} bikes.`],
      ["Sana", pick(["Parts stock is fine.", "Tyres are running low; reorder placed.", "Waiting on a delayed shipment of controllers.", "No supply issues this week."])],
      ["Tara", `${between(20, 60)} support tickets last week.`],
      ["Kavya", pick(["Good week.", "Let's keep the backlog under 20.", "Thanks all.", "Watch quality on the new hires' bikes."])],
    ]);
  }
  const rides = between(15, 45);
  meeting(week, 4, "17:00", "Sales huddle", [
    ["Joel", `${rides} test rides booked this week, ${between(4, 14)} converted to orders.`],
    ["Meghna", pick(["Instagram ads are bringing most test rides.", "Referrals are up.", "The college fair brought a lot of walk-ins.", "Quiet week for leads."])],
  ]);
}

const topIssues = ["charging questions", "app pairing", "brake noise", "delivery dates", "the B7 recall", "tyre punctures"];
for (let week = 1; week <= WEEKS; week += 1) {
  const issue = week >= 10 && week <= 13 ? "the B7 recall" : pick(topIssues.filter((issue) => issue !== "the B7 recall"));
  email(week, 5, "Support digest", [["18:00", "Tara", `This week: ${between(20, 60)} tickets. Top issue: ${issue}.`]]);
}

// Founder notes on some Fridays; two have no timezone.
const noteWeeks = [2, 5, 8, 11, 14, 16];
noteWeeks.forEach((week, index) => {
  const thoughts = [
    "Week felt long. The team is carrying a lot.",
    "Need to spend more time with customers, less in spreadsheets.",
    "Voltcell is our biggest single risk. We need a second battery supplier next year.",
    "Launch went better than I feared. Now the hard part: delivering every preorder.",
    "The recall hurt, but customers were kind when we called them first.",
    "Farah's first fortnight: she has already fixed the workshop handover checklist.",
  ];
  note(week, 5, "22:30", "Founder notes", [thoughts[index]!], index === 1 || index === 3 ? null : IST);
});

const chatter: [string, string][] = [
  ["Arif", "Torque wrench is missing from bay 2 again."],
  ["Rohan", "Firmware build is green."],
  ["Joel", "Customer coming at 4 for a test ride, keep a charged M1 ready."],
  ["Tara", "Can someone check the app pairing on the demo bike?"],
  ["Sana", "Courier from Voltcell at the gate."],
  ["Meghna", "Photo shoot on the terrace at 11."],
  ["Arif", "Power cut, assembly paused for 20 minutes."],
  ["Kavya", "Lunch is on me today."],
  ["Rohan", "Who borrowed the oscilloscope?"],
  ["Joel", "Two walk-ins asking about the M2."],
];
for (let week = 1; week <= WEEKS; week += 1) {
  for (const weekday of [between(1, 2), between(3, 5)]) {
    const messages: [string, string, string][] = [];
    const count = between(3, 7);
    for (let index = 0; index < count; index += 1) {
      const [speaker, text] = pick(chatter);
      messages.push([`12:${String(5 + index * 6).padStart(2, "0")}`, speaker, text]);
    }
    whatsapp(week, weekday, pick(["Workshop floor", "Monsoon core"]), messages);
  }
}

// ---------------------------------------------------------------------------
// Write the file and the questions.

records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      description:
        "Second large fictional sample for testing. Monsoon Bikes and every company, person and event in it are made up. Generated by evals/make-large-sample-2.ts.",
      records,
    },
    null,
    2,
  )}\n`,
);

const questions: [string, string][] = [
  ["When did all 400 battery packs arrive?", `250 on ${day(8, 3)} and the last 150 on ${day(11, 3)}. Originally due ${day(5, 1)}; Voltcell moved it to ${day(8, 1)} on ${day(4, 4)}. Three packs were dented.`],
  ["When was the M2 launched, and why not on the original date?", `${LAUNCH}. It was planned for ${FIRST_LAUNCH}; on ${day(9, 4)} it moved because the certificate was expected on ${day(11, 2)}.`],
  ["How many preorders did we get at launch?", `85 on launch day (${LAUNCH}), 112 by noon on ${day(11, 6)}.`],
  ["What was wrong with batch B7, and how many bikes were recalled?", `Frayed brake cables on 12 bikes (found ${day(10, 1)}); all 340 B7 bikes recalled on ${day(10, 2)}.`],
  ["How many recalled bikes have been fixed?", `334 of 340 as of ${day(15, 5)}; 6 customers unreachable. Target moved from ${day(13, 2)} to ${day(14, 5)}.`],
  ["Who is our new CTO?", `Farah, started ${day(15, 1)} (accepted ${day(10, 3)}). Dev was offered the role first on ${day(8, 1)} and declined on ${day(8, 5)}.`],
  ["Who wanted Dev as CTO?", `Ishaan (WhatsApp, ${day(7, 5)}); Kavya preferred Farah.`],
  ["Where is the warehouse moving, and when?", `Chakan, decided and lease signed ${day(12, 3)}; move day ${MOVE_DAY}.`],
  ["What did we decide about the warehouse on 8 September?", `Nothing: no decision on ${day(7, 2)}; Sana was to get lease terms for Chakan and Talegaon.`],
  ["Are we opening a Bengaluru showroom?", `Not yet: no showroom until Q2 2027, revisit in March (decided ${day(13, 4)}). First discussed ${day(3, 3)} with no decision.`],
  ["How many bikes does QuickParcel have now?", `80 from ${day(16, 1)} (pilot of 30 from ${day(12, 1)}; extension agreed ${day(14, 1)}).`],
  ["When did Atelier Mar send the final logo files?", `Wed 7 Oct at 04:10 in India (Tue 6 Oct, 23:40 in Lisbon). Tests timezones: the answer should give the India day.`],
  ["What did Kavya say about the warranty at the all-hands?", `From 1 January the battery warranty goes from two years to three, including every M2 already sold (All-hands, ${day(14, 5)}). The record is too long to read whole, so the answer should say it covers part of it.`],
  // Each Monday's ops review reports the week before it.
  ["How many bikes did we assemble in the week of 21 September?", `${assembled[9]} (reported at the ops review on ${day(10, 1)}).`],
  ["What was the top support issue in the week of 12 October?", `The B7 recall (support digest ${day(12, 5)}).`],
  ["What did we discuss on Sunday 18 October?", "Nothing is stored that day: the answer should say so, give the stored range and the nearest days with records."],
  ["How much did the Voltcell order cost?", "No record states a price: the answer should say so, not guess."],
  ["Who has been the biggest supply risk?", `Voltcell: delayed from ${day(5, 1)} to ${day(8, 1)}, then shipped in two parts. Ishaan's note of ${day(8, 5)} calls it "our biggest single risk".`],
];

const markdown = [
  "# Second large sample: questions and expected answers",
  "",
  "Load `data/large-sample-2.json` with Upload JSON. Everything in the file is fictional.",
  `It holds ${records.length} records (one is a duplicate) from ${day(1, 1)} to ${day(WEEKS, 5)} 2026: meetings, WhatsApp groups, email threads and founder notes.`,
  "",
  "What the import should report:",
  `- ${records.length - 1} records loaded, and "1 record was already loaded and was skipped."`,
  "- 2 records had no timezone and were read in your browser's timezone (the founder notes of " +
    `${day(noteWeeks[1]!, 5)} and ${day(noteWeeks[3]!, 5)}).`,
  '- "All-hands: Q3 review" is too long to read in one go; answers about it use the parts that match.',
  "",
  "| Question | Expected answer |",
  "|---|---|",
  ...questions.map(([question, answer]) => `| ${question} | ${answer} |`),
  "",
].join("\n");
writeFileSync(QUESTIONS_OUT, markdown);

console.log(`Wrote ${records.length} records to ${OUT}`);
