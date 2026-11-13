import { useRef, type DragEvent } from "react";
import type { RecordSummary } from "../../shared/types.ts";
import { count, rangeLabel } from "../format.ts";
import type { ImportState } from "../state/records.ts";
import { suggestedQuestions } from "../suggestions.ts";
import styles from "./WelcomeCard.module.css";

interface WelcomeCardProps {
  records: RecordSummary[];
  importState: ImportState;
  timezone: string;
  onLoadSample: () => void;
  onUpload: (file: File) => void;
  onDrag: (over: boolean) => void;
  onStartWithout: () => void;
  onAsk: (question: string) => void;
}

/** First screen: load history, or ask about what is loaded (U1, U7). */
export function WelcomeCard({ records, importState, timezone, onLoadSample, onUpload, onDrag, onStartWithout, onAsk }: WelcomeCardProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const importing = importState.phase === "importing";
  const dragging = importState.phase === "dragging";

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    onDrag(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) onUpload(file);
  };

  const summary = summaryOf(records, importState, timezone);
  const questions = suggestedQuestions(records, timezone);

  return (
    <section
      className={`${styles.card} ${dragging ? styles.dragging : ""}`}
      aria-labelledby="welcome-heading"
      onDragEnter={(event) => {
        event.preventDefault();
        onDrag(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        // Leaving for a child element is not leaving the card.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDrag(false);
      }}
      onDrop={onDrop}
    >
      <h1 id="welcome-heading">What do you want to remember?</h1>
      <p className={styles.lede}>Load your records and ask about any meeting, decision or date.</p>

      {dragging && <p className={styles.dropHint}>Drop the file to load it</p>}

      {summary === null ? (
        <div className={styles.actions}>
          <button type="button" className="button button-primary" onClick={onLoadSample} disabled={importing}>
            Load sample history
          </button>
          <button type="button" className="button" onClick={() => fileInput.current?.click()} disabled={importing}>
            Upload JSON
          </button>
          <button type="button" className="link-button" onClick={onStartWithout} disabled={importing}>
            Start without history
          </button>
        </div>
      ) : (
        <div className={styles.loaded}>
          <p className={styles.summary}>{summary}</p>
          {importState.phase === "success" &&
            importState.result.warnings.map((warning) => (
              <p key={warning} className="meta">
                {warning}
              </p>
            ))}
          {questions.length > 0 && (
            <ul className={styles.questions} aria-label="Suggested questions">
              {questions.map((question) => (
                <li key={question}>
                  <button type="button" className={styles.question} onClick={() => onAsk(question)}>
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {importing && (
        <p className="meta" role="status">
          Loading records
        </p>
      )}
      {importState.phase === "error" && (
        <div className={styles.error} role="alert">
          <p>{importState.message}</p>
          {importState.details.length > 0 && (
            <ul>
              {importState.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

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
    </section>
  );
}

/** "Loaded 4 records · Mon 2 Nov to Tue 10 Nov" after an import, or what is stored. Null when nothing is. */
function summaryOf(records: RecordSummary[], importState: ImportState, timezone: string): string | null {
  if (importState.phase === "success") {
    const { imported, range } = importState.result;
    return `Loaded ${count(imported, "record")} · ${rangeLabel(range.from, range.to, timezone)}`;
  }
  if (records.length === 0) return null;
  const times = records.map((record) => record.startedAt).sort();
  return `${count(records.length, "record")} stored · ${rangeLabel(times[0]!, times.at(-1)!, timezone)}`;
}
