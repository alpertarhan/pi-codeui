import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { summarizeSession } from "../src/session.ts";

const entry = (id: string, role: "user" | "assistant" | "toolResult", content: unknown): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-03-10T12:00:00.000Z",
  message: { role, content, timestamp: 0 },
} as SessionEntry);

test("session overview derives a safe chat title, counts, images, and searchable messages", () => {
  const overview = summarizeSession([
    entry("u1", "user", [{ type: "text", text: "  Review\nthis UI  " }, { type: "image", data: "x", mimeType: "image/png" }]),
    entry("a1", "assistant", [{ type: "text", text: "I will inspect it." }, { type: "toolCall", id: "t1", name: "read", arguments: {} }]),
    entry("t1", "toolResult", [{ type: "text", text: "ignored" }]),
    entry("u2", "user", "Brainstorm improvements"),
  ]);

  assert.equal(overview.title, "Review this UI");
  assert.equal(overview.userTurns, 2);
  assert.equal(overview.assistantMessages, 1);
  assert.equal(overview.images, 1);
  assert.deepEqual(overview.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Review this UI" },
    { role: "assistant", text: "I will inspect it." },
    { role: "user", text: "Brainstorm improvements" },
  ]);
  assert.equal(summarizeSession([], "  Named\nSession ").title, "Named Session");
});
