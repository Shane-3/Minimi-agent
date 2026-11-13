# Large sample: questions and expected answers

Load `data/large-sample.json` with Upload JSON, then ask these. Everything in the file is fictional.
It holds 225 records from Mon 29 Jun to Fri 13 Nov 2026: meetings, daily standups, WhatsApp groups and email threads.
It is larger than the agent's record budget, so each answer is built from the records retrieval picks. Several answers changed over time; the expected answer is the latest, and a good answer says what it changed from.

| Question | Expected answer |
|---|---|
| When is Brightline going live? | Mon 7 Dec. It was Mon 30 Nov until the go-live review on Tue 27 Oct; Shane confirmed by email on Wed 28 Oct. |
| How many drivers are in Brightline's phase one? | 150 since Tue 27 Oct (the Sarjapur hub joined). It was 120 at the kickoff on Tue 22 Sep. |
| Who did we hire as support lead, and when did they start? | Anita. Offer decided Fri 16 Oct, accepted Tue 20 Oct, started Mon 2 Nov. |
| Who wanted Leo for the support lead role? | Meera (WhatsApp, Wed 14 Oct); Nisha preferred Anita. |
| Which office are we moving to, and when? | HSR Layout, decided Wed 21 Oct. Move day Sat 12 Dec. |
| What did we decide about the office on 29 September? | Nothing: no decision at the Tue 29 Sep meeting; Tom was to visit both. |
| When did v2.3 ship, and why was it late? | Mon 19 Oct. Planned for Thu 15 Oct; an Android 12 offline sync crash (found Tue 13 Oct) made it a no-go on Wed 14 Oct. |
| What happened with the staging key? | Found and revoked Tue 6 Oct, rotated in under two hours, no use seen. Postmortem Wed 7 Oct: secret scanning in CI (Kabir), key-handling session (Rahul). Scanning live Fri 23 Oct. |
| Are we moving to a managed database? | No. Thu 22 Oct: no decision. Wed 4 Nov: stay self-hosted until end of Q1 (restore took 47 minutes), revisit in March. |
| How many export bug tickets did we get in the week of 12 October? | 14 (of 47 tickets). |
| How has support first response time changed? | From 5h 11m (week of Mon 29 Jun) and 4h 50m (week of Mon 21 Sep) down to 1h 50m (week of Mon 9 Nov). |
| When did we first talk to Brightline? | Tue 8 Sep, the Brightline intro call (Tom, Shane, Priya). Proposal sent Fri 11 Sep; signed Thu 17 Sep. |
| When did v2.2 ship? | Mon 3 Aug, on schedule (planned at the Wed 15 Jul release planning). |
| What was the hiring plan for H2? | From Thu 20 Aug: a support lead in Q4 and a backend engineer in Q1. |
| When and where is the offsite? | Fri 15 Jan and Sat 16 Jan, Coorg (email Wed 4 Nov). |
| Was Arjun at standup on 23 October? | No, on leave Thu 22 Oct and Fri 23 Oct. |
| What did Priya ask for on 5 October? | Proof-of-delivery photos (Brightline weekly sync, Mon 5 Oct). Meera estimated a week; Priya confirmed it on Mon 12 Oct. |
| What are the Q4 goals? | From Thu 1 Oct: Brightline live; first response under two hours; ship v2.3 and v2.4. |
| What did we discuss on Sunday 25 October? | Nothing is stored for Sun 25 Oct: the answer should say so and give the stored range, not invent a meeting. |
| What did we decide about pricing for Brightline? | No record covers pricing: the answer should say so, not guess. |
