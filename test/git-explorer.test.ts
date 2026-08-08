import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityTracker } from "../src/activity.ts";
import { filesForScope, formatUnifiedDiff, GitExplorer } from "../src/git-explorer.ts";
import type { GitExec } from "../src/git/git.ts";
import { GitStateController } from "../src/git-state.ts";
import { GLYPH_PRESETS } from "../src/glyphs.ts";
import type { FileChange } from "../src/git/types.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

const files: FileChange[] = [
  { path: "both.ts", index: "M", worktree: "M", staged: true, unstaged: true, untracked: false, conflicted: false },
  { path: "staged.ts", index: "A", worktree: " ", staged: true, unstaged: false, untracked: false, conflicted: false },
  { path: "working.ts", index: " ", worktree: "M", staged: false, unstaged: true, untracked: false, conflicted: false },
  { path: "conflict.ts", index: "U", worktree: "U", staged: false, unstaged: false, untracked: false, conflicted: true },
  { path: "new.ts", index: "?", worktree: "?", staged: false, unstaged: false, untracked: true, conflicted: false },
];

function controller(stateFiles: FileChange[] = files): GitStateController {
  const git = new GitStateController(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), "/repo");
  git.state = {
    kind: "repo", root: "/repo",
    status: { branch: { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false }, files: stateFiles, counts: { staged: 2, unstaged: 2, untracked: 1, conflicted: 1 } },
    working: { files: 2, added: 2, deleted: 2, binaryFiles: 0 }, cached: { files: 2, added: 2, deleted: 2, binaryFiles: 0 },
  };
  return git;
}

function fakeTheme(colors: ThemeColor[] = []): Theme {
  const ansi = (text: string) => `\x1b[31m${text}\x1b[39m`;
  return {
    fg: (color: ThemeColor, text: string) => { colors.push(color); return ansi(text); },
    bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
    bold: (text: string) => text,
  } as Theme;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("unified diff formatting hides metadata and adds old/new line numbers", () => {
  const lines = formatUnifiedDiff([
    "diff --git a/app.ts b/app.ts",
    "index 123..456 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -10,2 +10,3 @@ submit",
    " context",
    "-old",
    "+new",
    "+more",
  ].join("\n"));
  assert.equal(lines[0]?.color, "accent");
  assert.match(lines[0]?.text ?? "", /@@ -10,2 \+10,3 @@/);
  assert.match(lines[1]?.text ?? "", /10\s+10\s+ context/);
  assert.match(lines[2]?.text ?? "", /11\s+\s-old/);
  assert.match(lines[3]?.text ?? "", /\s+11 \+new/);
  assert.equal(lines.some((line) => line.text.includes("diff --git")), false);
});

test("Explorer scopes include the right staged, working, conflict, and untracked files", () => {
  assert.deepEqual(filesForScope(files, "staged").map((file) => file.path), ["both.ts", "staged.ts"]);
  assert.deepEqual(filesForScope(files, "working").map((file) => file.path), ["both.ts", "working.ts", "conflict.ts", "new.ts"]);
  assert.deepEqual(filesForScope(files, "working", false).map((file) => file.path), ["both.ts", "working.ts", "conflict.ts"]);
});

test("embedded Explorer supports mouse tabs, scopes, and row selection", async () => {
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 24,
    activity: new ActivityTracker("/repo"),
  });
  await settle();
  assert.equal(explorer.handleMouse(16, 2, 60), true);
  assert.equal(explorer.scope, "staged");
  explorer.handleMouse(5, 4, 60);
  assert.equal(explorer.selected, 1);
  explorer.handleMouse(48, 0, 60);
  assert.match(stripTerminalSequences(explorer.render(60).join("\n")), /ACTIVITY\s+0/);
  explorer.dispose();
});

test("stacked tabs keep list, insight, dock, and footer geometry stable", async () => {
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 40,
    activity: new ActivityTracker("/repo"),
  });
  await settle();

  const snapshot = () => stripTerminalSequences(explorer.render(60).join("\n")).split("\n");
  const changes = snapshot();
  explorer.handleInput("a");
  const activity = snapshot();
  explorer.handleInput("c");
  const checks = snapshot();
  const row = (lines: string[], pattern: RegExp) => lines.findIndex((line) => pattern.test(line));

  const detailRows = [row(changes, /\bDIFF\s+/), row(activity, /DEVELOPER INSIGHT/), row(checks, /CHECK INSIGHT/)];
  assert.ok(detailRows.every((index) => index > 0));
  assert.deepEqual(detailRows, [detailRows[0], detailRows[0], detailRows[0]], "switching tabs must not move the lower insight zone");
  assert.equal(row(activity, /DEVELOPER INSIGHT/) - row(activity, /ACTIVITY\s+0/), 8, "empty activity must retain the shared list zone");
  assert.deepEqual([changes.length, activity.length, checks.length], [40, 40, 40]);
  assert.ok([changes, activity, checks].every((lines) => /q/.test(lines.at(-1) ?? "")), "tab hints must remain anchored to the bottom row");
  explorer.dispose();
});

test("workspace rail render matrix is width-safe and keeps tab geometry stable", async () => {
  const widths = [1, 3, 4, 12, 24, 40, 79, 80, 89, 90, 100, 140, 160, 200, 220];
  const heights = [5, 8, 12, 24, 40, 60];

  for (const glyphPreset of ["nerd", "unicode", "ascii"] as const) {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    settings.appearance.glyphPreset = glyphPreset;
    const activity = new ActivityTracker("/repo");
    activity.start({ type: "tool_execution_start", toolCallId: "matrix-check", toolName: "bash", args: { command: "npm run typecheck" } }, 1);
    activity.end({ type: "tool_execution_end", toolCallId: "matrix-check", toolName: "bash", result: { content: [{ type: "text", text: "src/app.ts(12,5): error TS2322: Wrong type" }] }, isError: true }, 20);
    let rows = 24;
    const explorer = new GitExplorer(controller(), async () => ({ stdout: "@@ -1 +1 @@\n-old\n+new", stderr: "", code: 0, killed: false }), () => settings, fakeTheme(), () => {}, () => {}, {
      embedded: true,
      getTerminalRows: () => rows,
      activity,
    });
    await settle();

    for (const height of heights) {
      rows = height;
      for (const width of widths) {
        explorer.handleInput("g");
        const changes = explorer.render(width);
        explorer.handleInput("a");
        const activityLines = explorer.render(width);
        explorer.handleInput("c");
        const checkLines = explorer.render(width);
        const views = [changes, activityLines, checkLines];
        assert.ok(views.flat().every((line) => visibleWidth(line) <= width), `${glyphPreset} rail exceeded ${width}x${height}`);
        if (width >= 4) assert.deepEqual(views.map((lines) => lines.length), [height, height, height], `${glyphPreset} row geometry changed at ${width}x${height}`);
        if (width >= 24) {
          const detailRow = (lines: string[], pattern: RegExp) => lines.findIndex((line) => pattern.test(stripTerminalSequences(line)));
          const rowsByView = [detailRow(changes, /\bDIFF\b/), detailRow(activityLines, /DEVELOPER INSIGHT/), detailRow(checkLines, /CHECK INSIGHT/)];
          assert.ok(rowsByView.every((row) => row >= 0), `${glyphPreset} detail disappeared at ${width}x${height}`);
          assert.deepEqual(rowsByView, [rowsByView[0], rowsByView[0], rowsByView[0]], `${glyphPreset} tab switch moved detail at ${width}x${height}`);
        }
        if (width >= 80) assert.ok(views.every((lines) => /q/.test(stripTerminalSequences(lines.at(-1) ?? ""))), `footer moved at ${width}x${height}`);
      }
    }

    rows = 24;
    explorer.handleInput("g");
    const changes = stripTerminalSequences(explorer.render(80).join("\n"));
    assert.ok(changes.includes(`M ${GLYPH_PRESETS[glyphPreset].modified} both.ts`), `${glyphPreset} modified glyph was not rendered`);
    assert.match(changes, /! ! conflict\.ts/, "conflicts must retain a non-color status marker");
    explorer.handleInput("c");
    const checks = stripTerminalSequences(explorer.render(100).join("\n"));
    assert.match(checks, /1 errors/);
    assert.match(checks, /✕/);
    assert.match(checks, /SEVERITY\s+ERROR/, "check severity must remain textual without color");
    explorer.dispose();
    activity.dispose();
  }
});

test("right-click target opens the selected file action menu", async () => {
  const calls: string[][] = [];
  const git = controller();
  git.refresh = async () => {};
  let menuTitle = "";
  const explorer = new GitExplorer(git, async (_command, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0, killed: false };
  }, () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 24,
    select: async (title) => { menuTitle = title; return "Stage file"; },
  });
  await settle();
  explorer.handleMouse(5, 3, 60, 1_000, false);
  explorer.openMouseActions();
  await settle();
  assert.match(menuTitle, /both\.ts/);
  assert.ok(calls.some((args) => args[0] === "add" && args.at(-1) === "both.ts"));
  explorer.dispose();
});

test("Explorer restores and publishes repo workspace UI state", async () => {
  const patches: unknown[] = [];
  const widget = { render: () => ["● Todos (0/1)", "└─ ○ Persist rail"], invalidate: () => {} };
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 24,
    getDockedWidgets: () => [widget],
    workspaceState: { view: "checks", scope: "staged", widgetDock: "collapsed" },
    onWorkspaceStateChange: (patch) => patches.push(patch),
  });
  await settle();
  const restored = stripTerminalSequences(explorer.render(70).join("\n"));
  assert.equal(explorer.scope, "staged");
  assert.match(restored, /CHECKS/);
  assert.match(restored, /w expand/);
  explorer.handleInput("g");
  explorer.handleInput("\t");
  explorer.handleInput("w");
  assert.deepEqual(patches, [
    { view: "changes", scope: "staged", widgetDock: "collapsed" },
    { view: "changes", scope: "working", widgetDock: "collapsed" },
    { view: "changes", scope: "working", widgetDock: "expanded" },
  ]);
  explorer.dispose();
});

test("docked extension widgets render and collapse inside the rail", async () => {
  const widget = { render: () => ["", "● Todos (0/2)", "├─ ◐ Implement dock", "└─ ○ Verify", ""], invalidate: () => {} };
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 24,
    getDockedWidgets: () => [widget],
  });
  await settle();
  const expanded = stripTerminalSequences(explorer.render(60).join("\n"));
  assert.match(expanded, /EXTENSIONS/);
  assert.match(expanded, /Implement dock/);
  explorer.handleInput("w");
  const collapsed = stripTerminalSequences(explorer.render(60).join("\n"));
  assert.match(collapsed, /w expand/);
  assert.doesNotMatch(collapsed, /Implement dock/);
  explorer.dispose();
});

test("completed todo widgets auto-compact instead of filling the rail", async () => {
  const widget = { render: () => ["○ Todos (24/24)", "├─ ✓ Old task", "└─ ✓ Verify polish"], invalidate: () => {} };
  const explorer = new GitExplorer(controller([]), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    embedded: true,
    getTerminalRows: () => 30,
    getDockedWidgets: () => [widget],
  });
  await settle();
  const compact = stripTerminalSequences(explorer.render(60).join("\n"));
  assert.match(compact, /Todos 24\/24 complete/);
  assert.doesNotMatch(compact, /Old task/);
  assert.match(compact, /Ready · working tree clean/);
  assert.doesNotMatch(compact, /0 actions|Click ↗/);
  explorer.handleInput("w");
  assert.match(stripTerminalSequences(explorer.render(60).join("\n")), /Old task/);
  explorer.dispose();
});

test("safe Git actions stage, unstage, confirm discard, and guard untracked deletion", async () => {
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push(args);
    return { stdout: args[0] === "diff" ? "@@ -1 +1 @@\n-old\n+new" : "", stderr: "", code: 0, killed: false };
  };
  const git = controller();
  git.refresh = async () => {};
  let confirmations = 0;
  const notices: string[] = [];
  const explorer = new GitExplorer(git, exec, () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    confirm: async () => { confirmations++; return true; },
    notify: (message) => notices.push(message),
  });
  await settle();

  explorer.handleInput("s");
  await settle();
  assert.ok(calls.some((args) => args[0] === "add" && args.at(-1) === "both.ts"));
  explorer.handleInput("\t");
  explorer.handleInput("s");
  await settle();
  assert.ok(calls.some((args) => args[0] === "restore" && args[1] === "--staged"));
  explorer.handleInput("\t");
  explorer.handleInput("x");
  await settle();
  assert.equal(confirmations, 1);
  assert.ok(calls.some((args) => args[0] === "restore" && args[1] === "--worktree"));
  assert.ok(notices.some((message) => /Discarded/.test(message)));

  explorer.handleInput("j");
  explorer.handleInput("j");
  explorer.handleInput("j");
  explorer.handleInput("x");
  await settle();
  assert.equal(confirmations, 1, "untracked files must never reach destructive confirmation");
  assert.match(stripTerminalSequences(explorer.render(70).join("\n")), /Untracked deletion is intentionally disabled/);
  explorer.dispose();
});

test("diff focus navigates and stages only the selected hunk", async () => {
  const patch = [
    "diff --git a/both.ts b/both.ts",
    "index 1111111..2222222 100644",
    "--- a/both.ts",
    "+++ b/both.ts",
    "@@ -1 +1 @@",
    "-old one",
    "+new one",
    "@@ -10 +10 @@",
    "-old ten",
    "+new ten",
    "",
  ].join("\n");
  const calls: string[][] = [];
  let appliedPatch = "";
  let resolveApplied!: () => void;
  const applied = new Promise<void>((resolve) => { resolveApplied = resolve; });
  const exec: GitExec = async (_command, args) => {
    calls.push(args);
    if (args[0] === "apply" && !args.includes("--check")) {
      appliedPatch = await readFile(args.at(-1)!, "utf8");
      resolveApplied();
    }
    return { stdout: args[0] === "diff" ? patch : "", stderr: "", code: 0, killed: false };
  };
  const git = controller();
  git.refresh = async () => {};
  const explorer = new GitExplorer(git, exec, () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {});
  await settle();
  explorer.handleInput("\r");
  assert.match(stripTerminalSequences(explorer.render(90).join("\n")), /HUNK 1\/2/);
  explorer.handleInput("n");
  assert.match(stripTerminalSequences(explorer.render(90).join("\n")), /HUNK 2\/2/);
  explorer.handleInput("s");
  await applied;
  assert.match(appliedPatch, /old ten/);
  assert.doesNotMatch(appliedPatch, /old one/);
  assert.ok(calls.some((args) => args[0] === "apply" && args.includes("--check")));
  explorer.dispose();
});

test("commit composer inputs, confirms, and commits staged changes", async () => {
  const calls: string[][] = [];
  let confirmation = "";
  let resolveCommitted!: () => void;
  const committed = new Promise<void>((resolve) => { resolveCommitted = resolve; });
  const git = controller();
  if (git.state.kind === "repo") git.state.status.counts.conflicted = 0;
  git.refresh = async () => {};
  const explorer = new GitExplorer(git, async (_command, args) => {
    calls.push(args);
    if (args[0] === "commit") resolveCommitted();
    return { stdout: "", stderr: "", code: 0, killed: false };
  }, () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    input: async () => "feat: ship safe composer",
    confirm: async (_title, message) => { confirmation = message; return true; },
  });
  await settle();
  explorer.handleInput("C");
  await committed;
  assert.match(confirmation, /Staged files: 2/);
  assert.ok(calls.some((args) => args[0] === "commit" && args[1] === "-m" && args[2] === "feat: ship safe composer"));
  explorer.dispose();
});

test("double-clicking a changed file returns a Neovim action", async () => {
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; }, {
    embedded: true,
    getTerminalRows: () => 24,
  });
  await settle();
  assert.match(stripTerminalSequences(explorer.render(60).join("\n")), /↗/);
  explorer.handleMouse(5, 3, 60, 1_000);
  assert.equal(result, undefined, "first click must preserve diff-preview UX");
  explorer.handleMouse(5, 3, 60, 1_300);
  assert.deepEqual(result, { action: "edit", root: "/repo", path: "both.ts" });

  let arrowResult: unknown;
  const arrowExplorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { arrowResult = value; }, { embedded: true, getTerminalRows: () => 24 });
  await settle();
  arrowExplorer.handleMouse(58, 3, 60, 2_000);
  assert.deepEqual(arrowResult, { action: "edit", root: "/repo", path: "both.ts" });
});

test("Explorer returns a safe external-editor action for the selected file", async () => {
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; });
  await settle();
  explorer.handleInput("j");
  explorer.handleInput("e");
  assert.deepEqual(result, { action: "edit", root: "/repo", path: "working.ts" });
});

test("Explorer shows NOW, newest-touched files, and WHAT/WHY/HOW activity insight", async () => {
  const activity = new ActivityTracker("/repo");
  activity.captureMessage({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Fixing validation while preserving the API contract." }] } } as any);
  const now = Date.now();
  activity.start({ type: "tool_execution_start", toolCallId: "one", toolName: "edit", args: { path: "/repo/working.ts", edits: [{ oldText: "old", newText: "new" }] } }, now - 200);
  activity.end({ type: "tool_execution_end", toolCallId: "one", toolName: "edit", result: {}, isError: false }, now - 150);
  activity.start({ type: "tool_execution_start", toolCallId: "two", toolName: "edit", args: { path: "/repo/both.ts", edits: [{ oldText: "a", newText: "b\nc" }] } }, now - 100);
  activity.end({ type: "tool_execution_end", toolCallId: "two", toolName: "edit", result: {}, isError: false }, now - 20);

  const explorer = new GitExplorer(controller(), async () => ({ stdout: "@@ -1 +1 @@\n-old\n+new", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, {
    activity,
    getTerminalRows: () => 30,
  });
  await settle();
  const changes = stripTerminalSequences(explorer.render(70).join("\n"));
  assert.match(changes, /NOW\s+✓ Editing both\.ts/);
  assert.match(changes, /WHY\s+Fixing validation/);
  assert.ok(changes.indexOf("both.ts") < changes.indexOf("working.ts"));

  explorer.handleInput("a");
  const insight = stripTerminalSequences(explorer.render(100).join("\n"));
  assert.match(insight, /ACTIVITY\s+2/);
  assert.match(insight, /DEVELOPER INSIGHT/);
  assert.match(insight, /WHAT\s+Editing both\.ts/);
  assert.match(insight, /WHY\s+Fixing validation/);
  assert.match(insight, /HOW\s+1 replacement/);
  assert.match(insight, /RESULT\s+Completed in 80ms/);
  explorer.dispose();
  activity.dispose();
});

test("Checks view lists diagnostics and opens Neovim at the exact location", async () => {
  const activity = new ActivityTracker("/repo");
  activity.start({ type: "tool_execution_start", toolCallId: "check", toolName: "bash", args: { command: "npm run typecheck" } }, 1);
  activity.end({ type: "tool_execution_end", toolCallId: "check", toolName: "bash", result: { content: [{ type: "text", text: "src/app.ts(12,5): error TS2322: Wrong type" }] }, isError: true }, 20);
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; }, {
    activity,
    getTerminalRows: () => 30,
  });
  await settle();
  explorer.handleInput("c");
  const checks = stripTerminalSequences(explorer.render(80).join("\n"));
  assert.match(checks, /CHECKS/);
  assert.match(checks, /PROBLEMS\s+1/);
  assert.match(checks, /src\/app\.ts:12:5/);
  assert.match(checks, /Wrong type/);
  explorer.handleInput("e");
  assert.deepEqual(result, { action: "edit", root: "/repo", path: "src/app.ts", line: 12, column: 5 });
  activity.dispose();
});

test("workspace quickfix combines exact diagnostics and every changed file", async () => {
  const activity = new ActivityTracker("/repo");
  activity.start({ type: "tool_execution_start", toolCallId: "quickfix-check", toolName: "bash", args: { command: "npm run typecheck" } }, 1);
  activity.end({ type: "tool_execution_end", toolCallId: "quickfix-check", toolName: "bash", result: { content: [{ type: "text", text: "src/app.ts(12,5): error TS2322: Wrong type" }] }, isError: true }, 20);
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; }, { activity });
  await settle();
  explorer.handleInput("Q");
  assert.equal((result as any)?.action, "quickfix");
  assert.deepEqual((result as any)?.entries[0], { path: "src/app.ts", line: 12, column: 5, message: "[LINT] Wrong type", severity: "error" });
  assert.ok((result as any)?.entries.some((entry: { path: string; severity: string }) => entry.path === "both.ts" && entry.severity === "info"));
  assert.ok((result as any)?.entries.some((entry: { path: string; severity: string }) => entry.path === "conflict.ts" && entry.severity === "error"));
  activity.dispose();
});

test("workspace search filters every rail source and opens exact results", async () => {
  const activity = new ActivityTracker("/repo");
  activity.start({ type: "tool_execution_start", toolCallId: "check-search", toolName: "bash", args: { command: "npm run typecheck" } }, 1);
  activity.end({ type: "tool_execution_end", toolCallId: "check-search", toolName: "bash", result: { content: [{ type: "text", text: "src/app.ts(12,5): error TS2322: Wrong type" }] }, isError: true }, 20);
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; }, { activity, getTerminalRows: () => 30 });
  await settle();

  explorer.handleInput("/");
  for (const character of "c: wrong") explorer.handleInput(character);
  const search = stripTerminalSequences(explorer.render(80).join("\n"));
  assert.match(search, /WORKSPACE SEARCH/);
  assert.match(search, /RESULTS\s+1/);
  assert.match(search, /src\/app\.ts:12:5/);
  explorer.handleInput("\x0f");
  assert.deepEqual(result, { action: "edit", root: "/repo", path: "src/app.ts", line: 12, column: 5 });
  activity.dispose();
});

test("workspace search Enter reveals a changed file without opening it", async () => {
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "@@ -1 +1 @@\n-old\n+new", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; }, { getTerminalRows: () => 30 });
  await settle();
  explorer.handleInput("/");
  for (const character of "f: working") explorer.handleInput(character);
  explorer.handleInput("\r");
  await settle();
  const revealed = stripTerminalSequences(explorer.render(80).join("\n"));
  assert.equal(result, undefined);
  assert.match(revealed, /WORKSPACE/);
  assert.match(revealed, /working\.ts/);
  explorer.dispose();
});

test("Explorer keys, diff colors/truncation, and renders stay width-safe", async () => {
  const colors: ThemeColor[] = [];
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.appearance.glyphPreset = "ascii";
  settings.explorer.maxDiffLines = 50;
  settings.git.ignoreWhitespace = true;
  const diff = Array.from({ length: 55 }, (_, index) => index % 3 === 0 ? `+added ${index}` : index % 3 === 1 ? `-removed ${index}` : ` context ${index}`).join("\n");
  let lastArgs: string[] = [];
  const exec: GitExec = async (_command, args) => { lastArgs = args; return { stdout: diff, stderr: "", code: 0, killed: false }; };
  let renders = 0;
  let closed = false;
  let refreshes = 0;
  const git = controller();
  git.refresh = async () => { refreshes++; };
  const explorer = new GitExplorer(git, exec, () => settings, fakeTheme(colors), () => renders++, () => { closed = true; });
  await settle();

  assert.equal(explorer.selected, 0);
  explorer.handleInput("j");
  assert.equal(explorer.selected, 1);
  await settle();
  explorer.handleInput("\r");
  assert.equal(explorer.focus, "diff");
  explorer.handleInput("j");
  assert.equal(explorer.diffScroll, 1);
  explorer.handleInput("\x04");
  assert.ok(explorer.diffScroll > 1);
  explorer.handleInput("r");
  assert.equal(refreshes, 1);
  explorer.handleInput("\t");
  assert.equal(explorer.scope, "staged");
  assert.equal(explorer.selected, 0);
  await settle();

  for (const width of [40, 60, 100, 140]) {
    const lines = explorer.render(width);
    assert.ok(lines.length > 5);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeded ${width}`);
  }
  assert.ok(colors.includes("toolDiffAdded"));
  assert.ok(colors.includes("toolDiffRemoved"));
  assert.ok(lastArgs.includes("--ignore-all-space"));
  assert.match(explorer.render(60).join("\n"), /truncated/);
  assert.ok(renders > 0);

  explorer.handleInput("q");
  assert.equal(closed, true);
});

test("Explorer renders loading, error, empty, and binary diff states", async () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  const renderWith = async (exec: GitExec, beforeRender?: () => Promise<void>) => {
    const explorer = new GitExplorer(controller(), exec, () => settings, fakeTheme(), () => {}, () => {});
    await beforeRender?.();
    const output = explorer.render(60).join("\n");
    explorer.dispose();
    return output;
  };

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const loadingExec: GitExec = async () => { await pending; return { stdout: "", stderr: "", code: 0, killed: false }; };
  const loading = await renderWith(loadingExec);
  assert.match(loading, /Loading diff/);
  release();

  const error = await renderWith(async () => ({ stdout: "", stderr: "diff failed", code: 2, killed: false }), settle);
  assert.match(error, /diff failed/);
  const empty = await renderWith(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), settle);
  assert.match(empty, /No textual changes/);
  const binary = await renderWith(async () => ({ stdout: "Binary files a and b differ\n", stderr: "", code: 0, killed: false }), settle);
  assert.match(binary, /Binary file/);
});

test("Explorer sanitizes malicious paths, diffs, and errors", async () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  const maliciousFile = { ...files[0]!, path: "bad\nname\t\x1b]0;owned\x07.ts" };
  const git = controller([maliciousFile]);
  const exec: GitExec = async () => ({ stdout: "+safe\x1b[31m\ttext\n-context\rhidden\x00", stderr: "", code: 0, killed: false });
  const explorer = new GitExplorer(git, exec, () => settings, {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme, () => {}, () => {});
  await settle();
  for (const width of [40, 60, 100]) {
    const lines = explorer.render(width);
    assert.ok(lines.every((line) => !/[\r\n\t]/.test(line) && !line.replaceAll("\x1b[0m", "").includes("\x1b")));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  explorer.dispose();

  const errorExplorer = new GitExplorer(git, async () => ({ stdout: "", stderr: "bad\n\x1b]0;owned\x07", code: 2, killed: false }), () => settings, {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme, () => {}, () => {});
  await settle();
  assert.ok(errorExplorer.render(60).every((line) => !/[\r\n\t]/.test(line) && !line.replaceAll("\x1b[0m", "").includes("\x1b")));
  errorExplorer.dispose();
});

test("Explorer row count responds to terminal height", async () => {
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "+line", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {});
  await settle();
  const original = process.stdout.rows;
  const counts: number[] = [];
  try {
    for (const rows of [12, 24, 60]) {
      Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
      const lines = explorer.render(100);
      counts.push(lines.length);
      assert.ok(lines.length <= Math.max(5, Math.floor(rows * 0.85)));
      assert.ok(lines.every((line) => visibleWidth(line) <= 100));
    }
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 24 });
    const embedded = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, () => {}, { embedded: true });
    await settle();
    const embeddedLines = embedded.render(50);
    assert.equal(embeddedLines.length, 24);
    assert.match(stripTerminalSequences(embeddedLines[0] ?? ""), /WORKSPACE/);
    assert.doesNotMatch(stripTerminalSequences(embeddedLines[0] ?? ""), /[╭┌]/);
    assert.ok(embeddedLines.some((line) => stripTerminalSequences(line).startsWith("⋮")), "integrated rail must expose a resize handle");
    embedded.dispose();
  } finally {
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: original });
    explorer.dispose();
  }
  assert.ok(counts[0]! < counts[1]! && counts[1]! < counts[2]!);
});

test("Explorer aborts stale diff loads when selection changes", async () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  let aborted = 0;
  const exec: GitExec = async (_command, args, options) => {
    const path = args.at(-1);
    if (path === "both.ts") {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => { aborted++; resolve(); }, { once: true }));
      return { stdout: "", stderr: "", code: 1, killed: true };
    }
    return { stdout: "+current", stderr: "", code: 0, killed: false };
  };
  const explorer = new GitExplorer(controller(), exec, () => settings, fakeTheme(), () => {}, () => {});
  await settle();
  explorer.handleInput("j");
  await settle();
  assert.equal(aborted, 1);
  assert.match(explorer.render(60).join("\n"), /current/);
  explorer.dispose();
});
