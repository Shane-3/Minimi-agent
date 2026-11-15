import { useId, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Check, MemoryChip as Chip } from "../../shared/types.ts";
import { MARK_PREFIX, markUnverified } from "../marks.ts";
import type { AssistantMessage as Message } from "../state/chat.ts";
import styles from "./AssistantMessage.module.css";
import { MemoryChip } from "./MemoryChip.tsx";
import { Quote } from "./Quote.tsx";
import { Sources } from "./Sources.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { VerificationNote } from "./VerificationNote.tsx";

// GitHub-style Markdown: answers use tables for action items and prices.
const REMARK_PLUGINS = [remarkGfm];

interface AssistantMessageProps {
  message: Message;
  timezone: string;
  onOpenChip: (chip: Chip, quotes: string[]) => void;
  /** Null except on the last answer: only the newest question can be asked again. */
  onRetry: (() => void) | null;
  /** Asks the question again as a new message, after some searches failed. Null while an answer streams. */
  onCheckAgain: (() => void) | null;
}

/** An answer as plain text in the column: chips, text, sources, then the verification note. */
export function AssistantMessage({ message, timezone, onOpenChip, onRetry, onCheckAgain }: AssistantMessageProps) {
  const checks = message.checks ?? [];
  const quotes = checks.filter((check) => check.kind === "quote").map((check) => check.text);

  return (
    <article className={styles.answer} aria-label="Answer">
      {message.chips.length > 0 && (
        <div className={styles.chips}>
          {message.chips.map((chip) => (
            <MemoryChip key={chip.id} chip={chip} timezone={timezone} onOpen={() => onOpenChip(chip, quotes)} />
          ))}
        </div>
      )}

      {message.text !== "" && (
        <div className={styles.body}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={components(checks)}>{markUnverified(message.text, checks)}</Markdown>
        </div>
      )}

      {message.status !== null && <StatusLine text={message.status} />}

      {message.sources.length > 0 && <Sources sources={message.sources} />}
      {message.searchFailed !== null && (
        <p className={styles.searchFailed}>
          Couldn't check {listOf(message.searchFailed.entities)}.{" "}
          {message.searchFailed.retryable && onCheckAgain !== null && (
            <button type="button" className="link-button" onClick={onCheckAgain}>
              Check again
            </button>
          )}
        </p>
      )}
      {message.checks !== undefined && <VerificationNote checks={message.checks} />}

      <Ending message={message} onRetry={onRetry} />
    </article>
  );
}

/** "A", "A and B", "A, B and C". */
function listOf(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/** What is said under an answer that did not finish normally. */
function Ending({ message, onRetry }: { message: Message; onRetry: (() => void) | null }) {
  const retry = onRetry !== null && (
    <button type="button" className="link-button" onClick={onRetry}>
      Retry
    </button>
  );
  switch (message.phase) {
    case "stopped":
      return <p className={styles.ending}>Stopped.</p>;
    case "incomplete":
      return (
        <p className={styles.ending}>
          Connection lost. This answer is incomplete. {retry}
        </p>
      );
    case "error":
      return (
        <p className={`${styles.ending} ${styles.error}`}>
          {message.error?.message} {message.error?.retryable === true && retry}
        </p>
      );
    default:
      return null;
  }
}

/** Links open in a new tab; links to "#check-<n>" are unverified marks. */
function components(checks: Check[]): Components {
  return {
    a({ href, children }) {
      if (href?.startsWith(MARK_PREFIX) === true) {
        const check = checks[Number(href.slice(MARK_PREFIX.length))];
        return <UnverifiedMark reason={check?.reason ?? "Not found in the sources I read"}>{children}</UnverifiedMark>;
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    blockquote({ children }) {
      return <Quote>{children}</Quote>;
    },
  };
}

/** Dotted underline; the reason shows on hover and on keyboard focus. */
function UnverifiedMark({ reason, children }: { reason: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className={styles.unverified} tabIndex={0} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className={styles.tip}>
        {reason}
      </span>
    </span>
  );
}
