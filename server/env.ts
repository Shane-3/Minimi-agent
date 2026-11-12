import { z } from "zod";
import { DEFAULT_MODELS } from "./config.ts";

export interface Env {
  /** null when the key is not set. */
  geminiKey: string | null;
  tavilyKey: string | null;
  port: number;
  /** Gemini model ids, best first. Not keys: they have defaults and only change for testing. */
  models: string[];
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

const schema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  GEMINI_MODELS: z.string().optional(),
});

// A key left blank in a copied .env.example counts as missing.
function keyOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// "a, b" becomes ["a", "b"]. Blank or empty means the default list.
function modelList(value: string | undefined): string[] | null {
  const models = (value ?? "").split(",").map((model) => model.trim()).filter((model) => model !== "");
  return models.length === 0 ? null : models;
}

export function readEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError("PORT in .env must be a whole number between 1 and 65535.");
  }
  return {
    geminiKey: keyOrNull(parsed.data.GEMINI_API_KEY),
    tavilyKey: keyOrNull(parsed.data.TAVILY_API_KEY),
    port: parsed.data.PORT,
    models: modelList(parsed.data.GEMINI_MODELS) ?? DEFAULT_MODELS,
  };
}

// A missing key does not stop the server: the UI shows the same notice,
// and recall still works without the Tavily key.
export function missingKeyMessages(env: Env): string[] {
  const messages: string[] = [];
  if (env.geminiKey === null) {
    messages.push("Add GEMINI_API_KEY to .env and restart the server.");
  }
  if (env.tavilyKey === null) {
    messages.push(
      "Web search is off. Add TAVILY_API_KEY to .env to turn it on. Questions about your records still work.",
    );
  }
  return messages;
}
