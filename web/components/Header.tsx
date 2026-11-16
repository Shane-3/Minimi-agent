import type { Ref } from "react";
import mark from "../assets/mark.svg";
import styles from "./Header.module.css";

interface HeaderProps {
  recordCount: number | null;
  onOpenRecords: () => void;
  onOpenImport: () => void;
  onNewChat: () => void;
  /** The Records button, which gets focus back when the panel closes. */
  recordsRef: Ref<HTMLButtonElement>;
}

/** The mark, the wordmark, and the actions: upload, records, new chat. */
export function Header({ recordCount, onOpenRecords, onOpenImport, onNewChat, recordsRef }: HeaderProps) {
  const recordsLabel = recordCount === null ? "Records" : `Records (${recordCount})`;
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <img src={mark} alt="" width={24} height={24} />
        <span className={styles.wordmark}>minimi-agent</span>
      </div>
      <nav className={styles.actions} aria-label="Main">
        <button type="button" className={styles.action} onClick={onOpenImport}>
          <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" className={styles.icon}>
            <path d="M10 13V4M6 8l4-4 4 4M4 16h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
          <span className={styles.label}>Upload JSON</span>
        </button>
        <button ref={recordsRef} type="button" className={styles.action} onClick={onOpenRecords}>
          <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" className={styles.icon}>
            <path d="M4 5h12M4 10h12M4 15h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          </svg>
          <span className={styles.label}>{recordsLabel}</span>
        </button>
        <button type="button" className={styles.action} onClick={onNewChat}>
          <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" className={styles.icon}>
            <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          </svg>
          <span className={styles.label}>New chat</span>
        </button>
      </nav>
    </header>
  );
}
