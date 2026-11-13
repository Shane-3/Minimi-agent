// npx tsx evals/make-large-sample.ts
//
// Writes data/large-sample.json, a large fictional history for testing recall
// at scale, and data/large-sample-questions.md, questions with their answers.
//
// Everything in it is fictional: the company (Kestrel Works), its client
// (Brightline Logistics), the people and the events. It states no prices
// (AGENTS.md rule 4). WhatsApp groups and email threads are imported as
// "chat" records, named "WhatsApp: ..." and "Email: ...".
//
// Dates are fixed: twenty weeks from Mon 29 Jun to Fri 13 Nov 2026. The main
// storylines run in the last eight (weeks 1 to 8, from Mon 21 Sep); weeks -11
// to 0 are mostly routine, so the history is larger than the agent's record
// budget and retrieval has to choose. Every date in the text comes from the
// same helper as the timestamps, so weekdays match.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../data/large-sample.json", import.meta.url));
const QUESTIONS_OUT = fileURLToPath(new URL("../data/large-sample-questions.md", import.meta.url));
const OFFSET = "+05:30";
const FIRST_WEEK = -11;
const WEEKS = 8;

// ---------------------------------------------------------------------------
// Dates

/** Week 1 starts Mon 21 Sep 2026. weekday: 1 = Monday ... 7 = Sunday. */
function dateOf(week: number, weekday: number): Date {
  return new Date(Date.UTC(2026, 8, 21 + (week - 1) * 7 + (weekday - 1)));
}

function calendar(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 21 Sep". */
function label(date: Date): string {
  return `${WEEKDAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

const day = (week: number, weekday: number) => label(dateOf(week, weekday));

/** "2026-09-21T09:30:00+05:30". */
function stamp(date: Date, time: string): string {
  return `${date.toISOString().slice(0, 10)}T${time}:00${OFFSET}`;
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

function meeting(week: number, weekday: number, time: string, title: string, turns: [string, string][]): void {
  records.push({
    type: "meeting",
    title,
    timestamp: stamp(dateOf(week, weekday), time),
    participants: [...new Set(turns.map(([speaker]) => speaker))],
    turns: turns.map(([speaker, text]) => ({ speaker, text })),
  });
}

/** One day of a WhatsApp group: [time, speaker, text]. */
function whatsapp(week: number, weekday: number, group: string, messages: [string, string, string][]): void {
  const date = dateOf(week, weekday);
  records.push({
    type: "chat",
    title: `WhatsApp: ${group}`,
    timestamp: stamp(date, messages[0]![0]),
    participants: [...new Set(messages.map(([, speaker]) => speaker))],
    turns: messages.map(([time, speaker, text]) => ({ speaker, text, timestamp: stamp(date, time) })),
  });
}

/** An email thread on one day: [time, from, body]. */
function email(week: number, weekday: number, subject: string, messages: [string, string, string][]): void {
  const date = dateOf(week, weekday);
  records.push({
    type: "chat",
    title: `Email: ${subject}`,
    timestamp: stamp(date, messages[0]![0]),
    participants: [...new Set(messages.map(([, from]) => from))],
    turns: messages.map(([time, from, body]) => ({ speaker: from, text: body, timestamp: stamp(date, time) })),
  });
}

function note(week: number, weekday: number, time: string, title: string, paragraphs: string[]): void {
  records.push({
    type: "note",
    title,
    timestamp: stamp(dateOf(week, weekday), time),
    participants: ["Shane"],
    turns: paragraphs.map((text) => ({ speaker: "Shane", text })),
  });
}

// A small seeded random generator, so the file is the same on every run.
let seed = 20261113;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;

// Future dates the story refers to.
const FIRST_GO_LIVE = label(calendar(2026, 11, 30));
const GO_LIVE = label(calendar(2026, 12, 7));
const MOVE_DAY = label(calendar(2026, 12, 12));
const TRAINING_1 = label(calendar(2026, 12, 1));
const TRAINING_2 = label(calendar(2026, 12, 2));
const OFFSITE = `${label(calendar(2027, 1, 15))} and ${label(calendar(2027, 1, 16))}`;
const OFFSITE_OTHER = `${label(calendar(2027, 1, 22))} and ${label(calendar(2027, 1, 23))}`;

// ---------------------------------------------------------------------------
// Storyline 1: Brightline Logistics onboarding. The go-live date and the
// driver count change on Tue 27 Oct.

meeting(1, 2, "15:00", "Brightline kickoff", [
  ["Shane", "Thanks for coming in. Today is about scope and dates for getting Brightline's drivers onto our app."],
  ["Priya (Brightline)", "Phase one is our Whitefield hub: 120 drivers. We'd like them live before the December rush."],
  ["Meera", `Then let's aim for ${FIRST_GO_LIVE}. That gives us nine weeks for integration, testing and training.`],
  ["Vikram (Brightline)", "Our dispatch system has a REST API. I'll send the docs and sandbox access by Friday."],
  ["Rahul", "I'll own the integration on our side. Kabir will work with me on order sync."],
  ["Priya (Brightline)", "Can we meet weekly? Mondays at four suit us."],
  ["Shane", `Agreed: a weekly sync on Mondays at 16:00, and go-live on ${FIRST_GO_LIVE} with 120 drivers.`],
]);

email(1, 5, "Brightline dispatch API docs", [
  ["11:20", "Vikram (Brightline)", "Hi Rahul, attached are the dispatch API docs. Sandbox access is set up for you and Kabir. Note the sandbox allows 60 requests per minute."],
  ["12:05", "Rahul", "Thanks Vikram, got them. We'll start on order sync on Monday."],
]);

const brightlineSyncs: { [week: number]: [string, string][] } = {
  2: [
    ["Rahul", "Order sync works against the sandbox. Status updates are next."],
    ["Priya (Brightline)", "Good. Our drivers mostly use older Android phones, so please test on those."],
    ["Divya", "Noted. I'll add two older Android devices to the test set this week."],
  ],
  3: [
    ["Rahul", "Integration is about 40 percent done. Order sync and status updates both work in the sandbox."],
    ["Priya (Brightline)", "One more ask: drivers should take a proof-of-delivery photo at each drop."],
    ["Meera", "That's new scope. Let me estimate it and come back next Monday before we say yes."],
  ],
  4: [
    ["Meera", "Proof-of-delivery photos add about one week of work, mostly upload handling on weak networks."],
    ["Priya (Brightline)", "We want it in phase one. Please include it."],
    ["Shane", "Then it's in. We'll check what it does to the go-live date once the photo flow is designed."],
  ],
  5: [
    ["Rahul", "Photo upload works on good networks. Retries on weak networks still need work."],
    ["Vikram (Brightline)", "Our training team needs two full days with the drivers before go-live."],
    ["Meera", "Then we should review the date. Let's hold a go-live review next week."],
  ],
  7: [
    ["Rahul", "Photo retries are done. All sync features are code-complete."],
    ["Priya (Brightline)", "We'll start user acceptance testing next Monday with ten drivers."],
  ],
  8: [
    ["Vikram (Brightline)", "User acceptance testing started today with ten drivers. Three bugs logged so far, none blocking."],
    ["Rahul", "We'll fix all three this week."],
    ["Priya (Brightline)", `Driver training is booked for ${TRAINING_1} and ${TRAINING_2}.`],
  ],
};
for (const [week, turns] of Object.entries(brightlineSyncs)) {
  meeting(Number(week), 1, "16:00", "Brightline weekly sync", turns);
}

meeting(6, 2, "16:00", "Brightline go-live review", [
  ["Meera", "With proof-of-delivery photos and two training days, the current date is too tight."],
  ["Rahul", `Engineering can be ready by ${FIRST_GO_LIVE}, but training can't happen until the build is final.`],
  ["Priya (Brightline)", `Then let's move go-live to ${GO_LIVE}. And we'd like 150 drivers in phase one, not 120: the Sarjapur hub joins too.`],
  ["Shane", "Can the app handle 150 from day one?"],
  ["Kabir", "Yes. Load tests ran fine at 300 simulated drivers."],
  ["Priya (Brightline)", `Fine, ${GO_LIVE} it is, with 150 drivers.`],
  ["Shane", `Decided: go-live moves from ${FIRST_GO_LIVE} to ${GO_LIVE}, and phase one grows to 150 drivers.`],
]);

email(6, 3, "Confirming Brightline go-live date", [
  ["10:15", "Shane", `Hi Priya, confirming what we agreed yesterday: go-live is now ${GO_LIVE} (moved from ${FIRST_GO_LIVE}), with 150 drivers across the Whitefield and Sarjapur hubs.`],
  ["11:40", "Priya (Brightline)", `Confirmed, thanks Shane. ${GO_LIVE} with 150 drivers.`],
]);

// ---------------------------------------------------------------------------
// Storyline 2: hiring a support lead. Offer to Anita on Fri 16 Oct; she
// accepts on Tue 20 Oct and starts Mon 2 Nov.

meeting(2, 3, "11:00", "Support lead role: kickoff", [
  ["Shane", "We need a support lead. Ticket volume is up and Nisha is covering alone."],
  ["Nisha", "The main gap is European hours. Brightline's partners in Europe write in while we're offline."],
  ["Meera", "So the role needs someone happy to work a European shift, at least three days a week."],
  ["Shane", "Let's aim to have two finalists by mid-October. I'll post the role today."],
]);

note(3, 4, "18:30", "Interview notes: Anita", [
  "Anita has run a support team of six at a payments company.",
  "She prefers the European shift and has done it before.",
  "Weak spot: hasn't used our kind of mobile product. Strong on process and hiring.",
]);

note(3, 5, "18:10", "Interview notes: Leo", [
  "Leo was a Kestrel customer for a year at his last job, so he knows the product well.",
  "Earlier in his career; never managed anyone.",
  "Can do the European shift only one or two days a week.",
]);

whatsapp(4, 3, "Hiring", [
  ["13:02", "Meera", "I lean towards Leo. He already knows the product inside out."],
  ["13:05", "Nisha", "I'd pick Anita. We need someone who has run a team and can cover European hours."],
  ["13:09", "Shane", "Both fair points. Let's decide on Friday."],
]);

meeting(4, 5, "15:30", "Support lead decision", [
  ["Nisha", "The role is mostly running the shift and growing the team. That's Anita's experience."],
  ["Meera", "Agreed, though I'd like to keep Leo in mind for a support engineer role next year."],
  ["Shane", "Decided: we offer the support lead role to Anita. I'll send the offer today. Leo goes on the list for a support engineer role."],
]);

email(5, 2, "Re: Offer - Support Lead", [
  ["09:45", "Anita", `Hi Shane, I'm happy to accept the offer. I can start on ${day(7, 1)}.`],
  ["10:30", "Shane", `Wonderful. Welcome to Kestrel, Anita. See you on ${day(7, 1)}.`],
]);

whatsapp(7, 1, "Kestrel team", [
  ["09:05", "Shane", "Everyone, please welcome Anita, our new support lead, who starts today."],
  ["09:07", "Nisha", "Welcome Anita! Finally a second person on support."],
  ["09:10", "Anita", "Thank you all, happy to be here."],
]);

// ---------------------------------------------------------------------------
// Storyline 3: office move. HSR Layout chosen on Wed 21 Oct; move on Sat 12 Dec.

meeting(2, 2, "17:00", "Office space options", [
  ["Shane", "Our lease ends in December. Two options: Indiranagar or HSR Layout."],
  ["Tom", "Indiranagar is closer to most clients, with 22 desks. HSR Layout is bigger, with 30 desks, and has a meeting room."],
  ["Arjun", "With the hires we're planning, 22 desks is tight by spring."],
  ["Shane", "No decision today. Tom, can you visit both this week and share photos?"],
]);

whatsapp(3, 3, "Kestrel team", [
  ["16:20", "Tom", "Visited both offices. Photos are in the shared folder."],
  ["16:24", "Arjun", "HSR has much better light. Indiranagar's meeting room is basically a cupboard."],
  ["16:31", "Kabir", "HSR is 10 minutes from my place, so I'm biased."],
  ["16:40", "Meera", "Indiranagar would save us client travel time though."],
]);

meeting(5, 3, "17:00", "Office move decision", [
  ["Tom", "The HSR landlord agreed to a three-year lease and will repaint before we move."],
  ["Meera", "I still prefer Indiranagar for clients, but most client meetings are video calls now."],
  ["Shane", `Decided: we move to HSR Layout. Move day is ${MOVE_DAY}, a Saturday, so no work is lost.`],
  ["Arjun", "I'll draw the desk layout and share it by next Friday."],
]);

// ---------------------------------------------------------------------------
// Storyline 4: release v2.3. Planned for Thu 15 Oct, slipped after a crash,
// shipped Mon 19 Oct.

meeting(3, 4, "11:00", "Release planning v2.3", [
  ["Meera", `v2.3 has two features: offline mode and the new route view. Target release is ${day(4, 4)}.`],
  ["Rahul", "I'd cut the route view. Offline mode alone is risky enough for one release."],
  ["Meera", "Brightline's drivers asked for the route view, so I'd keep both."],
  ["Shane", "Compromise: ship both, with the route view behind a feature flag."],
  ["Divya", "I'll test offline mode on the two older Android phones."],
]);

whatsapp(4, 2, "Kestrel eng", [
  ["18:12", "Divya", "Found a crash: the app closes on Android 12 when offline sync resumes after more than an hour."],
  ["18:15", "Rahul", "That's a release blocker. Can you reproduce it every time?"],
  ["18:20", "Divya", "Every time on both old phones."],
  ["18:22", "Rahul", "Then v2.3 won't make Thursday. Let's talk tomorrow."],
]);

meeting(4, 3, "10:00", "v2.3 go/no-go", [
  ["Rahul", "Decision is no-go for Thursday. The offline sync crash needs a fix and a day of testing."],
  ["Meera", "Brightline won't mind a few days; they're not live yet."],
  ["Shane", `Agreed. New release date: ${day(5, 1)}.`],
]);

email(5, 1, "Kestrel v2.3 is live", [
  ["17:30", "Meera", "Hi all, v2.3 is out today. Offline mode is on for everyone and the Android 12 crash is fixed. The new route view is behind a flag, on for 10 percent of users."],
  ["17:52", "Tom", "Great news. I'll tell Brightline."],
]);

// ---------------------------------------------------------------------------
// Storyline 5: a staging key leak. Found Tue 6 Oct, postmortem Wed 7 Oct.

whatsapp(3, 2, "Kestrel eng", [
  ["14:03", "Kabir", "Heads up: a staging API key was in a public gist from a debug script. I've revoked it."],
  ["14:05", "Rahul", "Was anything accessed with it?"],
  ["15:48", "Kabir", "Logs show no use of it. New key is in the vault. Rotation took under two hours from when I found it."],
]);

meeting(3, 3, "16:30", "Staging key incident postmortem", [
  ["Kabir", "Root cause: a debug script with the staging key was pasted into a public gist. No customer data was reachable from staging."],
  ["Rahul", "We were lucky. We should catch this before it leaves a laptop."],
  ["Kabir", `Action: I'll add secret scanning to CI by ${day(4, 5)}.`],
  ["Rahul", "Action: I'll run a short session on handling keys for the whole team."],
  ["Shane", "Agreed on both. No blame here; the process let it through."],
]);

email(5, 5, "Secret scanning is on in CI", [
  ["12:00", "Kabir", "Secret scanning now runs on every pull request. It caught two old test keys in history, both already revoked."],
]);

// ---------------------------------------------------------------------------
// Storyline 6: database hosting. No decision on Thu 22 Oct; decided on Wed 4 Nov.

meeting(5, 4, "14:00", "Database hosting review", [
  ["Rahul", "I'd move to a managed database. Backups and failover stop being our problem."],
  ["Kabir", "I disagree. We've never measured how long a restore takes. Let's measure before deciding."],
  ["Shane", "No decision today. Kabir, please time a full restore from last night's backup."],
]);

meeting(7, 3, "14:00", "Database hosting decision", [
  ["Kabir", "A full restore took 47 minutes. That's within what Brightline's contract allows."],
  ["Rahul", "Then I'm fine staying self-hosted for now."],
  ["Shane", "Decided: we stay self-hosted until the end of Q1 and revisit in March. Kabir adds a nightly restore test."],
]);

// ---------------------------------------------------------------------------
// Storyline 7: Q4 goals and the team offsite.

meeting(2, 4, "10:00", "Q4 goals", [
  ["Shane", "Three goals for the quarter."],
  ["Shane", "One: Brightline live with their phase one drivers."],
  ["Shane", "Two: support first response under two hours, from about five hours today."],
  ["Shane", "Three: ship v2.3 and v2.4."],
  ["Meera", "v2.4 should be the reporting dashboard Brightline asked about."],
]);

whatsapp(6, 4, "Kestrel team", [
  ["12:30", "Shane", `Offsite poll: ${OFFSITE} or ${OFFSITE_OTHER}? And Coorg or Chikmagalur?`],
  ["12:34", "Arjun", "First dates, Coorg."],
  ["12:36", "Divya", "First dates. Either place."],
  ["12:41", "Kabir", "I can't do the second dates, so first please."],
  ["12:50", "Nisha", "Coorg!"],
]);

email(7, 3, "Offsite: Coorg in January", [
  ["18:00", "Shane", `Hi all, the offsite is on ${OFFSITE} in Coorg. We leave Bengaluru early on the first day. Please block your calendars.`],
]);

// ---------------------------------------------------------------------------
// Earlier storylines (weeks -11 to 0): v2.2, the H2 hiring plan, and the
// first call with Brightline.

meeting(-9, 3, "11:00", "Release planning v2.2", [
  ["Meera", `v2.2 is the faster sync engine plus the new onboarding screens. Target release is ${day(-6, 1)}.`],
  ["Rahul", "The sync engine is on track. Onboarding screens depend on Arjun's final designs."],
  ["Arjun", "Final onboarding designs will be ready by the end of next week."],
  ["Shane", "Good. We keep the date unless the sync engine slips."],
]);

email(-6, 1, "Kestrel v2.2 is live", [
  ["17:00", "Meera", "Hi all, v2.2 shipped today, on schedule: the new sync engine and the onboarding screens are out to everyone."],
]);

meeting(-4, 4, "15:00", "Hiring plan for H2", [
  ["Shane", "Two hires for the rest of the year and early next: a support lead and a backend engineer."],
  ["Nisha", "Support first, please. The queue is growing every week."],
  ["Shane", "Agreed: we hire the support lead in Q4 and the backend engineer in Q1."],
]);

meeting(-1, 2, "12:00", "Brightline intro call", [
  ["Tom", "Thanks for the time, Priya. You mentioned your drivers still use paper delivery sheets."],
  ["Priya (Brightline)", "Yes, across three hubs. We'd want to start with a pilot at the Whitefield hub."],
  ["Shane", "That fits how we usually roll out. Tom will send a proposal."],
  ["Tom", `I'll send it by ${day(-1, 5)}.`],
]);

email(-1, 5, "Proposal for Brightline", [
  ["16:30", "Tom", "Hi Priya, attached is our proposal for the Whitefield pilot, with a nine-week rollout plan."],
  ["18:05", "Priya (Brightline)", "Thanks Tom. We'll review it and come back next week."],
]);

email(0, 4, "Brightline: signed", [
  ["14:00", "Tom", `Brightline signed today. Kickoff is booked for ${day(1, 2)} at 15:00.`],
  ["14:10", "Shane", "Brilliant work, Tom."],
]);

// Routine weeks before the main storylines: support numbers and updates.
const hoursAndMinutes = (minutes: number) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
const earlyUpdates = [
  "v2.2 scope agreed: faster sync engine and new onboarding screens.",
  "Sync engine prototype running on staging.",
  "v2.2 planning done; release set for early August.",
  "Onboarding designs final. Sync engine in testing.",
  "Release candidate for v2.2 cut.",
  "v2.2 shipped on schedule.",
  "Fixing small v2.2 bugs. Crash rate back to normal.",
  "H2 hiring plan agreed: support lead in Q4, backend engineer in Q1.",
  "Help centre articles updated for the new onboarding.",
  "Quiet week: performance work and bug fixes.",
  "First call with Brightline Logistics. Proposal sent.",
  "Brightline signed. Kickoff booked.",
];
let earliestResponse = "";
for (let week = FIRST_WEEK; week <= 0; week += 1) {
  const total = 28 + Math.floor(random() * 15);
  const response = hoursAndMinutes(5 * 60 + Math.floor(random() * 40));
  if (week === FIRST_WEEK) earliestResponse = response;
  email(week, 5, "Support weekly summary", [
    ["17:00", "Nisha", `Support summary for the week of ${day(week, 1)}: ${total} tickets in total. No tickets about the CSV export bug. Median first response time: ${response}.`],
  ]);
  email(week, 5, "Weekly product update", [["18:30", "Meera", earlyUpdates[week - FIRST_WEEK]!]]);
}

// ---------------------------------------------------------------------------
// Weekly emails: support numbers (export-bug tickets peak in week 4, then
// fall after v2.3) and the product update.

const support = [
  { total: 41, exportBug: 0, response: "4h 50m" },
  { total: 38, exportBug: 0, response: "4h 35m" },
  { total: 52, exportBug: 9, response: "5h 10m" },
  { total: 47, exportBug: 14, response: "4h 55m" },
  { total: 35, exportBug: 6, response: "3h 40m" },
  { total: 29, exportBug: 2, response: "3h 05m" },
  { total: 33, exportBug: 0, response: "2h 20m" },
  { total: 26, exportBug: 0, response: "1h 50m" },
];
support.forEach((week, index) => {
  const lines = [
    `Support summary for the week of ${day(index + 1, 1)}: ${week.total} tickets in total.`,
    week.exportBug > 0 ? `${week.exportBug} of them were about the CSV export bug.` : "No tickets about the CSV export bug.",
    `Median first response time: ${week.response}.`,
  ];
  if (index === 6) lines.push("Anita joined this week and took the European shift on three days.");
  email(index + 1, 5, "Support weekly summary", [["17:00", index >= 6 ? "Anita" : "Nisha", lines.join(" ")]]);
});

const productUpdates = [
  "Kicked off Brightline. Go-live target set. Started v2.3 planning.",
  "Brightline order sync works in the sandbox. Q4 goals agreed. Support lead role posted.",
  "Staging key incident handled; postmortem done. v2.3 scope agreed with the route view behind a flag.",
  "v2.3 slipped after an Android 12 crash. Offer made for the support lead role.",
  "v2.3 shipped. Office move to HSR Layout decided. Secret scanning live in CI.",
  `Brightline go-live moved to ${GO_LIVE} with 150 drivers.`,
  "Anita started as support lead. Database stays self-hosted until the end of Q1. Offsite dates set.",
  "Brightline user acceptance testing started. Three bugs, none blocking.",
];
productUpdates.forEach((text, index) => {
  email(index + 1, 5, "Weekly product update", [["18:30", "Meera", text]]);
});

email(5, 1, "Leave: Arjun", [
  ["09:00", "Arjun", `Hi Shane, I'd like to take ${day(5, 4)} and ${day(5, 5)} off for a family wedding.`],
  ["09:20", "Shane", "Approved. Enjoy the wedding."],
]);

email(6, 1, "Laptop for Anita", [
  ["11:00", "Tom", `Ordering a laptop for Anita so it's ready on ${day(7, 1)}. Same model as Nisha's.`],
]);

email(7, 5, "Desk layout for HSR", [
  ["15:00", "Arjun", `Layout attached: 30 desks in four pods, plus the meeting room. Support sits by the window. Move day is still ${MOVE_DAY}.`],
]);

// ---------------------------------------------------------------------------
// Daily standups: routine work, generated from each person's tasks per week.

const TEAM = ["Rahul", "Kabir", "Divya", "Arjun", "Nisha"];
const tasks: { [person: string]: [number, number, string][] } = {
  Rahul: [
    [-11, -6, "the new sync engine"],
    [-6, -4, "v2.2 bug fixes"],
    [-3, 0, "sync performance work"],
    [-11, 0, "code reviews"],
    [1, 2, "Brightline order sync"],
    [2, 4, "status updates for Brightline"],
    [3, 4, "v2.3 release prep"],
    [4, 6, "photo upload retries on weak networks"],
    [7, 8, "fixing Brightline UAT bugs"],
    [1, 8, "code reviews"],
  ],
  Kabir: [
    [-11, -5, "the job queue rewrite"],
    [-6, -2, "API rate limiting"],
    [-3, 0, "database index tuning"],
    [1, 3, "the order sync queue"],
    [3, 4, "secret scanning in CI"],
    [5, 6, "load tests for 300 drivers"],
    [5, 7, "timing a full database restore"],
    [7, 8, "the nightly restore test"],
  ],
  Divya: [
    [-11, -6, "the v2.2 Android build"],
    [-6, -3, "crash reports from v2.2"],
    [-3, 0, "app start-up time"],
    [1, 3, "offline mode"],
    [3, 4, "testing on older Android phones"],
    [4, 5, "the Android 12 offline sync crash"],
    [5, 7, "the proof-of-delivery camera screen"],
    [7, 8, "UAT fixes on Android"],
  ],
  Arjun: [
    [-11, -8, "the onboarding screen designs"],
    [-8, -4, "the new icon set"],
    [-4, 0, "first route view sketches"],
    [1, 3, "route view designs"],
    [3, 5, "the proof-of-delivery photo flow"],
    [5, 7, "the HSR desk layout"],
    [6, 8, "reporting dashboard sketches for v2.4"],
  ],
  Nisha: [
    [-11, 8, "the support queue"],
    [-7, -3, "help articles for the new onboarding"],
    [3, 5, "CSV export bug reports"],
    [6, 7, "onboarding docs for the new support lead"],
    [7, 8, "the help centre refresh"],
  ],
};
const verbs = ["Working on", "Continuing", "Still on", "Picking up", "Finishing"];
const blockers = ["No blockers.", "No blockers.", "No blockers.", "Waiting on a review.", "Blocked on sandbox access for an hour, sorted now."];

for (let week = FIRST_WEEK; week <= WEEKS; week += 1) {
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    const turns: [string, string][] = [["Shane", "Quick round, please."]];
    const present = week >= 7 ? [...TEAM, "Anita"] : TEAM;
    for (const person of present) {
      // Arjun was on leave on Thu 22 and Fri 23 Oct.
      if (person === "Arjun" && week === 5 && weekday >= 4) continue;
      if (person === "Anita") {
        turns.push(["Anita", `${pick(verbs)} the European shift handover and ${pick(["ticket tagging", "macros", "the escalation rota"])}. No blockers.`]);
        continue;
      }
      const active = tasks[person]!.filter(([from, to]) => week >= from && week <= to).map(([, , task]) => task);
      turns.push([person, `Yesterday: ${pick(active)}. Today: ${pick(verbs).toLowerCase()} ${pick(active)}. ${pick(blockers)}`]);
    }
    if (week === 5 && weekday === 4) turns.push(["Shane", "Arjun is on leave today and tomorrow."]);
    meeting(week, weekday, "09:30", "Daily standup", turns);
  }
}

// ---------------------------------------------------------------------------
// Everyday WhatsApp chatter in the team group.

const chatter: [string, string][] = [
  ["Kabir", "Lunch order going in at 12:30. Anyone want anything?"],
  ["Divya", "Who has the USB-C to HDMI adapter?"],
  ["Arjun", "It's in the meeting room drawer."],
  ["Nisha", "Running 15 minutes late, traffic on the ORR."],
  ["Rahul", "Main build is green again."],
  ["Tom", "Cake in the kitchen, it's my birthday."],
  ["Meera", "Reminder: demo at 4 today."],
  ["Kabir", "Wifi is back."],
  ["Divya", "Can someone review my pull request?"],
  ["Rahul", "Reviewed, two small comments."],
  ["Arjun", "New icons are in the design file."],
  ["Nisha", "Working from home tomorrow."],
  ["Tom", "Courier for Kestrel is at reception."],
  ["Meera", "Coffee machine is broken again."],
];
const chatterDays: [number, number][] = [
  [1, 1], [1, 3], [1, 4], [2, 1], [2, 5], [3, 1], [3, 5], [4, 1], [4, 4], [5, 2],
  [5, 5], [6, 1], [6, 2], [6, 5], [7, 2], [7, 4], [7, 5], [8, 2], [8, 3], [8, 4],
];
// Two days a week in the earlier, routine weeks.
for (let week = FIRST_WEEK; week <= 0; week += 1) {
  const first = 1 + Math.floor(random() * 3);
  chatterDays.push([week, first], [week, first + 2]);
}
for (const [week, weekday] of chatterDays) {
  const count = 3 + Math.floor(random() * 4);
  const messages: [string, string, string][] = [];
  for (let index = 0; index < count; index += 1) {
    const [speaker, text] = pick(chatter);
    const minute = String(10 + index * 7).padStart(2, "0");
    messages.push([`11:${minute}`, speaker, text]);
  }
  whatsapp(week, weekday, "Kestrel team", messages);
}

// ---------------------------------------------------------------------------
// Write the file and the questions.

records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
const file = {
  description:
    "Large fictional sample for testing recall at scale. Kestrel Works, Brightline Logistics and every person and event here are made up. Generated by evals/make-large-sample.ts.",
  records,
};
writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);

const questions: [string, string][] = [
  ["When is Brightline going live?", `${GO_LIVE}. It was ${FIRST_GO_LIVE} until the go-live review on ${day(6, 2)}; Shane confirmed by email on ${day(6, 3)}.`],
  ["How many drivers are in Brightline's phase one?", `150 since ${day(6, 2)} (the Sarjapur hub joined). It was 120 at the kickoff on ${day(1, 2)}.`],
  ["Who did we hire as support lead, and when did they start?", `Anita. Offer decided ${day(4, 5)}, accepted ${day(5, 2)}, started ${day(7, 1)}.`],
  ["Who wanted Leo for the support lead role?", `Meera (WhatsApp, ${day(4, 3)}); Nisha preferred Anita.`],
  ["Which office are we moving to, and when?", `HSR Layout, decided ${day(5, 3)}. Move day ${MOVE_DAY}.`],
  ["What did we decide about the office on 29 September?", `Nothing: no decision at the ${day(2, 2)} meeting; Tom was to visit both.`],
  ["When did v2.3 ship, and why was it late?", `${day(5, 1)}. Planned for ${day(4, 4)}; an Android 12 offline sync crash (found ${day(4, 2)}) made it a no-go on ${day(4, 3)}.`],
  ["What happened with the staging key?", `Found and revoked ${day(3, 2)}, rotated in under two hours, no use seen. Postmortem ${day(3, 3)}: secret scanning in CI (Kabir), key-handling session (Rahul). Scanning live ${day(5, 5)}.`],
  ["Are we moving to a managed database?", `No. ${day(5, 4)}: no decision. ${day(7, 3)}: stay self-hosted until end of Q1 (restore took 47 minutes), revisit in March.`],
  ["How many export bug tickets did we get in the week of 12 October?", "14 (of 47 tickets)."],
  ["How has support first response time changed?", `From ${earliestResponse} (week of ${day(FIRST_WEEK, 1)}) and 4h 50m (week of ${day(1, 1)}) down to 1h 50m (week of ${day(8, 1)}).`],
  ["When did we first talk to Brightline?", `${day(-1, 2)}, the Brightline intro call (Tom, Shane, Priya). Proposal sent ${day(-1, 5)}; signed ${day(0, 4)}.`],
  ["When did v2.2 ship?", `${day(-6, 1)}, on schedule (planned at the ${day(-9, 3)} release planning).`],
  ["What was the hiring plan for H2?", `From ${day(-4, 4)}: a support lead in Q4 and a backend engineer in Q1.`],
  ["When and where is the offsite?", `${OFFSITE}, Coorg (email ${day(7, 3)}).`],
  ["Was Arjun at standup on 23 October?", `No, on leave ${day(5, 4)} and ${day(5, 5)}.`],
  ["What did Priya ask for on 5 October?", `Proof-of-delivery photos (Brightline weekly sync, ${day(3, 1)}). Meera estimated a week; Priya confirmed it on ${day(4, 1)}.`],
  ["What are the Q4 goals?", `From ${day(2, 4)}: Brightline live; first response under two hours; ship v2.3 and v2.4.`],
  ["What did we discuss on Sunday 25 October?", `Nothing is stored for ${day(5, 7)}: the answer should say so and give the stored range, not invent a meeting.`],
  ["What did we decide about pricing for Brightline?", "No record covers pricing: the answer should say so, not guess."],
];
const markdown = [
  "# Large sample: questions and expected answers",
  "",
  "Load `data/large-sample.json` with Upload JSON, then ask these. Everything in the file is fictional.",
  `It holds ${records.length} records from ${day(FIRST_WEEK, 1)} to ${day(8, 5)} 2026: meetings, daily standups, WhatsApp groups and email threads.`,
  "It is larger than the agent's record budget, so each answer is built from the records retrieval picks. Several answers changed over time; the expected answer is the latest, and a good answer says what it changed from.",
  "",
  "| Question | Expected answer |",
  "|---|---|",
  ...questions.map(([question, answer]) => `| ${question} | ${answer} |`),
  "",
].join("\n");
writeFileSync(QUESTIONS_OUT, markdown);

console.log(`Wrote ${records.length} records to ${OUT}`);
