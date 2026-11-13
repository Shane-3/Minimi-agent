import type { ReactNode } from "react";
import styles from "./Quote.module.css";

/**
 * A quoted line from a record. Answers write quotes as
 * `> **Speaker:** "words"`; the bold speaker is shown muted above the words.
 */
export function Quote({ children }: { children?: ReactNode }) {
  return <blockquote className={styles.quote}>{children}</blockquote>;
}
