import assert from "node:assert/strict";
import test from "node:test";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { filesForScope, GitExplorer } from "../src/git-explorer.ts";
import type { GitExec } from "../src/git/git.ts";
import { GitStateController } from "../src/git-state.ts";
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

test("Explorer scopes include the right staged, working, conflict, and untracked files", () => {
  assert.deepEqual(filesForScope(files, "staged").map((file) => file.path), ["both.ts", "staged.ts"]);
  assert.deepEqual(filesForScope(files, "working").map((file) => file.path), ["both.ts", "working.ts", "conflict.ts", "new.ts"]);
  assert.deepEqual(filesForScope(files, "working", false).map((file) => file.path), ["both.ts", "working.ts", "conflict.ts"]);
});

test("Explorer returns a safe external-editor action for the selected file", async () => {
  let result: unknown;
  const explorer = new GitExplorer(controller(), async () => ({ stdout: "", stderr: "", code: 0, killed: false }), () => DEFAULT_SETTINGS, fakeTheme(), () => {}, (value) => { result = value; });
  await settle();
  explorer.handleInput("j");
  explorer.handleInput("e");
  assert.deepEqual(result, { action: "edit", root: "/repo", path: "working.ts" });
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
    assert.equal(embedded.render(50).length, 24);
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
