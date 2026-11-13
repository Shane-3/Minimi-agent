import type { Check } from "../../shared/types.ts";
import { verificationNote } from "../marks.ts";
import styles from "./VerificationNote.module.css";

/** One line under an answer about its figures, dates and quotes (U5). Nothing when there was nothing to check. */
export function VerificationNote({ checks }: { checks: Check[] | null }) {
  const note = verificationNote(checks);
  if (note === null) return null;
  return <p className={`${styles.note} ${note.warning ? styles.warning : ""}`}>{note.text}</p>;
}
