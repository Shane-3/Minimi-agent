import styles from "./UserMessage.module.css";

/** The user's message: a light block on the right. Line breaks are kept as typed. */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className={styles.row}>
      <p className={styles.message}>{text}</p>
    </div>
  );
}
