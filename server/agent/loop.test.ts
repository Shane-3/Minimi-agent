import { ApiError, FinishReason } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, createAgent, type ModelClient } from "./loop.ts";

// A stand-in for the SDK's streaming call. Each call plays the next scripted
// turn: answer and thought pieces, then a finish reason, a failure or a hang.
interface FakeTurn {
  text?: string[];
  /** Reasoning pieces, sent before the answer and marked as thoughts. */
  thoughts?: string[];
  finishReason?: FinishReason;
  /** The prompt itself was blocked. */
  blocked?: boolean;
  error?: unknown;
  /** Throw `error` before the answer piece at this index (0 = before any text). Without it, after all text. */
  errorAt?: number;
  /** Never finish; only an abort ends it. */
  hang?: boolean;
}

function fakeClient(turns: FakeTurn[]) {
  const calls: unknown[] = [];
  const client = {
    models: {
      async generateContentStream(params: { config?: { abortSignal?: AbortSignal } }) {
        calls.push(params);
        const turn = turns.shift() ?? {};
        const signal = params.config?.abortSignal;
        async function* chunks() {
          for (const thought of turn.thoughts ?? []) {
            yield { candidates: [{ content: { parts: [{ text: thought, thought: true }] } }] };
          }
          for (const [index, text] of (turn.text ?? []).entries()) {
            if (turn.errorAt === index) throw turn.error;
            yield { candidates: [{ content: { role: "model", parts: [{ text }] } }], modelVersion: "fake-model-001" };
          }
          if (turn.hang) {
            await new Promise((_, reject) => {
              // Like fetch, honour a signal that is already aborted.
              const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
              if (signal?.aborted === true) abort();
              signal?.addEventListener("abort", abort);
            });
          }
          if (turn.error !== undefined && turn.errorAt === undefined) throw turn.error;
          if (turn.blocked) yield { promptFeedback: { blockReason: "SAFETY" } };
          yield { candidates: [{ finishReason: turn.finishReason ?? FinishReason.STOP }] };
        }
        return chunks();
      },
    },
  };
  // The fake implements only the one method the loop uses.
  return { client: client as unknown as ModelClient, calls };
}

const overloaded = () => new ApiError({ status: 503, message: '{"error":{"code":503,"status":"UNAVAILABLE"}}' });

const prompt = {
  system: "rules and memory",
  contents: [{ role: "user", parts: [{ text: "What did we decide?" }] }],
};

function agentWith(turns: FakeTurn[], models = ["test-model"]) {
  const { client, calls } = fakeClient(turns);
  return { agent: createAgent({ apiKey: "test", models, client }), calls };
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
  it("streams each piece of the answer as it arrives, leaving out the model's thoughts", async () => {
    const { agent } = agentWith([{ thoughts: ["Let me check the record."], text: ["The shortlist ", "is five tools."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["The shortlist ", "is five tools."]);
    expect(result).toEqual({ text: "The shortlist is five tools.", stopReason: "end_turn", model: "fake-model-001" });
  });

  it("sends the prompt with the configured model, thinking level and output cap", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }]);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[0]).toMatchObject({
      model: "test-model",
      contents: prompt.contents,
      config: {
        systemInstruction: "rules and memory",
        maxOutputTokens: 65_536,
        thinkingConfig: { thinkingLevel: "MEDIUM" },
      },
    });
    // No tools until web search is added.
    expect((calls[0] as { config: object }).config).not.toHaveProperty("tools");
  });

  it("reports an answer cut off at the output cap", async () => {
    const { agent } = agentWith([{ text: ["Half"], finishReason: FinishReason.MAX_TOKENS }]);
    expect((await agent.answer({ ...prompt, onText: () => {} })).stopReason).toBe("max_tokens");
  });

  it("retries once after an overload that happened before any text", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([{ text: ["x"], errorAt: 0, error: overloaded() }, { text: ["ok"] }]);
    const answer = agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await answer).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("does not retry a per-minute rate limit, which a retry seconds later would hit again", async () => {
    const rateLimited = new ApiError({
      status: 429,
      message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}}',
    });
    const { agent, calls } = agentWith([{ text: ["x"], errorAt: 0, error: rateLimited }, { text: ["ok"] }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(error.message).toBe("Too many questions in the last minute. Wait a moment and press Retry.");
    expect(calls).toHaveLength(1);
  });

  it("says the daily limit is used up, without offering a retry", async () => {
    const exhausted = new ApiError({
      status: 429,
      message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}',
    });
    const { agent, calls } = agentWith([{ text: ["x"], errorAt: 0, error: exhausted }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "quota_exhausted", retryable: false });
    expect(error.message).toBe("The daily request limit is used up. Questions will work again tomorrow.");
    expect(calls).toHaveLength(1);
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

  it("reports an answer stopped by the safety filters, without retrying", async () => {
    const { agent, calls } = agentWith([{ text: [], finishReason: FinishReason.SAFETY }]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "refusal",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a blocked prompt the same way", async () => {
    const { agent } = agentWith([{ blocked: true }]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({ code: "refusal" });
  });

  it("reports a rejected key without retrying", async () => {
    const rejected = new ApiError({
      status: 400,
      message: '{"error":{"code":400,"message":"API key not valid.","details":[{"reason":"API_KEY_INVALID"}]}}',
    });
    const { agent, calls } = agentWith([{ errorAt: 0, text: ["x"], error: rejected }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "auth", retryable: false });
    expect(error.message).toContain("GEMINI_API_KEY");
    expect(calls).toHaveLength(1);
  });

  it("reports a malformed request without retrying", async () => {
    const malformed = new ApiError({ status: 400, message: '{"error":{"status":"INVALID_ARGUMENT"}}' });
    const { agent, calls } = agentWith([{ errorAt: 0, text: ["x"], error: malformed }]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "bad_request",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("stops when the user stops, keeping the text so far", async () => {
    const { agent, calls } = agentWith([{ text: ["Half an answer"], hang: true }]);
    const controller = new AbortController();
    const answer = failure(agent.answer({ ...prompt, signal: controller.signal, onText: () => controller.abort() }));
    expect(await answer).toMatchObject({ code: "aborted", partialText: "Half an answer" });
    expect(calls).toHaveLength(1);
  });

  it("does not start the retry when the user stopped during the wait", async () => {
    vi.useFakeTimers();
    const { agent } = agentWith([{ errorAt: 0, text: ["x"], error: overloaded() }, { hang: true }]);
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

describe("createAgent with a pool of models", () => {
  const POOL = ["best", "second", "third"];
  const modelOf = (call: unknown) => (call as { model: string }).model;

  // Shaped like the API's 429 body: the quota id names the window, and
  // RetryInfo, when present, says how long to wait.
  const perMinute = (seconds?: number) => {
    const retry = seconds === undefined ? "" : `,{"retryDelay":"${seconds}s"}`;
    return new ApiError({
      status: 429,
      message: `{"error":{"details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}${retry}]}}`,
    });
  };
  const perDay = () =>
    new ApiError({
      status: 429,
      message: '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}',
    });
  const failsWith = (error: unknown): FakeTurn => ({ errorAt: 0, text: ["x"], error });

  it("answers with the best model when it is free", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }], POOL);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map(modelOf)).toEqual(["best"]);
  });

  it("moves to the next model at once when one hits its per-minute limit", async () => {
    const { agent, calls } = agentWith([failsWith(perMinute()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second"]);
  });

  it("moves past every model whose daily limit is used up", async () => {
    const { agent, calls } = agentWith([failsWith(perDay()), failsWith(perDay()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second", "third"]);
  });

  it("moves to the next model after an overload, without waiting", async () => {
    const { agent, calls } = agentWith([failsWith(overloaded()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second"]);
  });

  it("moves past every overloaded model, since an overload fails fast", async () => {
    const { agent, calls } = agentWith([failsWith(overloaded()), failsWith(overloaded()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second", "third"]);
  });

  it("gives up when every model is overloaded, after one more try on the last", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith(
      [failsWith(overloaded()), failsWith(overloaded()), failsWith(overloaded()), failsWith(overloaded())],
      POOL,
    );
    const answer = failure(agent.answer({ ...prompt, onText: () => {} }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await answer).toMatchObject({ code: "unavailable", retryable: true });
    expect(calls.map(modelOf)).toEqual(["best", "second", "third", "third"]);
  });

  it("gives a timeout only one more try, since each costs a minute", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([{ hang: true }, { hang: true }, { text: ["ok"] }], POOL);
    const answer = failure(agent.answer({ ...prompt, onText: () => {} }));
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(await answer).toMatchObject({ code: "timeout" });
    expect(calls.map(modelOf)).toEqual(["best", "second"]);
  });

  it("does not change model once text has reached the user", async () => {
    const { agent, calls } = agentWith([{ text: ["Partial ", "rest"], errorAt: 1, error: perMinute() }], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "rate_limited",
      partialText: "Partial ",
    });
    expect(calls).toHaveLength(1);
  });

  it("skips a resting model on the next question too", async () => {
    const { agent, calls } = agentWith([failsWith(perDay()), { text: ["one"] }, { text: ["two"] }], POOL);
    await agent.answer({ ...prompt, onText: () => {} });
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map(modelOf)).toEqual(["best", "second", "second"]);
  });

  it("goes back to the best model once its rest is over, using the wait the API asked for", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith(
      [failsWith(perMinute(35)), { text: ["one"] }, { text: ["two"] }, { text: ["three"] }],
      POOL,
    );
    await agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(30_000);
    await agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(5_000);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map(modelOf)).toEqual(["best", "second", "second", "best"]);
  });

  it("says the daily limit is used up when every model has used its own", async () => {
    const { agent, calls } = agentWith([failsWith(perDay()), failsWith(perDay()), failsWith(perDay())], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "quota_exhausted",
      retryable: false,
    });
    expect(calls).toHaveLength(3);
  });

  it("asks the user to wait when the soonest model back is only at its per-minute limit", async () => {
    const { agent } = agentWith([failsWith(perDay()), failsWith(perMinute(20)), failsWith(perDay())], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("does not move on after a rejected key, which every model would reject", async () => {
    const rejected = new ApiError({ status: 400, message: '{"error":{"details":[{"reason":"API_KEY_INVALID"}]}}' });
    const { agent, calls } = agentWith([failsWith(rejected)], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({ code: "auth" });
    expect(calls).toHaveLength(1);
  });
});
