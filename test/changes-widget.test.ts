import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderChangesWidget } from "../src/changes-widget.ts";
import type { GitViewState } from "../src/git-state.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const repo = (dirty: boolean): GitViewState => ({
  kind: "repo",
  root: "/repo",
  status: {
    branch: { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false },
    files: dirty ? [{ path: "src/app.ts", index: " ", worktree: "M", staged: false, unstaged: true, untracked: false, conflicted: false }] : [],
    counts: { staged: 0, unstaged: dirty ? 1 : 0, untracked: 0, conflicted: 0 },
  },
  working: { files: dirty ? 1 : 0, added: dirty ? 8 : 0, deleted: dirty ? 2 : 0, binaryFiles: 0 },
  cached: { files: 0, added: 0, deleted: 0, binaryFiles: 0 },
});

test("Changes strip is quiet unless the repository is dirty", () => {
  assert.deepEqual(renderChangesWidget({ kind: "none" }, DEFAULT_SETTINGS, theme, 100), []);
  assert.deepEqual(renderChangesWidget({ kind: "loading" }, DEFAULT_SETTINGS, theme, 100), []);
  assert.deepEqual(renderChangesWidget(repo(false), DEFAULT_SETTINGS, theme, 100), []);
  const dirty = renderChangesWidget(repo(true), DEFAULT_SETTINGS, theme, 100).join("\n");
  assert.match(dirty, /CHANGES/);
  assert.match(dirty, /main/);
  assert.match(dirty, /src\/app\.ts/);
  assert.match(dirty, /\+8.*-2/);
});
