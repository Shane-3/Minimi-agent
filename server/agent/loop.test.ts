import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECALL_REASONING, RECALL_REASONING_DEFAULT } from "../config.ts";
import { AgentError, createAgent, type ModelClient } from "./loop.ts";

// A stand-in for the SDK's streaming call. Each call plays the next scripted
// turn: answer and reasoning pieces, then a finish reason, a failure or a hang.
interface FakeTurn {
  text?: string[];
  /** Reasoning pieces, sent before the answer in their own field. */
  reasoning?: string[];
  finishReason?: "stop" | "length" | "content_filter";
  error?: unknown;
  /** Throw `error` before the answer piece at this index (0 = before any text). Without it, after all text. */
  errorAt?: number;
  /** Never finish; only an abort ends it. */
  hang?: boolean;
}

interface FakeParams {
  model: string;
  messages: { role: string; content: string }[];
  reasoning_effort?: string;
  max_completion_tokens?: number;
  stream?: boolean;
  tools?: unknown;
}

function fakeClient(turns: FakeTurn[]) {
  const calls: FakeParams[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: FakeParams, options?: { signal?: AbortSignal }) {
          calls.push(params);
          const turn = turns.shift() ?? {};
          const signal = options?.signal;
          const chunk = (delta: object, finish: string | null = null) => ({
            model: `${params.model}-served`,
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          async function* chunks() {
            for (const piece of turn.reasoning ?? []) yield chunk({ reasoning: piece });
            for (const [index, text] of (turn.text ?? []).entries()) {
              if (turn.errorAt === index) throw turn.error;
              yield chunk({ content: text });
            }
            if (turn.hang) {
              await new Promise((_, reject) => {
                // Like the SDK, honour a signal that is already aborted.
                if (signal?.aborted === true) reject(new OpenAI.APIUserAbortError());
                signal?.addEventListener("abort", () => reject(new OpenAI.APIUserAbortError()));
              });
            }
            if (turn.error !== undefined && turn.errorAt === undefined) throw turn.error;
            yield chunk({}, turn.finishReason ?? "stop");
          }
          return chunks();
        },
      },
    },
  };
  // The fake implements only the one method the loop uses.
  return { client: client as unknown as ModelClient, calls };
}

const headers = (values: { [name: string]: string } = {}) => new Headers(values);
const overloaded = () => new OpenAI.InternalServerError(503, { message: "overloaded" }, "overloaded", headers());
const rateLimited = (retryAfterSeconds?: number) =>
  new OpenAI.RateLimitError(
    429,
    { message: "Tokens per minute limit exceeded" },
    "rate limited",
    headers(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
  );
const failsWith = (error: unknown): FakeTurn => ({ errorAt: 0, text: ["x"], error });

const prompt = {
  system: "rules and memory",
  messages: [{ role: "user" as const, content: "What did we decide?" }],
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
  it("streams each piece of the answer as it arrives, leaving out the reasoning", async () => {
    const { agent } = agentWith([{ reasoning: ["Let me check the record."], text: ["The shortlist ", "is five tools."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["The shortlist ", "is five tools."]);
    expect(result).toEqual({ text: "The shortlist is five tools.", stopReason: "end_turn", model: "test-model-served" });
  });

  it("sends the system prompt first, then the conversation, streamed with an output cap", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }]);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[0]).toMatchObject({
      model: "test-model",
      messages: [
        { role: "system", content: "rules and memory" },
        { role: "user", content: "What did we decide?" },
      ],
      stream: true,
      max_completion_tokens: 8_192,
    });
    // No tools until web search is added.
    expect(calls[0]).not.toHaveProperty("tools");
  });

  it("sends each model the reasoning level configured for it", async () => {
    const { agent, calls } = agentWith(
      [{ text: ["a"] }, failsWith(rateLimited()), { text: ["b"] }, { text: ["c"] }],
      ["qwen-3.8-27b", "gpt-oss-120b", "unlisted-model"],
    );
    await agent.answer({ ...prompt, onText: () => {} });
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map((call) => [call.model, call.reasoning_effort])).toEqual([
      ["qwen-3.8-27b", RECALL_REASONING["qwen-3.8-27b"]],
      ["qwen-3.8-27b", RECALL_REASONING["qwen-3.8-27b"]],
      ["gpt-oss-120b", RECALL_REASONING["gpt-oss-120b"]],
    ]);
  });

  it("gives a model with no setting of its own the default level", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }], ["unlisted-model"]);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[0]?.reasoning_effort).toBe(RECALL_REASONING_DEFAULT);
  });

  it("uses an override for every model when one is given", async () => {
    const { client, calls } = fakeClient([{ text: ["ok"] }]);
    const agent = createAgent({ apiKey: "test", models: ["qwen-3.8-27b"], reasoning: "high", client });
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[0]?.reasoning_effort).toBe("high");
  });

  it("reports an answer cut off at the output cap", async () => {
    const { agent } = agentWith([{ text: ["Half"], finishReason: "length" }]);
    expect((await agent.answer({ ...prompt, onText: () => {} })).stopReason).toBe("max_tokens");
  });

  it("retries once after an overload that happened before any text", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([failsWith(overloaded()), { text: ["ok"] }]);
    const answer = agent.answer({ ...prompt, onText: () => {} });
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await answer).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("gives up after the one retry, with a retryable error for the user", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith([failsWith(overloaded()), failsWith(overloaded())]);
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

  it("does not retry a per-minute rate limit, which a retry seconds later would hit again", async () => {
    const { agent, calls } = agentWith([failsWith(rateLimited(30)), { text: ["ok"] }]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(error.message).toBe("Too many questions in the last minute. Wait a moment and press Retry.");
    expect(calls).toHaveLength(1);
  });

  it("treats a rate limit with a wait of hours as the daily limit, without offering a retry", async () => {
    const { agent, calls } = agentWith([failsWith(rateLimited(5 * 3600))]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "quota_exhausted", retryable: false });
    expect(error.message).toBe("The daily request limit is used up. Questions will work again tomorrow.");
    expect(calls).toHaveLength(1);
  });

  it("reports an answer stopped by the content filter, without retrying", async () => {
    const { agent, calls } = agentWith([{ text: [], finishReason: "content_filter" }]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "refusal",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a rejected key without retrying", async () => {
    const rejected = new OpenAI.AuthenticationError(401, { message: "Wrong API key" }, "Wrong API key", headers());
    const { agent, calls } = agentWith([failsWith(rejected)]);
    const error = await failure(agent.answer({ ...prompt, onText: () => {} }));
    expect(error).toMatchObject({ code: "auth", retryable: false });
    expect(error.message).toContain("CEREBRAS_API_KEY");
    expect(calls).toHaveLength(1);
  });

  it("reports a malformed request without retrying", async () => {
    const malformed = new OpenAI.BadRequestError(400, { message: "bad" }, "bad", headers());
    const { agent, calls } = agentWith([failsWith(malformed)]);
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
    const { agent } = agentWith([failsWith(overloaded()), { hang: true }]);
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
  const modelOf = (call: FakeParams) => call.model;
  const daily = () => rateLimited(5 * 3600);

  it("answers with the best model when it is free", async () => {
    const { agent, calls } = agentWith([{ text: ["ok"] }], POOL);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map(modelOf)).toEqual(["best"]);
  });

  it("moves to the next model at once when one hits its per-minute limit", async () => {
    const { agent, calls } = agentWith([failsWith(rateLimited()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second"]);
  });

  it("moves past every model whose daily limit is used up", async () => {
    const { agent, calls } = agentWith([failsWith(daily()), failsWith(daily()), { text: ["ok"] }], POOL);
    expect((await agent.answer({ ...prompt, onText: () => {} })).text).toBe("ok");
    expect(calls.map(modelOf)).toEqual(["best", "second", "third"]);
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
    const { agent, calls } = agentWith([{ text: ["Partial ", "rest"], errorAt: 1, error: rateLimited() }], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "rate_limited",
      partialText: "Partial ",
    });
    expect(calls).toHaveLength(1);
  });

  it("skips a resting model on the next question too", async () => {
    const { agent, calls } = agentWith([failsWith(daily()), { text: ["one"] }, { text: ["two"] }], POOL);
    await agent.answer({ ...prompt, onText: () => {} });
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map(modelOf)).toEqual(["best", "second", "second"]);
  });

  it("goes back to the best model once its rest is over, using the wait the API asked for", async () => {
    vi.useFakeTimers();
    const { agent, calls } = agentWith(
      [failsWith(rateLimited(35)), { text: ["one"] }, { text: ["two"] }, { text: ["three"] }],
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
    const { agent, calls } = agentWith([failsWith(daily()), failsWith(daily()), failsWith(daily())], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "quota_exhausted",
      retryable: false,
    });
    expect(calls).toHaveLength(3);
  });

  it("asks the user to wait when the soonest model back is only at its per-minute limit", async () => {
    const { agent } = agentWith([failsWith(daily()), failsWith(rateLimited(20)), failsWith(daily())], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("does not move on after a rejected key, which every model would reject", async () => {
    const rejected = new OpenAI.AuthenticationError(401, { message: "Wrong API key" }, "Wrong API key", headers());
    const { agent, calls } = agentWith([failsWith(rejected)], POOL);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({ code: "auth" });
    expect(calls).toHaveLength(1);
  });
});
