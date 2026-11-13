import type { Source } from "../../shared/types.ts";
import styles from "./Sources.module.css";

/**
 * "Mon 9 Nov" from a YYYY-MM-DD page date, with the year when it is not this
 * year (a page can be years old). A calendar day, so no timezone applies.
 */
function sourceDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, date!));
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .formatToParts(utc);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const label = `${part("weekday")} ${part("day")} ${part("month")}`;
  return year === new Date().getFullYear() ? label : `${label} ${part("year")}`;
}

/** The web pages an answer links to: site, title and date or "undated" (U4). */
export function Sources({ sources }: { sources: Source[] }) {
  return (
    <section className={styles.sources} aria-label="Sources">
      <h2 className={styles.heading}>Sources</h2>
      <ul className={styles.list}>
        {sources.map((source) => (
          <li key={source.url} className={styles.item}>
            <span className={styles.site}>
              {source.site}
              {source.official && <span className={styles.official}>official</span>}
            </span>
            <a href={source.url} target="_blank" rel="noopener noreferrer" className={styles.title}>
              {source.title}
            </a>
            <span className={styles.date}>{source.publishedDate === null ? "undated" : sourceDate(source.publishedDate)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
