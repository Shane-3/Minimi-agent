import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/types.ts";
import { chatReducer, initialChat, isStreaming, type AssistantMessage, type ChatState } from "./chat.ts";

const THREAD = "00000000-0000-4000-8000-000000000001";

function asked(): ChatState {
  return chatReducer(initialChat(THREAD), { type: "asked", userKey: "u1", answerKey: "a1", question: "What did we decide?" });
}

function play(state: ChatState, ...events: ChatEvent[]): ChatState {
  return events.reduce((current, event) => chatReducer(current, { type: "event", answerKey: "a1", event }), state);
}

const lastAnswer = (state: ChatState) => state.messages.at(-1) as AssistantMessage;

describe("chatReducer", () => {
  it("adds the question and an answer waiting for its first status", () => {
    const state = asked();
    expect(state.messages.map((message) => message.kind)).toEqual(["user", "assistant"]);
    expect(lastAnswer(state)).toMatchObject({ phase: "pending", text: "", question: "What did we decide?" });
    expect(isStreaming(state)).toBe(true);
  });

  it("shows status until text arrives, then the text, chips, sources and checks", () => {
    let state = play(asked(), { type: "status", text: "Looking through your records" }, { type: "memory", records: [] });
    expect(lastAnswer(state).status).toBe("Looking through your records");

    state = play(state, { type: "delta", text: "Five " }, { type: "delta", text: "tools." });
    expect(lastAnswer(state)).toMatchObject({ phase: "streaming", text: "Five tools.", status: null });

    state = play(
      state,
      { type: "status", text: "Verifying figures" },
      { type: "checks", status: "done", checks: [] },
      { type: "done", messageId: 7, threadId: THREAD },
    );
    expect(lastAnswer(state)).toMatchObject({ phase: "complete", status: null, checks: [], saved: true });
    expect(isStreaming(state)).toBe(false);
  });

  it("records a failed check as null and an unsaved answer", () => {
    const state = play(asked(), { type: "checks", status: "unavailable" }, { type: "done", messageId: null, threadId: THREAD });
    expect(lastAnswer(state)).toMatchObject({ checks: null, saved: false });
  });

  it("keeps the text of a stopped or cut-off answer and marks it", () => {
    const streaming = play(asked(), { type: "delta", text: "Part" });
    expect(lastAnswer(chatReducer(streaming, { type: "ended", answerKey: "a1", how: "stopped" }))).toMatchObject({
      phase: "stopped",
      text: "Part",
    });
    expect(lastAnswer(chatReducer(streaming, { type: "ended", answerKey: "a1", how: "cut" }))).toMatchObject({
      phase: "incomplete",
      text: "Part",
    });
  });

  it("does not let a late end overwrite a finished answer", () => {
    const done = play(asked(), { type: "done", messageId: 1, threadId: THREAD });
    expect(lastAnswer(chatReducer(done, { type: "ended", answerKey: "a1", how: "cut" })).phase).toBe("complete");
  });

  it("shows the server's error, and clears it on retry", () => {
    const failed = play(asked(), { type: "error", code: "unavailable", message: "The answer didn't come through.", retryable: true, threadId: THREAD });
    expect(lastAnswer(failed)).toMatchObject({ phase: "error", error: { message: "The answer didn't come through.", retryable: true } });

    const retried = chatReducer(failed, { type: "retried", answerKey: "a1" });
    expect(lastAnswer(retried)).toMatchObject({ phase: "pending", error: null, question: "What did we decide?" });
    expect(retried.messages).toHaveLength(2);
  });

  it("restores a saved thread, and marks a question left without an answer as incomplete", () => {
    const state = chatReducer(initialChat("other"), {
      type: "restored",
      threadId: THREAD,
      messages: [
        { id: 1, role: "user", text: "First?", ts: null },
        { id: 2, role: "assistant", text: "Yes.", ts: null, meta: { chips: [], sources: [], checks: null } },
        { id: 3, role: "user", text: "Second?", ts: null },
      ],
    });
    expect(state.threadId).toBe(THREAD);
    expect(state.messages.map((message) => [message.kind, message.kind === "assistant" ? message.phase : message.text])).toEqual([
      ["user", "First?"],
      ["assistant", "complete"],
      ["user", "Second?"],
      ["assistant", "incomplete"],
    ]);
    expect((state.messages[1] as AssistantMessage).checks).toBeNull();
    expect((state.messages[3] as AssistantMessage).question).toBe("Second?");
  });
});
