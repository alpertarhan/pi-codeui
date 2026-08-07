import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderChangesWidget } from "../src/changes-widget.ts";
import type { GitExec } from "../src/git/git.ts";
import { GitStateController, type GitViewState } from "../src/git-state.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";
import { sanitizeTerminalLine } from "../src/terminal.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const status = (files = "") => `## main\0${files}`;
const successfulExec: GitExec = async (_command, args) => {
  if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
  if (args[0] === "status") return { stdout: status(" M file.ts\0"), stderr: "", code: 0, killed: false };
  return { stdout: "2\t1\tfile.ts\0", stderr: "", code: 0, killed: false };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Git state debounces bursts and publishes repo stats", async () => {
  let roots = 0;
  const exec: GitExec = async (command, args, options) => {
    if (args[0] === "rev-parse") roots++;
    return successfulExec(command, args, options);
  };
  const controller = new GitStateController(exec, "/work", 10);
  controller.schedule();
  controller.schedule();
  controller.schedule();
  await delay(40);
  assert.equal(roots, 1);
  assert.equal(controller.state.kind, "repo");
  if (controller.state.kind === "repo") {
    assert.equal(controller.state.working.added, 2);
    assert.equal(controller.state.cached.deleted, 1);
  }
  controller.dispose();
});

test("Git state aborts stale refreshes and dispose cancels work", async () => {
  let first = true;
  let aborts = 0;
  const exec: GitExec = async (command, args, options) => {
    if (args[0] === "rev-parse" && first) {
      first = false;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => { aborts++; resolve(); }, { once: true }));
      return { stdout: "", stderr: "", code: 1, killed: true };
    }
    return successfulExec(command, args, options);
  };
  const controller = new GitStateController(exec, "/work");
  const stale = controller.refresh();
  await delay(0);
  await controller.refresh();
  await stale;
  assert.equal(aborts, 1);
  assert.equal(controller.state.kind, "repo");

  first = true;
  const pending = controller.refresh();
  await delay(0);
  controller.dispose();
  await pending;
  assert.equal(aborts, 2);
});

test("changes widget handles nonrepo, clean, dirty, presets, and narrow widths", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.appearance.glyphPreset = "ascii";
  const clean: GitViewState = {
    kind: "repo", root: "/repo",
    status: { branch: { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false }, files: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } },
    working: { files: 0, added: 0, deleted: 0, binaryFiles: 0 }, cached: { files: 0, added: 0, deleted: 0, binaryFiles: 0 },
  };
  assert.deepEqual(renderChangesWidget({ kind: "none" }, settings, theme, 40), []);
  assert.match(renderChangesWidget(clean, settings, theme, 40)[0] ?? "", /git main.*clean/);

  const file = { path: "src/a-very-long-file-name.ts", index: "M" as const, worktree: "M" as const, staged: true, unstaged: true, untracked: false, conflicted: false };
  const dirty: GitViewState = {
    ...clean, status: { ...clean.status, files: [file], counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 } },
    working: { files: 1, added: 3, deleted: 2, binaryFiles: 0 }, cached: { files: 1, added: 4, deleted: 1, binaryFiles: 0 },
  };
  const line = renderChangesWidget(dirty, settings, theme, 100)[0] ?? "";
  assert.match(line, /A1 M1 \?0 !0/);
  assert.match(line, /\+7.*-3/);
  assert.match(line, /src\/a-very-long-file-name\.ts/);
  for (const width of [40, 60, 100, 140]) {
    assert.ok(renderChangesWidget(dirty, settings, theme, width).every((value) => visibleWidth(value) <= width));
  }

  settings.appearance.density = "comfortable";
  settings.appearance.borders = "square";
  const comfortable = renderChangesWidget(clean, settings, theme, 60);
  assert.equal(comfortable.length, 3);
  assert.match(comfortable[0] ?? "", /^┌/);
});

test("widget hides untracked-only dirt when showUntracked is disabled", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.git.showUntracked = false;
  settings.appearance.glyphPreset = "ascii";
  const state: GitViewState = {
    kind: "repo", root: "/repo",
    status: {
      branch: { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false },
      files: [{ path: "new.ts", index: "?", worktree: "?", staged: false, unstaged: false, untracked: true, conflicted: false }],
      counts: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 },
    },
    working: { files: 0, added: 0, deleted: 0, binaryFiles: 0 }, cached: { files: 0, added: 0, deleted: 0, binaryFiles: 0 },
  };
  const line = renderChangesWidget(state, settings, theme, 80)[0] ?? "";
  assert.match(line, /clean/);
  assert.doesNotMatch(line, /\?1|new\.ts/);
});

test("terminal sanitizer and widget neutralize malicious Git text", () => {
  assert.equal(sanitizeTerminalLine("a\r\nb\tc\x00\x1b]0;owned\x07"), "a  b c�");
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.appearance.glyphPreset = "ascii";
  const state: GitViewState = {
    kind: "repo", root: "/repo",
    status: {
      branch: { name: "main\n\x1b[31mowned", ahead: 0, behind: 0, detached: false, unborn: false, gone: false },
      files: [{ path: "bad\nname\t\x1b]0;owned\x07.ts", index: "M", worktree: " ", staged: true, unstaged: false, untracked: false, conflicted: false }],
      counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    },
    working: { files: 0, added: 0, deleted: 0, binaryFiles: 0 }, cached: { files: 1, added: 1, deleted: 0, binaryFiles: 0 },
  };
  for (const width of [40, 60, 100]) {
    const lines = renderChangesWidget(state, settings, theme, width);
    assert.ok(lines.every((line) => !/[\r\n\t]/.test(line) && !line.replaceAll("\x1b[0m", "").includes("\x1b")));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  const error = renderChangesWidget({ kind: "error", message: "bad\n\x1b]0;owned\x07" }, settings, theme, 40)[0] ?? "";
  assert.ok(!/[\r\n\t]/.test(error) && !error.replaceAll("\x1b[0m", "").includes("\x1b"));
});
