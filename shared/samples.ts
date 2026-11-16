// The larger samples in samples/, loadable from the upload dialog. The server
// reads only these names, so a request cannot reach any other file.

export const EXTRA_SAMPLES = [
  {
    id: "kestrel-works",
    title: "Kestrel Works",
    about: "A software team over 20 weeks: 239 records of meetings, standups, WhatsApp and email, plus articles, tasks and a journal in other tools' formats.",
  },
  {
    id: "monsoon-bikes",
    title: "Monsoon Bikes",
    about: "An e-bike startup over 16 weeks: 132 records, including tasks, feedback and a Slack thread, a very long all-hands, a duplicate and two records with no timezone.",
  },
] as const;

export type ExtraSampleId = (typeof EXTRA_SAMPLES)[number]["id"];

export const EXTRA_SAMPLE_IDS = EXTRA_SAMPLES.map((sample) => sample.id) as [ExtraSampleId, ...ExtraSampleId[]];
