import { z } from "zod";
import { DEFAULT_MODEL } from "./config.ts";

export interface Env {
  /** null when the key is not set. */
  anthropicKey: string | null;
  tavilyKey: string | null;
  port: number;
  /** Claude model id. Not a key: it has a default and only changes for testing. */
  model: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  TAVILY_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ANTHROPIC_MODEL: z.string().optional(),
});

// A key left blank in a copied .env.example counts as missing.
function keyOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export function readEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError("PORT in .env must be a whole number between 1 and 65535.");
  }
  return {
    anthropicKey: keyOrNull(parsed.data.ANTHROPIC_API_KEY),
    tavilyKey: keyOrNull(parsed.data.TAVILY_API_KEY),
    port: parsed.data.PORT,
    model: keyOrNull(parsed.data.ANTHROPIC_MODEL) ?? DEFAULT_MODEL,
  };
}

// A missing key does not stop the server: the UI shows the same notice,
// and recall still works without the Tavily key.
export function missingKeyMessages(env: Env): string[] {
  const messages: string[] = [];
  if (env.anthropicKey === null) {
    messages.push("Add ANTHROPIC_API_KEY to .env and restart the server.");
  }
  if (env.tavilyKey === null) {
    messages.push(
      "Web search is off. Add TAVILY_API_KEY to .env to turn it on. Questions about your records still work.",
    );
  }
  return messages;
}
