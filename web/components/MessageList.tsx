import type { MemoryChip } from "../../shared/types.ts";
import type { ChatMessage } from "../state/chat.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";
import styles from "./MessageList.module.css";
import { UserMessage } from "./UserMessage.tsx";

interface MessageListProps {
  messages: ChatMessage[];
  timezone: string;
  onOpenChip: (chip: MemoryChip, quotes: string[]) => void;
  /** Null while an answer streams. */
  onRetry: ((answerKey: string) => void) | null;
}

export function MessageList({ messages, timezone, onOpenChip, onRetry }: MessageListProps) {
  return (
    <div className={styles.list}>
      {messages.map((message, index) =>
        message.kind === "user" ? (
          <UserMessage key={message.key} text={message.text} />
        ) : (
          <AssistantMessage
            key={message.key}
            message={message}
            timezone={timezone}
            onOpenChip={onOpenChip}
            onRetry={onRetry !== null && index === messages.length - 1 ? () => onRetry(message.key) : null}
          />
        ),
      )}
    </div>
  );
}
