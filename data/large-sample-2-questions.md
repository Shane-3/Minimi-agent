# Second large sample: questions and expected answers

Load `data/large-sample-2.json` with Upload JSON. Everything in the file is fictional.
It holds 121 records (one is a duplicate) from Mon 27 Jul to Fri 13 Nov 2026: meetings, WhatsApp groups, email threads and founder notes.

What the import should report:
- 120 records loaded, and "1 record was already loaded and was skipped."
- 2 records had no timezone and were read in your browser's timezone (the founder notes of Fri 28 Aug and Fri 9 Oct).
- "All-hands: Q3 review" is too long to read in one go; answers about it use the parts that match.

| Question | Expected answer |
|---|---|
| When did all 400 battery packs arrive? | 250 on Wed 16 Sep and the last 150 on Wed 7 Oct. Originally due Mon 24 Aug; Voltcell moved it to Mon 14 Sep on Thu 20 Aug. Three packs were dented. |
| When was the M2 launched, and why not on the original date? | Fri 9 Oct. It was planned for Fri 2 Oct; on Thu 24 Sep it moved because the certificate was expected on Tue 6 Oct. |
| How many preorders did we get at launch? | 85 on launch day (Fri 9 Oct), 112 by noon on Sat 10 Oct. |
| What was wrong with batch B7, and how many bikes were recalled? | Frayed brake cables on 12 bikes (found Mon 28 Sep); all 340 B7 bikes recalled on Tue 29 Sep. |
| How many recalled bikes have been fixed? | 334 of 340 as of Fri 6 Nov; 6 customers unreachable. Target moved from Tue 20 Oct to Fri 30 Oct. |
| Who is our new CTO? | Farah, started Mon 2 Nov (accepted Wed 30 Sep). Dev was offered the role first on Mon 14 Sep and declined on Fri 18 Sep. |
| Who wanted Dev as CTO? | Ishaan (WhatsApp, Fri 11 Sep); Kavya preferred Farah. |
| Where is the warehouse moving, and when? | Chakan, decided and lease signed Wed 14 Oct; move day Sat 21 Nov. |
| What did we decide about the warehouse on 8 September? | Nothing: no decision on Tue 8 Sep; Sana was to get lease terms for Chakan and Talegaon. |
| Are we opening a Bengaluru showroom? | Not yet: no showroom until Q2 2027, revisit in March (decided Thu 22 Oct). First discussed Wed 12 Aug with no decision. |
| How many bikes does QuickParcel have now? | 80 from Mon 9 Nov (pilot of 30 from Mon 12 Oct; extension agreed Mon 26 Oct). |
| When did Atelier Mar send the final logo files? | Wed 7 Oct at 04:10 in India (Tue 6 Oct, 23:40 in Lisbon). Tests timezones: the answer should give the India day. |
| What did Kavya say about the warranty at the all-hands? | From 1 January the battery warranty goes from two years to three, including every M2 already sold (All-hands, Fri 30 Oct). The record is too long to read whole, so the answer should say it covers part of it. |
| How many bikes did we assemble in the week of 21 September? | 47 (reported at the ops review on Mon 28 Sep). |
| What was the top support issue in the week of 12 October? | The B7 recall (support digest Fri 16 Oct). |
| What did we discuss on Sunday 18 October? | Nothing is stored that day: the answer should say so, give the stored range and the nearest days with records. |
| How much did the Voltcell order cost? | No record states a price: the answer should say so, not guess. |
| Who has been the biggest supply risk? | Voltcell: delayed from Mon 24 Aug to Mon 14 Sep, then shipped in two parts. Ishaan's note of Fri 18 Sep calls it "our biggest single risk". |
