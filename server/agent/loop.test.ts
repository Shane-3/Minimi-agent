import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECALL_REASONING, RECALL_REASONING_DEFAULT, SEARCH_REASONING } from "../config.ts";
import { AgentError, createAgent, searchStatus, type ModelClient } from "./loop.ts";
import { WEB_SEARCH_TOOL, type WebSearch, type WebSearchInput } from "./search.ts";

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
  /** Tool calls to make after any text, each sent in two pieces as a real stream does. */
  toolCalls?: { name: string; arguments: string }[];
}

interface FakeParams {
  model: string;
  messages: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }[];
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
            for (const [index, call] of (turn.toolCalls ?? []).entries()) {
              const half = Math.floor(call.arguments.length / 2);
              yield chunk({
                tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: call.arguments.slice(0, half) } }],
              });
              yield chunk({ tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }] });
            }
            yield chunk({}, turn.toolCalls !== undefined ? "tool_calls" : (turn.finishReason ?? "stop"));
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
    expect(result).toEqual({
      text: "The shortlist is five tools.",
      stopReason: "end_turn",
      model: "test-model-served",
      evidence: [],
      searches: 0,
      failedSearches: [],
    });
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

describe("createAgent with web_search", () => {
  const page = (url: string, site: string) => ({
    title: `${site} page`,
    url,
    site,
    publishedDate: "2026-11-10",
    snippet: "Plan details.",
    official: true,
  });

  /** A stand-in for the search tool that records each input and answers from a script. */
  function fakeSearch(evidenceFor: (name: string) => ReturnType<typeof page>[] = () => []) {
    const inputs: WebSearchInput[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const webSearch: WebSearch = {
      async search(input) {
        inputs.push(input);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return {
          searchedAt: "2026-11-13T06:00:00.000Z",
          entities: input.entities.map((entity) => ({ entity: entity.name, status: "found" as const, evidence: evidenceFor(entity.name) })),
        };
      },
    };
    return { webSearch, inputs, maxInFlight: () => maxInFlight };
  }

  const hubspotCall = {
    name: "web_search",
    arguments: JSON.stringify({
      entities: [{ name: "HubSpot", queries: ["HubSpot pricing"], officialSite: "hubspot.com" }],
      since: "2026-11-09",
    }),
  };

  function searchAgent(turns: FakeTurn[], search = fakeSearch(), stepCap?: number) {
    const { client, calls } = fakeClient(turns);
    const agent = createAgent({
      apiKey: "test",
      models: ["test-model"],
      client,
      webSearch: search.webSearch,
      ...(stepCap === undefined ? {} : { stepCap }),
    });
    return { agent, calls, search };
  }

  it("offers the tool, runs the search the model asks for, and answers from its results", async () => {
    const search = fakeSearch(() => [page("https://www.hubspot.com/pricing", "hubspot.com")]);
    const { agent, calls } = searchAgent([{ toolCalls: [hubspotCall] }, { text: ["**HubSpot**: no announced change found."] }], search);
    const statuses: string[] = [];
    const result = await agent.answer({ ...prompt, onText: () => {}, onStatus: (text) => statuses.push(text) });

    expect(calls[0]?.tools).toEqual([WEB_SEARCH_TOOL]);
    expect(search.inputs).toEqual([JSON.parse(hubspotCall.arguments)]);
    expect(statuses).toEqual(["Checking hubspot.com"]);
    expect(result).toMatchObject({ text: "**HubSpot**: no announced change found.", searches: 1 });
    expect(result.evidence.map((evidence) => evidence.url)).toEqual(["https://www.hubspot.com/pricing"]);

    // The second call sees the request and its result, in order.
    const second = calls[1]!.messages;
    expect(second.at(-2)).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_0", function: { name: "web_search" } }],
    });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_0" });
    expect(JSON.parse(second.at(-1)!.content!)).toMatchObject({ entities: [{ entity: "HubSpot", status: "found" }] });
  });

  it("reports the entities whose last search failed, and not one that worked when tried again", async () => {
    let attempt = 0;
    const webSearch: WebSearch = {
      async search(input) {
        attempt += 1;
        return {
          searchedAt: "2026-11-13T06:00:00.000Z",
          entities: input.entities.map((entity) =>
            // Pipedrive fails every time; HubSpot fails once, then works.
            entity.name === "Pipedrive" || attempt === 1
              ? { entity: entity.name, status: "failed" as const, failure: "timeout" as const, evidence: [] }
              : { entity: entity.name, status: "found" as const, evidence: [] },
          ),
        };
      },
    };
    const both = { name: "web_search", arguments: JSON.stringify({ entities: [{ name: "HubSpot", queries: ["HubSpot pricing"] }, { name: "Pipedrive", queries: ["Pipedrive pricing"] }] }) };
    const { agent } = searchAgent([{ toolCalls: [both] }, { toolCalls: [both] }, { text: ["ok"] }], { webSearch, inputs: [], maxInFlight: () => 0 });
    const result = await agent.answer({ ...prompt, onText: () => {} });
    expect(result.failedSearches).toEqual([{ entity: "Pipedrive", failure: "timeout" }]);
  });

  it("reports no failed searches when none ran", async () => {
    const { agent } = searchAgent([{ text: ["From the records."] }]);
    expect((await agent.answer({ ...prompt, onText: () => {} })).failedSearches).toEqual([]);
  });

  it("decides with recall reasoning, then weighs the results with more", async () => {
    const { agent, calls } = searchAgent([{ toolCalls: [hubspotCall] }, { text: ["ok"] }]);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(calls.map((call) => call.reasoning_effort)).toEqual([RECALL_REASONING_DEFAULT, SEARCH_REASONING]);
  });

  it("runs every search asked for in one step at the same time", async () => {
    const pipedriveCall = {
      name: "web_search",
      arguments: JSON.stringify({ entities: [{ name: "Pipedrive", queries: ["Pipedrive pricing"] }] }),
    };
    const search = fakeSearch();
    const { agent, calls } = searchAgent([{ toolCalls: [hubspotCall, pipedriveCall] }, { text: ["ok"] }], search);
    const result = await agent.answer({ ...prompt, onText: () => {} });
    expect(search.maxInFlight()).toBe(2);
    expect(result.searches).toBe(2);
    const toolMessages = calls[1]!.messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["call_0", "call_1"]);
  });

  it("tells the model when its arguments are not valid JSON, without searching", async () => {
    const search = fakeSearch();
    const { agent, calls } = searchAgent([{ toolCalls: [{ name: "web_search", arguments: "{entities:" }] }, { text: ["ok"] }], search);
    const result = await agent.answer({ ...prompt, onText: () => {} });
    expect(search.inputs).toEqual([]);
    expect(result.searches).toBe(0);
    expect(calls[1]!.messages.at(-1)!.content).toContain("not valid JSON");
  });

  it("checks the arguments against the tool's schema and says what is wrong", async () => {
    const search = fakeSearch();
    const badInput = { name: "web_search", arguments: JSON.stringify({ entities: [{ name: "HubSpot", queries: [] }] }) };
    const { agent, calls } = searchAgent([{ toolCalls: [badInput] }, { text: ["ok"] }], search);
    await agent.answer({ ...prompt, onText: () => {} });
    expect(search.inputs).toEqual([]);
    expect(calls[1]!.messages.at(-1)!.content).toContain("entities.0.queries");
  });

  it("answers a call to a tool that does not exist with an error", async () => {
    const { agent, calls } = searchAgent([{ toolCalls: [{ name: "recall", arguments: "{}" }] }, { text: ["ok"] }]);
    await agent.answer({ ...prompt, onText: () => {} });
    // Tool results go to the model as JSON.
    expect(JSON.parse(calls[1]!.messages.at(-1)!.content!).error).toContain('There is no tool called "recall"');
  });

  it("withholds search on the last step and asks for an answer with what it has", async () => {
    const { agent, calls } = searchAgent([{ toolCalls: [hubspotCall] }, { text: ["Partly checked."] }], fakeSearch(), 2);
    const result = await agent.answer({ ...prompt, onText: () => {} });
    expect(calls[1]).not.toHaveProperty("tools");
    expect(calls[1]!.messages.at(-1)).toEqual({
      role: "user",
      content: "No more searches are possible for this answer. Answer now with what you have, and say what is still unchecked.",
    });
    expect(result.text).toBe("Partly checked.");
  });

  it("drops blank lines sent before any real text", async () => {
    const { agent } = searchAgent([{ text: ["\n\n", " \n"], toolCalls: [hubspotCall] }, { text: ["\n**HubSpot**: ok."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(result.text).toBe("**HubSpot**: ok.");
    expect(pieces.join("")).toBe("**HubSpot**: ok.");
  });

  it("drops a short preamble written before a search, from the screen and from the conversation", async () => {
    const { agent, calls } = searchAgent([{ text: ["Let me check ", "current prices."], toolCalls: [hubspotCall] }, { text: ["**HubSpot**: ok."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(result.text).toBe("**HubSpot**: ok.");
    expect(pieces.join("")).toBe("**HubSpot**: ok.");
    // The model is not shown a preamble the user never saw.
    expect(calls[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: null });
  });

  it("holds a direct answer back only until it is long enough to be one, then streams", async () => {
    const { agent } = searchAgent([{ text: ["a".repeat(300), "b".repeat(300), "c"] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["a".repeat(300) + "b".repeat(300), "c"]);
    expect(result.text).toBe(pieces.join(""));
  });

  it("sends a short direct answer whole when the call ends", async () => {
    const { agent } = searchAgent([{ text: ["Nothing ", "was decided."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(pieces).toEqual(["Nothing was decided."]);
    expect(result.searches).toBe(0);
  });

  // A preamble longer than the hold is already on screen when the search
  // request arrives, so it stays; these tests use one.
  const longPreamble = "Checking. ".repeat(60).trim();

  it("keeps text already shown before a search apart from the answer with a blank line", async () => {
    const { agent } = searchAgent([{ text: [longPreamble], toolCalls: [hubspotCall] }, { text: ["**HubSpot**: ok."] }]);
    const pieces: string[] = [];
    const result = await agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    expect(result.text).toBe(`${longPreamble}\n\n**HubSpot**: ok.`);
    expect(pieces.join("")).toBe(result.text);
  });

  it("retries a later call that failed before sending text, without repeating earlier text", async () => {
    vi.useFakeTimers();
    const { agent } = searchAgent([{ text: [longPreamble], toolCalls: [hubspotCall] }, failsWith(overloaded()), { text: ["Done."] }]);
    const pieces: string[] = [];
    const answer = agent.answer({ ...prompt, onText: (text) => pieces.push(text) });
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await answer).text).toBe(`${longPreamble}\n\nDone.`);
    expect(pieces.join("")).toBe(`${longPreamble}\n\nDone.`);
  });

  it("reports everything sent so far when a later call fails", async () => {
    const rejected = new OpenAI.BadRequestError(400, { message: "bad" }, "bad", headers());
    const { agent } = searchAgent([{ text: [longPreamble], toolCalls: [hubspotCall] }, failsWith(rejected)]);
    expect(await failure(agent.answer({ ...prompt, onText: () => {} }))).toMatchObject({
      code: "bad_request",
      partialText: longPreamble,
    });
  });
});

describe("searchStatus", () => {
  it("names up to two things being checked, then counts the rest", () => {
    expect(searchStatus({ entities: [{ name: "HubSpot", queries: ["q"], officialSite: "hubspot.com" }] })).toBe("Checking hubspot.com");
    expect(searchStatus({ entities: [{ name: "A", queries: ["q"] }, { name: "B", queries: ["q"] }] })).toBe("Checking A and B");
    expect(searchStatus({ entities: ["A", "B", "C", "D", "E"].map((name) => ({ name, queries: ["q"] })) })).toBe(
      "Checking A, B and 3 more",
    );
  });
});
