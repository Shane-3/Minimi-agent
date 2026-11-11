import { describe, expect, it } from "vitest";
import { EnvError, missingKeyMessages, readEnv } from "./env.ts";

describe("readEnv", () => {
  it("reads both keys and defaults the port", () => {
    const env = readEnv({ ANTHROPIC_API_KEY: "a-key", TAVILY_API_KEY: "t-key" });
    expect(env).toEqual({ anthropicKey: "a-key", tavilyKey: "t-key", port: 3000 });
  });

  it("treats an unset key as missing", () => {
    const env = readEnv({ TAVILY_API_KEY: "t-key" });
    expect(env.anthropicKey).toBeNull();
    expect(env.tavilyKey).toBe("t-key");
  });

  it("treats a blank key as missing", () => {
    const env = readEnv({ ANTHROPIC_API_KEY: "", TAVILY_API_KEY: "   " });
    expect(env.anthropicKey).toBeNull();
    expect(env.tavilyKey).toBeNull();
  });

  it("reads a custom port", () => {
    expect(readEnv({ PORT: "4100" }).port).toBe(4100);
  });

  it("rejects a port that is not a number", () => {
    expect(() => readEnv({ PORT: "abc" })).toThrow(EnvError);
  });
});

describe("missingKeyMessages", () => {
  it("is empty when both keys are set", () => {
    const env = readEnv({ ANTHROPIC_API_KEY: "a-key", TAVILY_API_KEY: "t-key" });
    expect(missingKeyMessages(env)).toEqual([]);
  });

  it("names the Anthropic key when it is missing", () => {
    const messages = missingKeyMessages(readEnv({ TAVILY_API_KEY: "t-key" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("ANTHROPIC_API_KEY");
  });

  it("names the Tavily key when it is missing", () => {
    const messages = missingKeyMessages(readEnv({ ANTHROPIC_API_KEY: "a-key" }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("TAVILY_API_KEY");
  });

  it("names both keys when both are missing", () => {
    expect(missingKeyMessages(readEnv({}))).toHaveLength(2);
  });
});
