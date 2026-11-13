import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistantMessage as Message } from "../state/chat.ts";
import { AssistantMessage } from "./AssistantMessage.tsx";

const KOLKATA = "Asia/Kolkata";

function message(overrides: Partial<Message>): Message {
  return {
    kind: "assistant",
    key: "a1",
    question: "What did we agree?",
    text: "",
    phase: "complete",
    status: null,
    chips: [],
    sources: [],
    checks: [],
    error: null,
    saved: true,
    ...overrides,
  };
}

const render = (props: Partial<Message>, onRetry: (() => void) | null = () => {}) =>
  renderToStaticMarkup(<AssistantMessage message={message(props)} timezone={KOLKATA} onOpenChip={() => {}} onRetry={onRetry} />);

describe("AssistantMessage", () => {
  it("shows chips, the answer, sources and the note, in that order", () => {
    const html = render({
      chips: [{ id: "acme", title: "Acme renewal call", type: "meeting", startedAt: "2026-11-12T04:00:00Z" }],
      text: "Seats go to **55**.",
      sources: [{ title: "Pricing", url: "https://example.com/p", site: "example.com", publishedDate: null, official: true }],
      checks: [{ kind: "figure", text: "55", start: 15, verified: true }],
    });
    const order = ["Acme renewal call · Thu 12 Nov", "<strong>55</strong>", "example.com", "undated", "All figures match"].map((text) =>
      html.indexOf(text),
    );
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("marks an unverified figure with its reason, and links open in a new tab", () => {
    const text = "Pro is $18 ([example.com](https://example.com/p)).";
    const html = render({ text, checks: [{ kind: "figure", text: "$18", start: 7, verified: false, reason: "Not found in the sources I read" }] });
    expect(html).toMatch(/<span[^>]*tabindex="0"[^>]*>\$18<span role="tooltip"[^>]*>Not found in the sources I read<\/span><\/span>/);
    expect(html).toContain('href="https://example.com/p" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("1 figure could not be verified");
  });

  it("shows a quote with its speaker", () => {
    const html = render({ text: '> **Priya (Acme):** "We\'d like 15 more seats."' });
    expect(html).toMatch(/<blockquote[^>]*>\s*<p><strong>Priya \(Acme\):<\/strong>/);
  });

  it("does not render raw HTML from the answer", () => {
    const html = render({ text: 'Hi <img src="x" onerror="alert(1)"> there' });
    expect(html).not.toContain("<img");
  });

  it("shows the status while waiting, and no note until the check reports", () => {
    const html = render({ phase: "pending", status: "Reading Acme renewal call · Thu 12 Nov", checks: undefined });
    expect(html).toContain("Reading Acme renewal call · Thu 12 Nov");
    expect(html).not.toContain("figures match");
  });

  it("says verification was unavailable when the check failed", () => {
    expect(render({ text: "Done.", checks: null })).toContain("Verification unavailable for this answer");
  });

  it("marks a stopped answer, and offers Retry after a lost connection or a retryable error", () => {
    expect(render({ text: "Part", phase: "stopped" })).toContain("Stopped.");
    expect(render({ text: "Part", phase: "incomplete" })).toMatch(/Connection lost\. This answer is incomplete\..*Retry/);
    expect(render({ phase: "error", error: { message: "The answer didn't come through. Your message is saved.", retryable: true } })).toMatch(
      /The answer didn(&#x27;|')t come through\. Your message is saved\..*Retry/,
    );
    expect(render({ phase: "error", error: { message: "Not allowed.", retryable: false } })).not.toContain("Retry");
  });

  it("offers no Retry on an answer that is not the last", () => {
    expect(render({ text: "Part", phase: "incomplete" }, null)).not.toContain("Retry");
  });
});
