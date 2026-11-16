// The example shown in the upload dialog and offered as a download. A test
// imports it, so the help can never show a format the importer rejects.
// Fictional, like all sample data.

export const EXAMPLE_FILE_NAME = "minimi-example.json";

export const EXAMPLE_JSON = `${JSON.stringify(
  {
    records: [
      {
        type: "meeting",
        title: "Weekly planning",
        timestamp: "2026-11-09T10:00:00+05:30",
        participants: ["Asha", "Ravi"],
        turns: [
          { speaker: "Asha", text: "Let's ship the beta on Friday." },
          { speaker: "Ravi", text: "Agreed. I'll write the release notes by Thursday." },
        ],
      },
      {
        type: "chat",
        title: "WhatsApp: Design team",
        timestamp: "2026-11-10T09:15:00+05:30",
        turns: [
          { speaker: "Meena", text: "New icons are in the shared folder.", timestamp: "2026-11-10T09:15:00+05:30" },
          { speaker: "Asha", text: "Looks good, let's use them in the beta.", timestamp: "2026-11-10T09:20:00+05:30" },
        ],
      },
      {
        type: "note",
        title: "Ideas for Q1",
        timestamp: "2026-11-11T18:30:00+05:30",
        content: "Try a referral programme.\n\nMove support to a shared inbox.",
      },
    ],
  },
  null,
  2,
)}\n`;
