// The chat screen's state: the thread's messages and the answer being streamed.
import type { ChatEvent, Check, MemoryChip, Source, ThreadMessage } from "../../shared/types.ts";

export interface UserMessage {
  kind: "user";
  key: string;
  text: string;
}

/**
 * - pending: asked, no answer text yet (the status line shows progress)
 * - streaming: answer text arriving
 * - complete: done
 * - stopped: the user pressed Stop
 * - incomplete: the connection dropped, or the page was reloaded mid-answer
 * - error: the server said the answer failed
 */
export type AnswerPhase = "pending" | "streaming" | "complete" | "stopped" | "incomplete" | "error";

export interface AssistantMessage {
  kind: "assistant";
  key: string;
  /** The question this answers, sent again on Retry. */
  question: string;
  text: string;
  phase: AnswerPhase;
  /** The current step, shown until answer text arrives or the answer ends. */
  status: string | null;
  chips: MemoryChip[];
  sources: Source[];
  /** Undefined until the check reports; null when it could not run. */
  checks: Check[] | null | undefined;
  error: { message: string; retryable: boolean } | null;
  /** False when the server could not save the answer. */
  saved: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ChatState {
  /** Made in the browser, so a thread has its id before the first answer arrives. */
  threadId: string;
  messages: ChatMessage[];
}

export type ChatAction =
  | { type: "new_thread"; threadId: string }
  | { type: "restored"; threadId: string; messages: ThreadMessage[] }
  | { type: "asked"; userKey: string; answerKey: string; question: string }
  | { type: "retried"; answerKey: string }
  | { type: "event"; answerKey: string; event: ChatEvent }
  | { type: "ended"; answerKey: string; how: "stopped" | "cut" | "failed"; message?: string };

let nextKey = 0;
/** Keys for React lists; unique within the page. */
export function makeKey(): string {
  nextKey += 1;
  return `m${nextKey}`;
}

function answer(key: string, question: string): AssistantMessage {
  return {
    kind: "assistant",
    key,
    question,
    text: "",
    phase: "pending",
    status: null,
    chips: [],
    sources: [],
    checks: undefined,
    error: null,
    saved: true,
  };
}

export function initialChat(threadId: string): ChatState {
  return { threadId, messages: [] };
}

/** True while an answer is on its way, so Send shows as Stop. */
export function isStreaming(state: ChatState): boolean {
  const last = state.messages.at(-1);
  return last?.kind === "assistant" && (last.phase === "pending" || last.phase === "streaming");
}

function updateAnswer(state: ChatState, key: string, change: (message: AssistantMessage) => AssistantMessage): ChatState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.kind === "assistant" && message.key === key ? change(message) : message)),
  };
}

function applyEvent(message: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case "status":
      return { ...message, status: event.text };
    case "memory":
      return { ...message, chips: event.records };
    case "delta":
      return { ...message, text: message.text + event.text, phase: "streaming", status: null };
    case "sources":
      return { ...message, sources: event.sources };
    case "checks":
      return { ...message, checks: event.status === "done" ? event.checks : null };
    case "error":
      return { ...message, phase: "error", status: null, error: { message: event.message, retryable: event.retryable } };
    case "done":
      return { ...message, phase: "complete", status: null, saved: event.messageId !== null };
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "new_thread":
      return initialChat(action.threadId);

    case "restored": {
      const messages: ChatMessage[] = [];
      for (const saved of action.messages) {
        if (saved.role === "user") {
          messages.push({ kind: "user", key: makeKey(), text: saved.text });
        } else {
          const question = messages.at(-1)?.kind === "user" ? (messages.at(-1) as UserMessage).text : "";
          messages.push({
            ...answer(makeKey(), question),
            text: saved.text,
            phase: "complete",
            chips: saved.meta?.chips ?? [],
            sources: saved.meta?.sources ?? [],
            checks: saved.meta === undefined ? undefined : saved.meta.checks,
          });
        }
      }
      // A question with no saved answer was cut off by a reload or a failure.
      const last = messages.at(-1);
      if (last?.kind === "user") messages.push({ ...answer(makeKey(), last.text), phase: "incomplete" });
      return { threadId: action.threadId, messages };
    }

    case "asked":
      return {
        ...state,
        messages: [...state.messages, { kind: "user", key: action.userKey, text: action.question }, answer(action.answerKey, action.question)],
      };

    case "retried":
      return updateAnswer(state, action.answerKey, (message) => answer(message.key, message.question));

    case "event":
      return updateAnswer(state, action.answerKey, (message) => applyEvent(message, action.event));

    case "ended":
      return updateAnswer(state, action.answerKey, (message) => {
        // Only an answer still on its way can end this way; done and error already ended it.
        if (message.phase !== "pending" && message.phase !== "streaming") return message;
        if (action.how === "stopped") return { ...message, phase: "stopped", status: null };
        if (action.how === "cut") return { ...message, phase: "incomplete", status: null };
        return { ...message, phase: "error", status: null, error: { message: action.message ?? "", retryable: true } };
      });
  }
}
