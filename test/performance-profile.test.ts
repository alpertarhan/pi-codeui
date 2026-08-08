import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityTracker } from "../src/activity.ts";
import { GitExplorer } from "../src/git-explorer.ts";
import { GitStateController } from "../src/git-state.ts";
import type { FileChange } from "../src/git/types.ts";
import { fuzzySearch, type SearchDocument } from "../src/search.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const elapsed = (start: number) => `${(performance.now() - start).toFixed(1)}ms`;

test("large workspace render, diff, activity, diagnostics, and search stay bounded and reuse caches", async (context) => {
  let pathReads = 0;
  const files = Array.from({ length: 4_000 }, (_, index) => {
    const file = {
      index: " ", worktree: "M", staged: false, unstaged: true, untracked: false, conflicted: false,
    } as FileChange;
    Object.defineProperty(file, "path", { enumerable: true, get: () => { pathReads++; return `packages/app/src/component-${index.toString().padStart(4, "0")}.ts`; } });
    return file;
  });
  const git = new GitStateController(async () => ({ stdout: "", stderr: "", code: 0, killed: false }), "/repo");
  git.state = {
    kind: "repo", root: "/repo",
    status: { branch: { name: "main", ahead: 0, behind: 0, detached: false, unborn: false, gone: false }, files, counts: { staged: 0, unstaged: files.length, untracked: 0, conflicted: 0 } },
    working: { files: files.length, added: 4_000, deleted: 4_000, binaryFiles: 0 },
    cached: { files: 0, added: 0, deleted: 0, binaryFiles: 0 },
  };

  const activity = new ActivityTracker("/repo", 1_100);
  for (let index = 0; index < 1_000; index++) {
    const id = `command-${index}`;
    activity.start({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: `echo command-${index}` } }, index * 2);
    activity.end({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: false }, index * 2 + 1);
  }
  activity.start({ type: "tool_execution_start", toolCallId: "large-check", toolName: "bash", args: { command: "npm run typecheck" } }, 3_000);
  const diagnosticOutput = Array.from({ length: 150 }, (_, index) => `src/problem-${index}.ts(1,1): error TS2322: Wrong type ${index}`).join("\n");
  activity.end({ type: "tool_execution_end", toolCallId: "large-check", toolName: "bash", result: { content: [{ type: "text", text: diagnosticOutput }] }, isError: true }, 3_001);
  assert.equal(activity.records.length, 1_001);
  assert.equal(activity.diagnostics.length, 100, "diagnostic memory shape must remain capped");

  const diff = [
    "diff --git a/file.ts b/file.ts", "index 111..222 100644", "--- a/file.ts", "+++ b/file.ts",
    ...Array.from({ length: 500 }, (_, hunk) => [
      `@@ -${hunk * 4 + 1},4 +${hunk * 4 + 1},4 @@ hunk ${hunk}`,
      ` context ${hunk}-a`, `-old ${hunk}-b`, `+new ${hunk}-b`, ` context ${hunk}-c`,
      `-old ${hunk}-d`, `+new ${hunk}-d`, ` context ${hunk}-e`, ` context ${hunk}-f`,
    ]).flat(),
  ].join("\n");
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.explorer.maxDiffLines = 5_000;
  let diffCalls = 0;
  const start = performance.now();
  const explorer = new GitExplorer(git, async (_command, args) => {
    if (args[0] === "diff") diffCalls++;
    return { stdout: diff, stderr: "", code: 0, killed: false };
  }, () => settings, theme, () => {}, () => {}, { embedded: true, getTerminalRows: () => 40, activity });
  await settle();
  const setupTiming = elapsed(start);

  const diffStart = performance.now();
  const firstDiffRender = explorer.render(120);
  const firstDiffTiming = elapsed(diffStart);
  const profile = explorer as unknown as {
    diffDisplayCache?: { lines: unknown[]; hunkLines?: Map<number, number> };
    hunkCache?: { hunks: unknown[] };
    searchCache?: { results: unknown[] };
    searchQuery: string;
  };
  const diffLines = profile.diffDisplayCache?.lines;
  const hunkLines = profile.diffDisplayCache?.hunkLines;
  const cachedDiffStart = performance.now();
  explorer.render(120);
  const cachedDiffTiming = elapsed(cachedDiffStart);
  assert.equal(diffCalls, 1, "repeated renders must not reload the diff");
  assert.strictEqual(profile.diffDisplayCache?.lines, diffLines, "formatted diff lines must be reused");
  assert.strictEqual(profile.diffDisplayCache?.hunkLines, hunkLines, "diff hunk indexing must be reused");
  assert.equal(diffLines?.length, 4_500);
  assert.equal(hunkLines?.size, 500);
  assert.equal(profile.hunkCache?.hunks.length, 500);
  assert.equal(firstDiffRender.length, 40);
  assert.ok(firstDiffRender.every((line) => visibleWidth(line) <= 120));

  explorer.handleInput("a");
  const activityStart = performance.now();
  const activityRows = explorer.render(120);
  const activityTiming = elapsed(activityStart);
  explorer.handleInput("c");
  const checkStart = performance.now();
  const checkRows = explorer.render(120);
  const checkTiming = elapsed(checkStart);
  assert.deepEqual([activityRows.length, checkRows.length], [40, 40]);
  assert.match(stripTerminalSequences(activityRows.join("\n")), /ACTIVITY\s+1001/);
  assert.match(stripTerminalSequences(checkRows.join("\n")), /PROBLEMS\s+100/);

  explorer.handleInput("/");
  profile.searchQuery = "f: component-3999";
  pathReads = 0;
  const searchStart = performance.now();
  const searchRows = explorer.render(120);
  const searchTiming = elapsed(searchStart);
  const firstSearchReads = pathReads;
  const searchResults = profile.searchCache?.results;
  pathReads = 0;
  const cachedSearchStart = performance.now();
  explorer.render(120);
  const cachedSearchTiming = elapsed(cachedSearchStart);
  assert.ok(firstSearchReads >= files.length, "a changed query must inspect the workspace once");
  assert.ok(pathReads <= 2, `a cached search reread ${pathReads} file paths`);
  assert.strictEqual(profile.searchCache?.results, searchResults, "identical search results must be reused");
  assert.ok((searchResults?.length ?? 0) <= 50);
  assert.equal(searchRows.length, 40);
  assert.ok(searchRows.every((line) => visibleWidth(line) <= 120));

  context.diagnostic(`local timings: setup ${setupTiming}; large diff render ${firstDiffTiming} then cached ${cachedDiffTiming}; 1,001 activity ${activityTiming}; 100 diagnostics ${checkTiming}; 5,101-document search ${searchTiming} then cached ${cachedSearchTiming}`);
  explorer.dispose();
  activity.dispose();
});

test("fuzzy search over ten thousand documents returns only the requested bounded result shape", (context) => {
  const documents: SearchDocument<number>[] = Array.from({ length: 10_000 }, (_, index) => ({
    id: `file:${index}`, kind: "file", title: `packages/service-${index}/src/handler.ts`, detail: index % 2 ? "modified working" : "staged", value: index,
  }));
  const start = performance.now();
  const results = fuzzySearch(documents, "f: service 999", 25);
  context.diagnostic(`local timing: 10,000-document fuzzy search ${elapsed(start)}`);
  assert.ok(results.length > 0 && results.length <= 25);
  assert.ok(results.every((result) => result.kind === "file" && Number.isFinite(result.score)));
  assert.ok(results.some((result) => result.value === 999));
});
