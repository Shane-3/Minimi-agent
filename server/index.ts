import http from "node:http";
import dotenv from "dotenv";
import express from "express";
import { createServer as createViteServer } from "vite";
import { createApi } from "./api.ts";
import { DATABASE_PATH, SAMPLE_PATH } from "./config.ts";
import { EnvError, missingKeyMessages, readEnv } from "./env.ts";
import { Store, StoreError } from "./memory/store.ts";

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

  const store = new Store(DATABASE_PATH);

  const app = express();
  const server = http.createServer(app);

  app.use("/api", createApi({ env, store, samplePath: SAMPLE_PATH }));

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
  } else if (error instanceof StoreError) {
    console.error(`[setup] ${error.message} Check that ${DATABASE_PATH} can be written.`, error.cause);
  } else {
    console.error("[setup] The server could not start:", error);
  }
  process.exit(1);
});
