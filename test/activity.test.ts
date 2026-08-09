import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ActivityTracker, formatDuration, parseDiagnostics, relativeTime } from "../src/activity.ts";

const change = (path: string) => ({ path }) as any;
const entry = (id: string, timestamp: string, message: Record<string, unknown>): SessionEntry => ({
  type: "message", id, parentId: null, timestamp, message,
} as unknown as SessionEntry);

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
  tracker.start({ type: "tool_execution_start", toolCallId: "lint", toolName: "bash", args: { command: "npm run typecheck", timeout: 30 } }, 200);
  tracker.start({ type: "tool_execution_start", toolCallId: "build", toolName: "bash", args: { command: "cargo build" } }, 300);
  assert.equal(tracker.records.find((record) => record.id === "test")?.kind, "test");
  assert.match(tracker.records.find((record) => record.id === "test")?.result ?? "", /49 tests passed/);
  assert.equal(tracker.records.find((record) => record.id === "lint")?.kind, "lint");
  assert.match(tracker.records.find((record) => record.id === "lint")?.how ?? "", /timeout 30s$/);
  assert.deepEqual(tracker.records.find((record) => record.id === "lint")?.rerun, { command: "npm run typecheck", cwd: "/repo", timeout: 30 });
  assert.equal(tracker.records.find((record) => record.id === "build")?.kind, "build");
  assert.equal(tracker.records.some((record) => record.kind === "bash" && record.rerun !== undefined), false);
  for (const [id, timeout] of [["zero", 0], ["negative", -1], ["nan", Number.NaN]] as const) {
    tracker.start({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "npm run typecheck", timeout } }, 400);
    assert.equal(tracker.records.find((record) => record.id === id)?.rerun?.timeout, undefined);
  }
});

test("general chat tools use human activity labels", () => {
  const tracker = new ActivityTracker("/repo");
  tracker.start({ type: "tool_execution_start", toolCallId: "web", toolName: "web_search", args: { query: "terminal UX" } }, 1);
  tracker.start({ type: "tool_execution_start", toolCallId: "export", toolName: "preview_export", args: { format: "pdf" } }, 2);
  tracker.start({ type: "tool_execution_start", toolCallId: "decision", toolName: "ask_user_question", args: {} }, 3);
  assert.deepEqual(tracker.records.map(({ kind }) => kind), ["decision", "export", "research"]);
  assert.match(tracker.records.find((record) => record.id === "web")?.what ?? "", /web/i);
});

test("activity and diagnostic paths become repository-relative in a nested monorepo", () => {
  const tracker = new ActivityTracker("/repo/packages/app");
  tracker.start({ type: "tool_execution_start", toolCallId: "nested-edit", toolName: "edit", args: { path: "src/app.ts", edits: [] } }, 1);
  tracker.setRoot("/repo");
  assert.equal(tracker.current?.path, "packages/app/src/app.ts");
  assert.equal(tracker.isEditing("packages/app/src/app.ts"), true);
  assert.equal(tracker.isEditing("src/app.ts"), false, "duplicate suffix paths must not match");
  tracker.end({ type: "tool_execution_end", toolCallId: "nested-edit", toolName: "edit", result: {}, isError: false }, 2);
  tracker.start({ type: "tool_execution_start", toolCallId: "nested-check", toolName: "bash", args: { command: "npm run typecheck" } }, 3);
  tracker.end({ type: "tool_execution_end", toolCallId: "nested-check", toolName: "bash", result: { content: [{ type: "text", text: "src/check.ts(4,2): error TS1: broken" }] }, isError: true }, 4);
  assert.equal(tracker.diagnostics[0]?.path, "packages/app/src/check.ts");
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

test("latest request tracks only successful direct edits and request-scoped check failures", () => {
  const tracker = new ActivityTracker("/repo");
  tracker.beginRequest();
  tracker.start({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "src/read.ts" } }, 1);
  tracker.end({ type: "tool_execution_end", toolCallId: "read", toolName: "read", result: {}, isError: false }, 2);
  tracker.start({ type: "tool_execution_start", toolCallId: "failed-edit", toolName: "edit", args: { path: "src/failed.ts", edits: [] } }, 3);
  tracker.end({ type: "tool_execution_end", toolCallId: "failed-edit", toolName: "edit", result: {}, isError: true }, 4);
  tracker.start({ type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { path: "src/done.ts", content: "done" } }, 5);
  tracker.end({ type: "tool_execution_end", toolCallId: "write", toolName: "write", result: {}, isError: false }, 6);
  tracker.start({ type: "tool_execution_start", toolCallId: "test", toolName: "bash", args: { command: "npm test" } }, 7);
  tracker.end({ type: "tool_execution_end", toolCallId: "test", toolName: "bash", result: {}, isError: true }, 8);
  tracker.start({ type: "tool_execution_start", toolCallId: "build", toolName: "bash", args: { command: "npm run build" } }, 9);
  tracker.end({ type: "tool_execution_end", toolCallId: "build", toolName: "bash", result: {}, isError: false }, 10);
  tracker.finalizeRequest();

  assert.deepEqual(tracker.latestRequest, { id: 1, active: false, editedPaths: ["src/done.ts"], editedPathCount: 1, checkCount: 2, failureCount: 1 });

  tracker.beginRequest();
  tracker.beginTurn();
  tracker.beginTurn();
  tracker.finalizeRequest();
  assert.deepEqual(tracker.latestRequest, { id: 2, active: false, editedPaths: [], editedPathCount: 0, checkCount: 0, failureCount: 0 });
});

test("persisted tool pairs hydrate activity, diagnostics, touched order, and only the latest request", () => {
  const branch: SessionEntry[] = [
    entry("u-old", "2026-03-10T11:59:00.000Z", { role: "user", content: "Old request", timestamp: 1_000 }),
    entry("a-old", "2026-03-10T12:00:00.000Z", { role: "assistant", content: [
      { type: "text", text: "Making the old change." },
      { type: "toolCall", id: "old-edit", name: "edit", arguments: { path: "src/old.ts", edits: [] } },
      { type: "toolCall", id: "old-test", name: "bash", arguments: { command: "npm test", timeout: 0 } },
    ], timestamp: 2_000 }),
    entry("r-old-test", "2026-03-10T12:00:04.000Z", { role: "toolResult", toolCallId: "old-test", toolName: "bash", content: [{ type: "text", text: "10 tests passed" }], isError: false, timestamp: Date.parse("2026-03-10T12:00:04.000Z") }),
    entry("r-old-edit", "2026-03-10T12:00:03.000Z", { role: "toolResult", toolCallId: "old-edit", toolName: "edit", content: [{ type: "text", text: "edited" }], isError: false, timestamp: Date.parse("2026-03-10T12:00:03.000Z") }),
    entry("manual", "2026-03-10T12:00:05.000Z", { role: "bashExecution", command: "rm file", output: "manual", timestamp: 5_000 }),
    entry("u-new", "2026-03-10T12:01:00.000Z", { role: "user", content: [{ type: "text", text: "Fix the latest request" }], timestamp: 6_000 }),
    entry("a-new", "2026-03-10T12:01:01.000Z", { role: "assistant", content: [
      { type: "text", text: "Fixing the latest validation without changing its API." },
      { type: "toolCall", id: "failed-edit", name: "edit", arguments: { path: "src/failed.ts", edits: [] } },
      { type: "toolCall", id: "done-write", name: "write", arguments: { path: "src/done.ts", content: "done" } },
      { type: "toolCall", id: "latest-check", name: "bash", arguments: { command: "npm run typecheck", timeout: 45 } },
      { type: "toolCall", id: "missing-result", name: "read", arguments: { path: "src/missing.ts" } },
    ], timestamp: 7_000 }),
    entry("r-check", "2026-03-10T12:01:05.000Z", { role: "toolResult", toolCallId: "latest-check", toolName: "bash", content: [{ type: "text", text: "src/problem.ts(4,2): error TS1: broken" }], isError: true, timestamp: Date.parse("2026-03-10T12:01:05.000Z") }),
    entry("r-write", "2026-03-10T12:01:04.000Z", { role: "toolResult", toolCallId: "done-write", toolName: "write", content: [{ type: "text", text: "wrote file" }], isError: false, timestamp: Date.parse("2026-03-10T12:01:04.000Z") }),
    entry("r-failed", "2026-03-10T12:01:03.000Z", { role: "toolResult", toolCallId: "failed-edit", toolName: "edit", content: [{ type: "text", text: "not found" }], isError: true, timestamp: Date.parse("2026-03-10T12:01:03.000Z") }),
  ];
  const tracker = new ActivityTracker("/repo/packages/app");
  tracker.hydrate(branch);

  assert.equal(tracker.records.length, 5);
  assert.equal(tracker.records.some(({ id, status }) => id === "missing-result" || status === "running"), false);
  assert.equal(tracker.records.find(({ id }) => id === "done-write")?.startedAt, Date.parse("2026-03-10T12:01:01.000Z"));
  assert.equal(tracker.records.find(({ id }) => id === "done-write")?.endedAt, Date.parse("2026-03-10T12:01:04.000Z"));
  assert.equal(tracker.records.find(({ id }) => id === "done-write")?.durationMs, 3_000);
  assert.match(tracker.records.find(({ id }) => id === "done-write")?.why ?? "", /latest validation/);
  assert.deepEqual(tracker.latestRequest, { id: 1, active: false, editedPaths: ["src/done.ts"], editedPathCount: 1, checkCount: 1, failureCount: 1 });
  assert.deepEqual(tracker.diagnostics.map(({ path, line, column }) => ({ path, line, column })), [{ path: "src/problem.ts", line: 4, column: 2 }]);
  assert.deepEqual(tracker.records.find(({ id }) => id === "latest-check")?.rerun, { command: "npm run typecheck", cwd: "/repo/packages/app", timeout: 45 });
  assert.deepEqual(tracker.records.find(({ id }) => id === "old-test")?.rerun, { command: "npm test", cwd: "/repo/packages/app" });
  assert.deepEqual(tracker.orderFiles([change("src/old.ts"), change("src/done.ts")]).map(({ path }) => path), ["src/done.ts", "src/old.ts"]);

  tracker.setRoot("/repo");
  assert.deepEqual(tracker.latestRequest?.editedPaths, ["packages/app/src/done.ts"]);
  assert.equal(tracker.diagnostics[0]?.path, "packages/app/src/problem.ts");
  tracker.start({ type: "tool_execution_start", toolCallId: "done-write", toolName: "write", args: { path: "duplicate.ts", content: "x" } }, 20_000);
  tracker.end({ type: "tool_execution_end", toolCallId: "done-write", toolName: "write", result: {}, isError: false }, 21_000);
  assert.equal(tracker.records.filter(({ id }) => id === "done-write").length, 1);
  assert.equal(tracker.records.find(({ id }) => id === "done-write")?.endedAt, Date.parse("2026-03-10T12:01:04.000Z"));
});

test("hydration retains only the newest 100 completed tool pairs", () => {
  const entries: SessionEntry[] = [entry("u", "2026-03-10T12:00:00.000Z", { role: "user", content: "Long request", timestamp: 0 })];
  for (let index = 0; index < 105; index++) {
    entries.push(entry(`a-${index}`, new Date(1_000 + index * 2).toISOString(), { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command: `echo ${index}` } }], timestamp: 1_000 + index * 2 }));
    entries.push(entry(`r-${index}`, new Date(1_001 + index * 2).toISOString(), { role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", content: [{ type: "text", text: String(index) }], isError: false, timestamp: 1_001 + index * 2 }));
  }
  entries.push(entry("a-missing", "2026-03-10T12:02:00.000Z", { role: "assistant", content: [{ type: "toolCall", id: "missing", name: "read", arguments: { path: "missing" } }], timestamp: 99_000 }));

  const tracker = new ActivityTracker("/repo");
  tracker.hydrate(entries);
  assert.equal(tracker.records.length, 100);
  assert.equal(tracker.records[0]?.id, "call-104");
  assert.equal(tracker.records.at(-1)?.id, "call-5");
  assert.equal(tracker.records.every(({ status }) => status === "success" || status === "error"), true);
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

test("reruns create fresh completed checks and replace diagnostics through normal parsing", async () => {
  const tracker = new ActivityTracker("/repo");
  tracker.start({ type: "tool_execution_start", toolCallId: "lint", toolName: "bash", args: { command: "npm run typecheck", timeout: 12 } }, 1);
  tracker.end({ type: "tool_execution_end", toolCallId: "lint", toolName: "bash", result: { content: [{ type: "text", text: "src/old.ts(1,2): error TS1: old" }] }, isError: true }, 2);
  const original = tracker.records[0]!;

  const success = await tracker.rerun(original, async (rerun) => {
    assert.deepEqual(rerun, { command: "npm run typecheck", cwd: "/repo", timeout: 12 });
    return { stdout: "Typecheck passed", stderr: "", code: 0, killed: false };
  });
  assert.equal(success?.status, "success");
  assert.equal(tracker.checks[0]?.id, success?.id);
  assert.equal(tracker.diagnostics.length, 0);

  const failure = await tracker.rerun(success!, async () => ({
    stdout: "", stderr: "src/new.ts(4,5): error TS2: new", code: 2, killed: false,
  }));
  assert.equal(failure?.status, "error");
  assert.deepEqual(tracker.diagnostics.map(({ path, line, column }) => ({ path, line, column })), [{ path: "src/new.ts", line: 4, column: 5 }]);

  const spawnFailure = await tracker.rerun(failure!, async () => { throw new Error("spawn bash ENOENT"); });
  assert.equal(spawnFailure?.status, "error");
  assert.match(spawnFailure?.result ?? "", /spawn bash ENOENT/);
  spawnFailure!.rerun!.timeout = Number.NaN;
  await tracker.rerun(spawnFailure!, async (rerun) => {
    assert.equal(rerun.timeout, undefined, "tampered timeout is removed before execution");
    return { stdout: "Typecheck passed", stderr: "", code: 0, killed: false };
  });
  assert.equal(tracker.records.some((record) => record.status === "running"), false);
});

test("duration and relative-time labels stay compact", () => {
  assert.equal(formatDuration(420), "420ms");
  assert.equal(formatDuration(2_450), "2.5s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(relativeTime(9_500, 10_000), "now");
  assert.equal(relativeTime(5_000, 10_000), "5s");
  assert.equal(relativeTime(0, 125_000), "2m");
});
