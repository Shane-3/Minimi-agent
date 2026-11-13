import styles from "./StatusLine.module.css";

/** One line of plain progress text with a small orange dot (U2). Announced by the page's live region, not here. */
export function StatusLine({ text }: { text: string }) {
  return (
    <p className={styles.status}>
      <span className={styles.dot} aria-hidden="true" />
      {text}
    </p>
  );
}
