import { describe, expect, it } from "vitest";
import { takeEvents } from "./client.ts";

describe("takeEvents", () => {
  it("returns whole events and keeps a partial one for later", () => {
    const { events, rest } = takeEvents('data: {"type":"status","text":"Looking"}\n\ndata: {"type":"delta","text":"Fi');
    expect(events).toEqual([{ type: "status", text: "Looking" }]);
    expect(rest).toBe('data: {"type":"delta","text":"Fi');

    const next = takeEvents(`${rest}ve"}\n\n`);
    expect(next.events).toEqual([{ type: "delta", text: "Five" }]);
    expect(next.rest).toBe("");
  });

  it("reads several events from one piece and skips lines that are not data", () => {
    const { events } = takeEvents(': comment\n\ndata: {"type":"delta","text":"a"}\n\ndata: {"type":"delta","text":"b"}\n\n');
    expect(events).toEqual([
      { type: "delta", text: "a" },
      { type: "delta", text: "b" },
    ]);
  });

  it("keeps blank lines and newlines inside a JSON string", () => {
    const { events } = takeEvents(`data: ${JSON.stringify({ type: "delta", text: "one\n\ntwo" })}\n\n`);
    expect(events).toEqual([{ type: "delta", text: "one\n\ntwo" }]);
  });
});
