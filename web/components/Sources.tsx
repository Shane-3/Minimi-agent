import type { Source } from "../../shared/types.ts";
import { dayLabel } from "../format.ts";
import styles from "./Sources.module.css";

/**
 * "Mon 9 Nov" from a YYYY-MM-DD page date, with the year when it is not this
 * year (a page can be years old). A calendar day, so it is read in UTC.
 */
function sourceDate(day: string): string {
  return dayLabel(`${day}T00:00:00Z`, "UTC", Number(day.slice(0, 4)) !== new Date().getFullYear());
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
