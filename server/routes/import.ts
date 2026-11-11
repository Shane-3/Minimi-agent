// Import and records routes (ARCHITECTURE.md §8).
import { readFile } from "node:fs/promises";
import { Router, type Response } from "express";
import { z } from "zod";
import type { RecordSummary } from "../../shared/types.ts";
import { parseBody, sendError } from "../http.ts";
import {
  ImportError,
  importInto,
  loadSampleInto,
  parseImportText,
  prepareImport,
  prepareSample,
} from "../memory/importer.ts";
import { StoreError, type Store } from "../memory/store.ts";

export interface ImportRouteOptions {
  store: Store;
  samplePath: string;
  /** Injected so tests can load the sample on a chosen day. */
  now?: () => Date;
}

// The browser sends the file's raw text, so every file check (JSON syntax
// with a line number, shape, size) runs here, in one tested place, with the
// same wording in every browser.
const importBody = z.object({
  content: z.string(),
  timezone: z.string().min(1),
});

const sampleBody = z.object({
  timezone: z.string().min(1),
});

export function importRoutes({ store, samplePath, now = () => new Date() }: ImportRouteOptions): Router {
  const router = Router();

  router.post("/import", (req, res) => {
    const body = parseBody(importBody, req.body, res);
    if (body === null) return;
    try {
      const prepared = prepareImport(parseImportText(body.content), body.timezone);
      res.json(importInto(store, prepared, body.timezone));
    } catch (error) {
      sendImportFailure(res, error);
    }
  });

  router.post("/import/sample", async (req, res) => {
    const body = parseBody(sampleBody, req.body, res);
    if (body === null) return;
    try {
      const sample = JSON.parse(await readFile(samplePath, "utf8")) as unknown;
      const prepared = prepareSample(sample, body.timezone, now());
      res.json(loadSampleInto(store, prepared, body.timezone));
    } catch (error) {
      sendImportFailure(res, error);
    }
  });

  router.get("/records", (_req, res) => {
    try {
      const records: RecordSummary[] = store.listRecords();
      res.json(records);
    } catch (error) {
      sendStoreFailure(res, error, "Your records can't be read right now.");
    }
  });

  router.get("/records/:id", (req, res) => {
    try {
      const record = store.getRecord(req.params.id);
      if (record === null) {
        sendError(res, 404, "not_found", "That record no longer exists.");
        return;
      }
      res.json(record);
    } catch (error) {
      sendStoreFailure(res, error, "This record can't be read right now.");
    }
  });

  router.delete("/records/:id", (req, res) => {
    try {
      if (!store.deleteRecord(req.params.id)) {
        sendError(res, 404, "not_found", "That record no longer exists.");
        return;
      }
      res.status(204).end();
    } catch (error) {
      sendStoreFailure(res, error, "The record couldn't be removed. Try again.");
    }
  });

  router.delete("/records", (_req, res) => {
    try {
      store.clearAll();
      res.status(204).end();
    } catch (error) {
      sendStoreFailure(res, error, "Memory couldn't be cleared. Try again.");
    }
  });

  return router;
}

function sendImportFailure(res: Response, error: unknown): void {
  if (error instanceof ImportError) {
    sendError(res, error.code === "too_large" ? 413 : 400, error.code, error.message, error.details);
    return;
  }
  sendStoreFailure(res, error, "The records couldn't be saved. Nothing was imported.");
}

function sendStoreFailure(res: Response, error: unknown, message: string): void {
  if (error instanceof StoreError) {
    // The cause goes to the server log only; it can contain file paths.
    console.error(`[store] ${error.message}`, error.cause);
    sendError(res, 500, "database_error", message);
    return;
  }
  throw error;
}
