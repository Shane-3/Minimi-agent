import http from "node:http";
import dotenv from "dotenv";
import express from "express";
import { createServer as createViteServer } from "vite";
import type { ApiError, Health } from "../shared/types.ts";
import { EnvError, missingKeyMessages, readEnv } from "./env.ts";

// .env is the one place a judge sets keys. `override` makes it win over an
// old key left in their shell, so the key they just typed is the one used.
// `quiet` turns off dotenv's own banner; the env check below says what matters.
function loadDotEnv(): void {
  const result = dotenv.config({ override: true, quiet: true });
  if (result.error === undefined) return;
  if (result.error.code === "ENOENT") {
    console.warn("[setup] No .env file found. Copy .env.example to .env and add your keys.");
    return;
  }
  throw result.error;
}

async function main(): Promise<void> {
  loadDotEnv();
  const env = readEnv(process.env);
  for (const message of missingKeyMessages(env)) {
    console.warn(`[setup] ${message}`);
  }

  const app = express();
  const server = http.createServer(app);

  app.get("/api/health", (_req, res) => {
    const health: Health = {
      anthropic: env.anthropicKey !== null,
      tavily: env.tavilyKey !== null,
    };
    res.json(health);
  });

  // Unknown API paths answer in the shared error shape instead of falling
  // through to Vite, which would return the HTML page.
  app.use("/api", (_req, res) => {
    const body: ApiError = {
      error: { code: "not_found", message: "This API route does not exist." },
    };
    res.status(404).json(body);
  });

  // Vite runs inside Express so there is one process and one port. Its
  // hot-reload socket shares the same HTTP server for the same reason.
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[setup] Port ${env.port} is already in use. Set PORT in .env to another port.`);
    } else {
      console.error(`[setup] The server could not start: ${error.message}`);
    }
    process.exit(1);
  });

  server.listen(env.port, () => {
    console.log(`minimi-agent is running at http://localhost:${env.port}`);
  });
}

main().catch((error: unknown) => {
  if (error instanceof EnvError) {
    console.error(`[setup] ${error.message}`);
  } else {
    console.error("[setup] The server could not start:", error);
  }
  process.exit(1);
});
