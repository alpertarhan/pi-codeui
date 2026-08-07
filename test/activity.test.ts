import assert from "node:assert/strict";
import test from "node:test";
import { ActivityTracker, formatDuration, relativeTime } from "../src/activity.ts";

const change = (path: string) => ({ path }) as any;

test("activity tracker explains what, why, how, and result", () => {
  const tracker = new ActivityTracker("/repo");
  let changes = 0;
  tracker.onChange(() => { changes++; });
  tracker.captureMessage({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "I am fixing field validation without changing the API." }] },
  } as any);
  tracker.start({
    type: "tool_execution_start",
    toolCallId: "edit-1",
    toolName: "edit",
    args: { path: "/repo/src/form.ts", edits: [{ oldText: "old\nline", newText: "new\nline\nextra" }] },
  }, 1_000);

  assert.equal(tracker.current?.status, "running");
  assert.equal(tracker.current?.path, "src/form.ts");
  assert.match(tracker.current?.what ?? "", /Editing src\/form\.ts/);
  assert.match(tracker.current?.why ?? "", /field validation/);
  assert.match(tracker.current?.how ?? "", /1 replacement · 2 old lines → 3 new lines/);
  assert.equal(tracker.isEditing("src/form.ts"), true);
  assert.deepEqual(tracker.orderFiles([change("README.md"), change("src/form.ts")]).map((file) => file.path), ["src/form.ts", "README.md"]);

  tracker.end({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", result: {}, isError: false }, 1_031);
  assert.equal(tracker.current?.status, "success");
  assert.equal(tracker.current?.durationMs, 31);
  assert.equal(tracker.current?.result, "Completed in 31ms");
  assert.equal(tracker.isEditing("src/form.ts"), false);
  assert.ok(changes >= 2);
  tracker.dispose();
});

test("activity history is newest-first, bounded, and sanitized", () => {
  const tracker = new ActivityTracker("/repo", 2);
  for (let index = 0; index < 3; index++) {
    tracker.start({
      type: "tool_execution_start", toolCallId: `id-${index}`, toolName: "bash",
      args: { command: `echo ${index}\n\x1b]0;owned\x07` },
    }, 1_000 + index);
    tracker.end({ type: "tool_execution_end", toolCallId: `id-${index}`, toolName: "bash", result: {}, isError: index === 2 }, 1_010 + index);
  }
  assert.deepEqual(tracker.records.map((record) => record.id), ["id-2", "id-1"]);
  assert.equal(tracker.records.some((record) => record.what.includes("\x1b") || record.what.includes("\n")), false);
  assert.equal(tracker.records[0]?.status, "error");
});

test("duration and relative-time labels stay compact", () => {
  assert.equal(formatDuration(420), "420ms");
  assert.equal(formatDuration(2_450), "2.5s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(relativeTime(9_500, 10_000), "now");
  assert.equal(relativeTime(5_000, 10_000), "5s");
  assert.equal(relativeTime(0, 125_000), "2m");
});
