import { useEffect, useRef, useState } from "react";
import type { MemoryRecord } from "../../shared/types.ts";
import { ApiFailure, api } from "../http/client.ts";
import { dayLabel, timeLabel } from "../format.ts";
import { quotedSegmentIds } from "../marks.ts";
import styles from "./RecordViewer.module.css";
import { TYPE_LABELS } from "./recordTypes.ts";

interface RecordViewerProps {
  recordId: string;
  /** Words an answer quoted; the segments holding them are highlighted. */
  quotes: string[];
  timezone: string;
  onBack: () => void;
}

type Loaded = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; record: MemoryRecord };

const SPEAKER_NAMES: { [speaker: string]: string } = { user: "You", assistant: "minimi-agent" };

/** One record in full, scrolled to the quoted segment. */
export function RecordViewer({ recordId, quotes, timezone, onBack }: RecordViewerProps) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const heading = useRef<HTMLHeadingElement>(null);
  const firstQuoted = useRef<HTMLLIElement>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ phase: "loading" });
    api.record(recordId).then(
      (record) => {
        if (current) setLoaded({ phase: "ready", record });
      },
      (error: unknown) => {
        const message = error instanceof ApiFailure ? error.message : "This record can't be read right now.";
        if (current) setLoaded({ phase: "error", message });
      },
    );
    return () => {
      current = false;
    };
  }, [recordId]);

  const quoted = loaded.phase === "ready" ? quotedSegmentIds(loaded.record.segments, quotes) : new Set<number>();
  const firstQuotedId = loaded.phase === "ready" ? loaded.record.segments.find((segment) => quoted.has(segment.id))?.id : undefined;

  useEffect(() => {
    if (loaded.phase !== "ready") return;
    heading.current?.focus();
    firstQuoted.current?.scrollIntoView({ block: "center" });
  }, [loaded]);

  return (
    <div className={styles.viewer}>
      <button type="button" className={`link-button ${styles.back}`} onClick={onBack}>
        All records
      </button>
      {loaded.phase === "loading" && <p className="meta">Loading the record</p>}
      {loaded.phase === "error" && (
        <p className={styles.error} role="alert">
          {loaded.message}
        </p>
      )}
      {loaded.phase === "ready" && (
        <>
          <h2 ref={heading} tabIndex={-1} className={styles.title}>
            {loaded.record.title}
          </h2>
          <p className="meta">
            {TYPE_LABELS[loaded.record.type]} · {dayLabel(loaded.record.startedAt, timezone)} ·{" "}
            {timeLabel(loaded.record.startedAt, timezone)}
          </p>
          {loaded.record.participants.length > 0 && <p className={styles.participants}>{loaded.record.participants.join(", ")}</p>}
          <ol className={styles.segments}>
            {loaded.record.segments.map((segment) => (
              <li
                key={segment.id}
                ref={segment.id === firstQuotedId ? firstQuoted : undefined}
                className={quoted.has(segment.id) ? styles.quoted : undefined}
              >
                {segment.speaker !== null && <span className={styles.speaker}>{SPEAKER_NAMES[segment.speaker] ?? segment.speaker}</span>}
                <p className={styles.text}>{segment.text}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
