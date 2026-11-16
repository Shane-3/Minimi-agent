import { useEffect, useRef, type DragEvent } from "react";
import { IMPORT_MAX_BYTES } from "../../shared/limits.ts";
import { EXTRA_SAMPLES, type ExtraSampleId } from "../../shared/samples.ts";
import { count, rangeLabel } from "../format.ts";
import { EXAMPLE_FILE_NAME, EXAMPLE_JSON } from "../importExample.ts";
import type { ImportState } from "../state/records.ts";
import styles from "./ImportDialog.module.css";

interface ImportDialogProps {
  open: boolean;
  importState: ImportState;
  timezone: string;
  onUpload: (file: File) => void;
  onDrag: (over: boolean) => void;
  /** The small bundled sample, dated to recent days. */
  onLoadSample: () => void;
  onLoadNamedSample: (name: ExtraSampleId) => void;
  onClose: () => void;
}

const FIELDS: [string, string, string][] = [
  ["type", "required", '"meeting", "chat" or "note". Use "chat" for WhatsApp groups and email threads.'],
  ["timestamp", "required", "When it happened, in ISO 8601 with its offset, e.g. 2026-11-09T10:00:00+05:30."],
  ["turns", "one of these two", "Who said what: a list of { speaker, text }, each with an optional timestamp."],
  ["content", "one of these two", 'Plain text instead of turns. Lines like "Asha: ..." become turns; other text is split into paragraphs.'],
  ["title", "optional", "Shown in Records and on answers. Made from the first words when missing."],
  ["participants", "optional", "A list of names."],
];

/** How to shape a file, a ready-made example, and the upload itself (with its result). */
export function ImportDialog({ open, importState, timezone, onUpload, onDrag, onLoadSample, onLoadNamedSample, onClose }: ImportDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importing = importState.phase === "importing";

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const downloadExample = () => {
    const url = URL.createObjectURL(new Blob([EXAMPLE_JSON], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = EXAMPLE_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    onDrag(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) onUpload(file);
  };

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="import-heading"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.inner}>
        <div className={styles.top}>
          <h2 id="import-heading" className={styles.heading}>
            Upload records
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <p className={styles.lede}>
            A JSON file with a list of records: meetings, chats (WhatsApp, email, Slack) or notes. Each record needs a type, a
            timestamp, and either turns or content.
          </p>

          <div
            className={`${styles.drop} ${importState.phase === "dragging" ? styles.dragging : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              onDrag(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDrag(false);
            }}
            onDrop={onDrop}
          >
            <button type="button" className="button button-primary" onClick={() => fileInput.current?.click()} disabled={importing}>
              Choose JSON file
            </button>
            <span className="meta">or drop it here · up to {IMPORT_MAX_BYTES / 1024 / 1024} MB</span>
          </div>

          <ImportResult importState={importState} timezone={timezone} />

          <h3 className={styles.subheading}>Or load a ready-made sample</h3>
          <p className="meta">All made up. Load more than one to see how answers keep them apart.</p>
          <ul className={styles.samples}>
            <li>
              <button type="button" className={styles.sample} onClick={onLoadSample} disabled={importing}>
                <span className={styles.sampleTitle}>Acme and team (small)</span>
                <span className="meta">6 records from the last two weeks: client calls, a CRM shortlist, interviews, a past chat.</span>
              </button>
            </li>
            {EXTRA_SAMPLES.map((sample) => (
              <li key={sample.id}>
                <button type="button" className={styles.sample} onClick={() => onLoadNamedSample(sample.id)} disabled={importing}>
                  <span className={styles.sampleTitle}>{sample.title}</span>
                  <span className="meta">{sample.about}</span>
                </button>
              </li>
            ))}
          </ul>

          <h3 className={styles.subheading}>Example</h3>
          <pre className={styles.example} tabIndex={0} aria-label="Example file">
            <code>{EXAMPLE_JSON}</code>
          </pre>
          <button type="button" className="link-button" onClick={downloadExample}>
            Download this example
          </button>

          <h3 className={styles.subheading}>Fields of each record</h3>
          <dl className={styles.fields}>
            {FIELDS.map(([name, need, about]) => (
              <div key={name} className={styles.field}>
                <dt>
                  <code>{name}</code> <span className="meta">{need}</span>
                </dt>
                <dd>{about}</dd>
              </div>
            ))}
          </dl>

          <h3 className={styles.subheading}>Good to know</h3>
          <ul className={styles.notes}>
            <li>A timestamp without an offset is read in your timezone ({timezone}), and the result says so.</li>
            <li>A record already loaded is skipped, so uploading the same file twice is safe.</li>
            <li>
              A chat export works too: a plain list of <code>{"{ timestamp, role, content }"}</code> messages. Each day becomes one
              chat record.
            </li>
            <li>If anything in the file is wrong, nothing is imported, and the message names the record and field to fix.</li>
          </ul>
        </div>
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
    </dialog>
  );
}

/** The upload in progress, its result, or why it failed. */
function ImportResult({ importState, timezone }: { importState: ImportState; timezone: string }) {
  if (importState.phase === "importing") {
    return (
      <p className={styles.status} role="status">
        Loading records
      </p>
    );
  }
  if (importState.phase === "error") {
    return (
      <div className={`${styles.status} ${styles.error}`} role="alert">
        <p>{importState.message}</p>
        {importState.details.length > 1 && (
          <ul>
            {importState.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (importState.phase === "success") {
    const { imported, range, warnings } = importState.result;
    return (
      <div className={`${styles.status} ${styles.success}`} role="status">
        <p>
          Loaded {count(imported, "record")} · {rangeLabel(range.from, range.to, timezone)}
        </p>
        {warnings.map((warning) => (
          <p key={warning} className="meta">
            {warning}
          </p>
        ))}
      </div>
    );
  }
  return null;
}
