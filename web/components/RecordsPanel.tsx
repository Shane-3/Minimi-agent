import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RecordSummary } from "../../shared/types.ts";
import { count, dayLabel, rangeLabel, timeLabel } from "../format.ts";
import type { RecordsState } from "../state/records.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import styles from "./RecordsPanel.module.css";
import { TYPE_LABELS } from "./recordTypes.ts";
import { RecordViewer } from "./RecordViewer.tsx";

export interface ViewedRecord {
  id: string;
  quotes: string[];
}

interface RecordsPanelProps {
  open: boolean;
  state: RecordsState;
  timezone: string;
  /** The record shown in the viewer, or null for the list. */
  viewing: ViewedRecord | null;
  onView: (record: ViewedRecord | null) => void;
  onClose: () => void;
  onReload: () => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
  onLoadSample: () => void;
  onUpload: (file: File) => void;
}

type Confirming = { kind: "remove"; id: string } | { kind: "clear" } | null;

/**
 * Stored records, newest first, grouped by day. A modal <dialog>: it takes
 * focus, closes on Escape, and the browser returns focus to the trigger.
 */
export function RecordsPanel(props: RecordsPanelProps) {
  const { open, state, timezone, viewing, onView, onClose, onReload, onRemove, onClearAll, onLoadSample, onUpload } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const importing = state.import.phase === "importing";

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const uploadButton = (
    <button type="button" className="button" onClick={() => fileInput.current?.click()} disabled={importing}>
      Upload JSON
    </button>
  );

  return (
    <dialog
      ref={dialog}
      className={styles.panel}
      aria-labelledby="records-heading"
      onCancel={(event) => {
        event.preventDefault();
        // Escape in the confirmation inside closes only the confirmation.
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.inner}>
        <div className={styles.top}>
          <h2 id="records-heading" className={styles.heading}>
            Records
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close records">
            <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          {viewing !== null ? (
            <RecordViewer recordId={viewing.id} quotes={viewing.quotes} timezone={timezone} onBack={() => onView(null)} />
          ) : (
            <RecordList
              state={state}
              timezone={timezone}
              onView={onView}
              onReload={onReload}
              onAskRemove={(id) => setConfirming({ kind: "remove", id })}
            >
              <div className={styles.empty}>
                <p>No records yet</p>
                <div className={styles.emptyActions}>
                  <button type="button" className="button button-primary" onClick={onLoadSample} disabled={importing}>
                    Load sample history
                  </button>
                  {uploadButton}
                </div>
              </div>
            </RecordList>
          )}
        </div>

        {viewing === null && (
          <div className={styles.footer}>
            <ImportStatus state={state} timezone={timezone} />
            {state.actionError !== null && (
              <p className={styles.error} role="alert">
                {state.actionError}
              </p>
            )}
            <div className={styles.footerButtons}>
              {uploadButton}
              <button
                type="button"
                className="button"
                onClick={() => setConfirming({ kind: "clear" })}
                disabled={state.records.length === 0}
              >
                Clear all
              </button>
            </div>
          </div>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file again still fires a change.
          event.target.value = "";
          if (file !== undefined) onUpload(file);
        }}
      />

      <ConfirmDialog
        open={confirming !== null}
        message={
          confirming?.kind === "clear"
            ? "Remove all records and chats? This can't be undone."
            : "Remove this record? The agent will no longer remember it."
        }
        confirmLabel={confirming?.kind === "clear" ? "Clear all" : "Remove"}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming?.kind === "remove") onRemove(confirming.id);
          if (confirming?.kind === "clear") onClearAll();
          setConfirming(null);
        }}
      />
    </dialog>
  );
}

interface RecordListProps {
  state: RecordsState;
  timezone: string;
  onView: (record: ViewedRecord) => void;
  onReload: () => void;
  onAskRemove: (id: string) => void;
  /** Shown when there are no records. */
  children: ReactNode;
}

function RecordList({ state, timezone, onView, onReload, onAskRemove, children }: RecordListProps) {
  if (state.phase === "loading") return <p className="meta">Loading records</p>;
  if (state.phase === "error") {
    return (
      <div className={styles.error} role="alert">
        <p>{state.loadError}</p>
        <button type="button" className="link-button" onClick={onReload}>
          Try again
        </button>
      </div>
    );
  }
  if (state.records.length === 0) return <>{children}</>;

  // The server lists newest first, so groups come out newest first too.
  const groups = new Map<string, RecordSummary[]>();
  for (const record of state.records) {
    const day = dayLabel(record.startedAt, timezone);
    groups.set(day, [...(groups.get(day) ?? []), record]);
  }

  return (
    <div className={styles.groups}>
      {[...groups].map(([day, records]) => (
        <section key={day} aria-label={day}>
          <h3 className={styles.day}>{day}</h3>
          <ul className={styles.rows}>
            {records.map((record) => {
              const removing = state.removing.includes(record.id);
              return (
                <li key={record.id} className={`${styles.row} ${removing ? styles.removing : ""}`}>
                  <button type="button" className={styles.open} onClick={() => onView({ id: record.id, quotes: [] })} disabled={removing}>
                    <span className={styles.type}>{TYPE_LABELS[record.type]}</span>
                    <span className={styles.title}>{record.title}</span>
                    <span className={styles.time}>{removing ? "Removing" : timeLabel(record.startedAt, timezone)}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => onAskRemove(record.id)}
                    disabled={removing}
                    aria-label={`Remove ${record.title}`}
                  >
                    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
                      <path
                        d="M5 6h10M8 6V4.5h4V6M6.5 6l.7 9.5h5.6l.7-9.5"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** An upload: in progress, its result, or why it failed. */
function ImportStatus({ state, timezone }: { state: RecordsState; timezone: string }) {
  const current = state.import;
  if (current.phase === "importing") {
    return (
      <p className="meta" role="status">
        Loading records
      </p>
    );
  }
  if (current.phase === "error") {
    return (
      <div className={styles.error} role="alert">
        <p>{current.message}</p>
        {current.details.length > 0 && (
          <ul>
            {current.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (current.phase === "success") {
    const { imported, range, warnings } = current.result;
    return (
      <div className="meta" role="status">
        <p>
          Loaded {count(imported, "record")} · {rangeLabel(range.from, range.to, timezone)}
        </p>
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </div>
    );
  }
  return null;
}
