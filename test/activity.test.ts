import assert from "node:assert/strict";
import test from "node:test";
import { ActivityTracker, formatDuration, parseDiagnostics, relativeTime } from "../src/activity.ts";

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

test("developer commands are classified as tests, builds, and validation", () => {
  const tracker = new ActivityTracker("/repo");
  tracker.start({ type: "tool_execution_start", toolCallId: "test", toolName: "bash", args: { command: "pnpm test" } }, 1);
  tracker.end({ type: "tool_execution_end", toolCallId: "test", toolName: "bash", result: { content: [{ type: "text", text: "setup\n49 tests passed" }] }, isError: false }, 101);
  tracker.start({ type: "tool_execution_start", toolCallId: "lint", toolName: "bash", args: { command: "npm run typecheck" } }, 200);
  tracker.start({ type: "tool_execution_start", toolCallId: "build", toolName: "bash", args: { command: "cargo build" } }, 300);
  assert.equal(tracker.records.find((record) => record.id === "test")?.kind, "test");
  assert.match(tracker.records.find((record) => record.id === "test")?.result ?? "", /49 tests passed/);
  assert.equal(tracker.records.find((record) => record.id === "lint")?.kind, "lint");
  assert.equal(tracker.records.find((record) => record.id === "build")?.kind, "build");
});

test("general chat tools use human activity labels", () => {
  const tracker = new ActivityTracker("/repo");
  tracker.start({ type: "tool_execution_start", toolCallId: "web", toolName: "web_search", args: { query: "terminal UX" } }, 1);
  tracker.start({ type: "tool_execution_start", toolCallId: "export", toolName: "preview_export", args: { format: "pdf" } }, 2);
  tracker.start({ type: "tool_execution_start", toolCallId: "decision", toolName: "ask_user_question", args: {} }, 3);
  assert.deepEqual(tracker.records.map(({ kind }) => kind), ["decision", "export", "research"]);
  assert.match(tracker.records.find((record) => record.id === "web")?.what ?? "", /web/i);
});

test("diagnostics parse common TypeScript, ESLint, and test locations safely", () => {
  const output = [
    "src/app.ts(12,5): error TS2322: Type string is not assignable",
    "/repo/src/lint.ts",
    "  3:2  warning  Unexpected console  no-console",
    "tests/unit.test.ts:8:9: expected true to be false",
    "../../outside.ts:1:1: error: escaped",
  ].join("\n");
  const diagnostics = parseDiagnostics(output, "/repo", "lint", "check-1");
  assert.deepEqual(diagnostics.map(({ path, line, column, severity }) => ({ path, line, column, severity })), [
    { path: "src/app.ts", line: 12, column: 5, severity: "error" },
    { path: "src/lint.ts", line: 3, column: 2, severity: "warning" },
    { path: "tests/unit.test.ts", line: 8, column: 9, severity: "error" },
  ]);
});

test("latest successful check clears older diagnostics of the same kind", () => {
  const tracker = new ActivityTracker("/repo");
  tracker.start({ type: "tool_execution_start", toolCallId: "lint-1", toolName: "bash", args: { command: "npm run typecheck" } }, 1);
  tracker.end({ type: "tool_execution_end", toolCallId: "lint-1", toolName: "bash", result: { content: [{ type: "text", text: "src/a.ts(2,3): error TS1: broken" }] }, isError: true }, 2);
  assert.equal(tracker.diagnostics.length, 1);
  tracker.start({ type: "tool_execution_start", toolCallId: "lint-2", toolName: "bash", args: { command: "npm run typecheck" } }, 3);
  assert.equal(tracker.checks[0]?.status, "running");
  assert.equal(tracker.diagnostics.length, 1, "the last known diagnostics stay visible while the same check reruns");
  tracker.end({ type: "tool_execution_end", toolCallId: "lint-2", toolName: "bash", result: { content: [{ type: "text", text: "Typecheck passed" }] }, isError: false }, 4);
  assert.equal(tracker.diagnostics.length, 0);
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
