import type { AddressInfo } from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, ImportResult, MemoryRecord, RecordSummary } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { Store } from "./memory/store.ts";

const SAMPLE_PATH = fileURLToPath(new URL("../data/sample.json", import.meta.url));
const KOLKATA = "Asia/Kolkata";

const meetingFile = JSON.stringify({
  records: [
    {
      type: "meeting",
      title: "Acme renewal call",
      timestamp: "2026-11-09T15:00:00+05:30",
      turns: [{ speaker: "Priya (Acme)", text: "We can sign if onboarding is done by December." }],
    },
  ],
});

describe("API", () => {
  let store: Store;
  let server: http.Server;
  let base: string;
  let now: Date;

  beforeEach(async () => {
    store = new Store(":memory:");
    now = new Date("2026-11-11T06:00:00Z");
    const app = express();
    app.use(
      "/api",
      createApi({
        env: { cerebrasKey: "a-key", tavilyKey: null, port: 0, models: ["test-model"] },
        store,
        samplePath: SAMPLE_PATH,
        agent: null,
        now: () => now,
      }),
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });

  function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("reports which keys are set, without the keys", async () => {
    const response = await fetch(`${base}/health`);
    expect(await response.json()).toEqual({ cerebras: true, tavily: false });
  });

  it("imports a file sent as raw text", async () => {
    const response = await post("/import", { content: meetingFile, timezone: KOLKATA });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ImportResult;
    expect(result).toMatchObject({ imported: 1, skipped: 0, warnings: [] });

    const records = (await (await fetch(`${base}/records`)).json()) as RecordSummary[];
    expect(records.map((record) => record.title)).toEqual(["Acme renewal call"]);
  });

  it("reports invalid JSON in the file with its line number", async () => {
    const response = await post("/import", { content: '{\n  "records": []\n  "extra": 1\n}', timezone: KOLKATA });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "invalid_json",
      message: "This file isn't valid JSON (line 3).",
    });
  });

  it("names the record and field that failed", async () => {
    const response = await post("/import", { content: '[{ "type": "meeting", "content": "Hi" }]', timezone: KOLKATA });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "wrong_shape",
      message: "Record 1 is missing a timestamp.",
      details: ["Record 1 is missing a timestamp."],
    });
  });

  it("refuses file text over 5 MB with the standard error", async () => {
    const response = await post("/import", { content: "x".repeat(5 * 1024 * 1024 + 1), timezone: KOLKATA });
    expect(response.status).toBe(413);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "too_large",
      message: "This file is over 5 MB. Split it and upload the parts.",
    });
  });

  it("refuses a request body over the parser limit with the same error, not Express's default", async () => {
    const response = await post("/import", { content: "x".repeat(12 * 1024 * 1024), timezone: KOLKATA });
    expect(response.status).toBe(413);
    expect(((await response.json()) as ApiError).error).toEqual({
      code: "too_large",
      message: "This file is over 5 MB. Split it and upload the parts.",
    });
  });

  it("accepts a file just under 5 MB even though escaping makes the body larger", async () => {
    // Every newline becomes two characters inside the JSON body.
    const filler = "\n".repeat(4 * 1024 * 1024);
    const response = await post("/import", { content: `${filler}${meetingFile}`, timezone: KOLKATA });
    expect(response.status).toBe(200);
  });

  it("lets the worst-case 5 MB file through the body limit to the importer's own checks", async () => {
    // Quotes double in size when escaped: the largest a 5 MB file can grow.
    const response = await post("/import", { content: '"'.repeat(5 * 1024 * 1024), timezone: KOLKATA });
    // Reaching the importer means a JSON error about the file, not a size error.
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("invalid_json");
  });

  it("answers a request with no timezone with a 400 in the standard shape", async () => {
    const response = await post("/import", { content: meetingFile });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("bad_request");
  });

  it("answers a body that is not JSON with a 400 in the standard shape", async () => {
    const response = await fetch(`${base}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("bad_request");
  });

  it("keeps one copy of the sample when it is loaded again on a later day", async () => {
    expect((await post("/import/sample", { timezone: KOLKATA })).status).toBe(200);
    now = new Date("2026-11-18T06:00:00Z");
    const second = (await (await post("/import/sample", { timezone: KOLKATA })).json()) as ImportResult;
    expect(second).toMatchObject({ imported: 6, skipped: 0 });

    const records = (await (await fetch(`${base}/records`)).json()) as RecordSummary[];
    expect(records).toHaveLength(6);
    expect(records.find((record) => record.id === "sample-crm-shortlist")?.startedAt).toBe(
      "2026-11-16T08:30:00.000Z",
    );
  });

  it("loads a larger sample by name, and skips it all when loaded again", async () => {
    const first = (await (await post("/import/sample/monsoon-bikes", { timezone: KOLKATA })).json()) as ImportResult;
    // The file holds one duplicate, two records with no timezone and one over the budget, on purpose.
    expect(first).toMatchObject({ imported: 120, skipped: 1 });
    expect(first.warnings).toHaveLength(3);
    const again = (await (await post("/import/sample/monsoon-bikes", { timezone: KOLKATA })).json()) as ImportResult;
    expect(again).toMatchObject({ imported: 0, skipped: 121 });

    const kestrel = (await (await post("/import/sample/kestrel-works", { timezone: KOLKATA })).json()) as ImportResult;
    expect(kestrel).toMatchObject({ imported: 225, skipped: 0, warnings: [] });
  });

  it("answers 404 for a sample name that is not on the list, without reading any file", async () => {
    for (const name of ["nope", "..%2Fpackage", "sample"]) {
      const response = await post(`/import/sample/${name}`, { timezone: KOLKATA });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error.message).toBe("That sample doesn't exist.");
    }
  });

  it("returns a record with its segments, and 404 for an unknown one", async () => {
    await post("/import/sample", { timezone: KOLKATA });
    const record = (await (await fetch(`${base}/records/sample-crm-shortlist`)).json()) as MemoryRecord;
    expect(record.title).toBe("CRM shortlist review");
    expect(record.segments[0]?.speaker).toBe("Shane");

    const missing = await fetch(`${base}/records/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ApiError).error.code).toBe("not_found");
  });

  it("removes one record, then clears all", async () => {
    await post("/import/sample", { timezone: KOLKATA });
    expect((await fetch(`${base}/records/sample-crm-shortlist`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/records/sample-crm-shortlist`, { method: "DELETE" })).status).toBe(404);
    expect(store.listRecords()).toHaveLength(5);

    expect((await fetch(`${base}/records`, { method: "DELETE" })).status).toBe(204);
    expect(store.listRecords()).toEqual([]);
  });

  it("answers an unknown API path with a 404 in the standard shape", async () => {
    const response = await fetch(`${base}/nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error.code).toBe("not_found");
  });
});
