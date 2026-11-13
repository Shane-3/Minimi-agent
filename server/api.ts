// Everything under /api, assembled in one place so tests can run the same
// router the server runs.
import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { Health } from "../shared/types.ts";
import { API_BODY_LIMIT } from "./config.ts";
import type { Env } from "./env.ts";
import { sendError } from "./http.ts";
import { TOO_LARGE_MESSAGE } from "./memory/importer.ts";
import type { Store } from "./memory/store.ts";
import type { Agent } from "./agent/loop.ts";
import { chatRoutes, type ChatRouteOptions } from "./routes/chat.ts";
import { importRoutes } from "./routes/import.ts";

export interface ApiOptions {
  env: Env;
  store: Store;
  samplePath: string;
  /** Null when CEREBRAS_API_KEY is not set. */
  agent: Agent | null;
  now?: () => Date;
  /** The grounding check; injected so tests can make it fail. */
  check?: ChatRouteOptions["check"];
}

export function createApi({ env, store, samplePath, agent, now, check }: ApiOptions): Router {
  const api = Router();
  api.use(express.json({ limit: API_BODY_LIMIT }));

  api.get("/health", (_req, res) => {
    const health: Health = { cerebras: env.cerebrasKey !== null, tavily: env.tavilyKey !== null };
    res.json(health);
  });

  api.use(importRoutes({ store, samplePath, now }));
  api.use(chatRoutes({ store, agent, searchAvailable: env.tavilyKey !== null, now, check }));

  // Unknown API paths answer in the shared error shape instead of falling
  // through to Vite, which would return the HTML page.
  api.use((_req, res) => {
    sendError(res, 404, "not_found", "This API route does not exist.");
  });

  // Express needs all four parameters to treat this as the error handler.
  api.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = bodyParserErrorType(error);
    if (type === "entity.too.large") {
      sendError(res, 413, "too_large", TOO_LARGE_MESSAGE);
    } else if (type === "entity.parse.failed") {
      sendError(res, 400, "bad_request", "The request body wasn't valid JSON.");
    } else {
      console.error("[api] Unhandled error:", error);
      sendError(res, 500, "internal", "Something went wrong on the server. Try again.");
    }
  });

  return api;
}

// Express's JSON parser marks its errors with a `type` string.
function bodyParserErrorType(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "type" in error && typeof error.type === "string") {
    return error.type;
  }
  return null;
}
