import { useLayoutEffect, useState, type KeyboardEvent, type Ref, type RefObject } from "react";
import { MESSAGE_COUNTER_FROM, MESSAGE_MAX_CHARS } from "../../shared/limits.ts";
import styles from "./Composer.module.css";

interface ComposerProps {
  streaming: boolean;
  /** Why sending is off right now (offline, no model key), or null. */
  blocked: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null> & Ref<HTMLTextAreaElement>;
}

/** 6 lines of 26px plus the 8px padding top and bottom. */
const MAX_HEIGHT = 6 * 26 + 16;

/** The question box (U6): Enter sends, Shift+Enter adds a line, Stop while an answer streams. */
export function Composer({ streaming, blocked, onSend, onStop, inputRef }: ComposerProps) {
  const [text, setText] = useState("");
  const length = text.length;
  const over = length > MESSAGE_MAX_CHARS;
  const canSend = text.trim() !== "" && !over && blocked === null && !streaming;

  // Grows with the text from 1 to 6 lines, then scrolls.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, inputRef]);

  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing: Enter that confirms an IME word must not send.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <div className={`${styles.box} ${over ? styles.over : ""}`}>
        <textarea
          id="composer-input"
          ref={inputRef}
          className={styles.input}
          rows={1}
          value={text}
          placeholder="Ask about a meeting, a decision, or a date"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby={length >= MESSAGE_COUNTER_FROM ? "composer-counter" : undefined}
          aria-invalid={over}
        />
        {streaming ? (
          <button type="button" className={`${styles.send} ${styles.stop}`} onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className={styles.send} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
      {length >= MESSAGE_COUNTER_FROM && (
        <p id="composer-counter" className={`${styles.counter} ${over ? styles.counterOver : ""}`}>
          {length.toLocaleString("en-GB")} / {MESSAGE_MAX_CHARS.toLocaleString("en-GB")}
          {over && " · Shorten your message to send it"}
        </p>
      )}
    </form>
  );
}
