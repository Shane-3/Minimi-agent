import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, createAgent } from "./loop.ts";

// A stand-in for the SDK's streaming call. Each call to stream() plays the
// next scripted turn: text pieces, then an optional failure or a hang.
interface FakeTurn {
  text?: string[];
  stopReason?: string;
  error?: unknown;
  /** Throw `error` before the piece at this index (0 = before any text). Without it, after all text. */
  errorAt?: number;
  /** Never finish; only an abort ends it. */
  hang?: boolean;
}

function fakeClient(turns: FakeTurn[]) {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: unknown, options?: { signal?: AbortSignal }) {
          calls.push(params);
          const turn = turns.shift() ?? {};
          async function* events() {
            for (const [index, text] of (turn.text ?? []).entries()) {
              if (turn.errorAt === index) throw turn.error;
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
            }
            if (turn.hang) {
              await new Promise((_, reject) => {
                // Like the SDK, honour a signal that is already aborted.
                if (options?.signal?.aborted === true) reject(new Anthropic.APIUserAbortError());
                options?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
              });
            }
            if (turn.error !== undefined && turn.errorAt === undefined) throw turn.error;
          }
          const iterator = events();
          return {
            [Symbol.asyncIterator]: () => iterator,
            finalMessage: async () => ({ stop_reason: turn.stopReason ?? "end_turn", model: "test-model" }),
          };
        },
      },
    },
  };
  // The fake implements only the one method the loop uses.
  return { client: client as unknown as Anthropic, calls };
}

const overloaded = () =>
  Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers());

const prompt = {
  system: [{ type: "text" as const, text: "rules" }],
  messages: [{ role: "user" as const, content: "What did we decide?" }],
};

function agentWith(turns: FakeTurn[]) {
  const { client, calls } = fakeClient(turns);
  return { agent: createAgent({ apiKey: "test", model: "test-model", client }), calls };
}

async function failure(promise: Promise<unknown>): Promise<AgentError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error("expected the answer to fail");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAgent", () => {
  it("streams each piece of text as it arrives and returns the whole answer", async () => {
    const { agent } = agentWith([{ text: ["The shortlist ", "is five tools."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["The shortlist ", "is five tools."]);
    expect(result).toEqual({ text: "The shortlist is five tools.", stopReason: "end_turn", model: "test-model" });
  });

  it("sends the prompt with the configured model, effort and refusal fallback", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }]);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[0]).toMatchObject({
      model: "test-model",
      system: prompt.system,
      messages: prompt.messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    // No tools until web search is added.
    expect(calls[0]).not.toHaveProperty("tools");
  });

  it("retries once after an overload that happened before any text", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([{ text: ["x"], errorAt: 0, error: overloaded() }, { text: ["ok"] }]);
    const answer = agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await answer).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("gives up after the one retry, with a retryable error for the user", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([
      { errorAt: 0, text: ["x"], error: overloaded() },
      { errorAt: 0, text: ["x"], error: overloaded() },
    ]);
    const answer = failure(agent.answer({ ...prompt, onText: () => {} }));
    await vi.advanceTimersByTimeAsync(1_500);
    const error = await answer;
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(error.message).toBe("The answer didn't come through. Your message is saved.");
    expect(calls).toHaveLength(2);
  });

  it("does not retry once text has reached the user, and keeps what arrived", async () => {
    const { agent, calls } = agentWith([{ text: ["Partial ", "rest"], errorAt: 1, error: overloaded() }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "unavailable", partialText: "Partial " });
    expect(calls).toHaveLength(1);
  });

  it("reports a refusal without retrying", async () => {
    const { agent, calls } = agentWith([{ text: [], stopReason: "refusal" }]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "refusal",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected key without retrying", async () => {
    const rejected = new Anthropic.AuthenticationError(401, { type: "error" }, "invalid x-api-key", new Headers());
    const { agent, calls } = agentWith([{ errorAt: 0, text: ["x"], error: rejected }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "auth", retryable: false });
    expect(error.message).toContain("ANTHROPIC_API_KEY");
    expect(calls).toHaveLength(1);
  });

  it("stops when the user stops, keeping the text so far", async () => {
    const { agent, calls } = agentWith([{ text: ["Half an answer"], hang: true }]);
    const controller = new AbortController();
    const answer = failure(
      agent.answer({ ...prompt, signal: controller.signal, onText: () => controller.abort() }),
    );
    expect(await answer).toMatchObject({ code: "aborted", partialText: "Half an answer" });
    expect(calls).toHaveLength(1);
  });

  it("does not start the retry when the user stopped during the wait", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([{ errorAt: 0, text: ["x"], error: overloaded() }, { hang: true }]);
    const controller = new AbortController();
    const answer = failure(agent.answer({ ...prompt, signal: controller.signal, onText: () => {} }));
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await answer).toMatchObject({ code: "aborted" });
  });

  it("times out a call that never finishes, then retries it once", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([{ hang: true }, { text: ["ok"] }]);
    const answer = agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await answer).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("reports a timeout when the retry also never finishes", async () => {
    vi.useFakeTimers();
    const { agent } = agentWith([{ hang: true }, { hang: true }]);
    const answer = failure(agent.answer({ ...prompt, onText: () => {} }));
    await vi.advanceTimersByTimeAsync(60_000 + 1_500 + 60_000);
    expect(await answer).toMatchObject({ code: "timeout", retryable: true });
  });
});
