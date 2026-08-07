import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { detectRoot, discardTrackedFile, getDiff, getLineStats, getRepoState, GitCancelledError, GitError, previewUntracked, stageFile, unstageFile, type GitExec } from "../src/git/git.ts";

const exec: GitExec = (command: string, args: string[], options: ExecOptions = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let killed = false;
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", reject);
  const stop = () => { killed = true; child.kill(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  const timer = options.timeout === undefined ? undefined : setTimeout(stop, options.timeout);
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: code ?? 1, killed });
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

async function repository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "pi-codeui test");
  await git(root, "config", "user.email", "test@pi-codeui.invalid");
  return root;
}

test("non-repository is quiet and killed is authoritative", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codeui-none-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await detectRoot(exec, directory), undefined);
  assert.deepEqual(await getRepoState(exec, directory), { kind: "none" });

  const killed: GitExec = async () => ({ stdout: "", stderr: "", code: 0, killed: true });
  await assert.rejects(() => detectRoot(killed, directory), GitCancelledError);
});

test("Git calls forward argv/options and expose typed command and parse failures", async () => {
  const signal = new AbortController().signal;
  let call: { command: string; args: string[]; options?: ExecOptions } | undefined;
  const capture: GitExec = async (command, args, options) => {
    call = { command, args, options };
    return { stdout: "diff", stderr: "", code: 0, killed: false };
  };
  await getDiff(capture, "/repo", "-odd name", "cached", { context: 7, timeout: 123, signal });
  assert.deepEqual(call?.args, ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=7", "--", "-odd name"]);
  assert.equal(call?.command, "git");
  assert.equal(call?.options?.cwd, "/repo");
  assert.equal(call?.options?.timeout, 123);
  assert.equal(call?.options?.signal, signal);
  await getDiff(capture, "/repo", "file", "working", { ignoreWhitespace: true });
  assert.deepEqual(call?.args, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--ignore-all-space", "--", "file"]);
  await stageFile(capture, "/repo", "new name.ts", { relatedPath: "old name.ts" });
  assert.deepEqual(call?.args, ["add", "--", "new name.ts", "old name.ts"]);

  const commandFailure: GitExec = async () => ({ stdout: "", stderr: "broken", code: 2, killed: false });
  await assert.rejects(() => getDiff(commandFailure, "/repo", "file", "working"), (error: unknown) => error instanceof GitError && error.code === 2);
  const malformed: GitExec = async (_command, args) => args[0] === "rev-parse"
    ? { stdout: "/repo\n", stderr: "", code: 0, killed: false }
    : { stdout: "bad", stderr: "", code: 0, killed: false };
  await assert.rejects(() => getRepoState(malformed, "/repo"), GitError);
  const rejected: GitExec = async () => { throw new Error("cannot spawn"); };
  await assert.rejects(() => detectRoot(rejected, "/repo"), GitError);
});

test("safe file actions stage, unstage, and discard without shell interpolation", async (t) => {
  const root = await repository(t);
  const path = "-odd file.ts";
  await writeFile(join(root, path), "base\n");
  await git(root, "add", "--", path);
  await git(root, "commit", "-m", "base");

  await writeFile(join(root, path), "changed\n");
  await stageFile(exec, root, path);
  assert.match((await git(root, "status", "--short", "--", path)), /^M /);
  await unstageFile(exec, root, path);
  assert.match((await git(root, "status", "--short", "--", path)), /^ M/);
  await discardTrackedFile(exec, root, path);
  assert.equal(await git(root, "status", "--short", "--", path), "");

  await assert.rejects(() => stageFile(exec, root, "../outside"), /escapes the repository/);

  const unborn = await repository(t);
  await writeFile(join(unborn, "new.ts"), "new\n");
  await stageFile(exec, unborn, "new.ts");
  await unstageFile(exec, unborn, "new.ts", { unbornAdded: true });
  assert.match(await git(unborn, "status", "--short", "--", "new.ts"), /^\?\?/);
});

test("real Git repository status, diffs, stats, and root detection", async (t) => {
  const root = await repository(t);
  const unborn = await getRepoState(exec, root);
  assert.equal(unborn.kind, "repo");
  if (unborn.kind === "repo") assert.equal(unborn.status.branch.unborn, true);

  await writeFile(join(root, "tracked.txt"), "base\n");
  await writeFile(join(root, "delete.txt"), "delete me\n");
  await writeFile(join(root, "old name.txt"), "rename me\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const clean = await getRepoState(exec, root);
  assert.equal(clean.kind, "repo");
  if (clean.kind === "repo") assert.equal(clean.status.files.length, 0);

  await mkdir(join(root, "nested", "deep"), { recursive: true });
  assert.equal(await detectRoot(exec, join(root, "nested", "deep")), await realpath(root));

  await writeFile(join(root, "tracked.txt"), "base\nstaged\n");
  await git(root, "add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "base\nstaged\nworking\n");
  await rm(join(root, "delete.txt"));
  await git(root, "mv", "old name.txt", "new name.txt");
  await writeFile(join(root, "untracked name.txt"), "0123456789");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  await git(root, "add", "blob.bin");

  const dirty = await getRepoState(exec, root);
  assert.equal(dirty.kind, "repo");
  if (dirty.kind !== "repo") return;
  assert.ok(dirty.status.counts.staged >= 3);
  assert.ok(dirty.status.counts.unstaged >= 2);
  assert.equal(dirty.status.counts.untracked, 1);
  assert.ok(dirty.status.files.some((file) => file.path === "delete.txt" && file.worktree === "D"));
  assert.ok(dirty.status.files.some((file) => file.path === "new name.txt" && file.oldPath === "old name.txt"));

  const cached = await getDiff(exec, root, "tracked.txt", "cached", { context: 0 });
  assert.match(cached.text, /^\+staged$/m);
  assert.doesNotMatch(cached.text, /^\+working$/m);
  const working = await getDiff(exec, root, "tracked.txt", "working", { context: 0 });
  assert.match(working.text, /^\+working$/m);
  const limited = await getDiff(exec, root, "tracked.txt", "cached", { maxBytes: 8, maxLines: 1 });
  assert.equal(limited.truncated, true);
  assert.ok(limited.truncatedBy.includes("bytes"));
  const lineLimited = await getDiff(exec, root, "tracked.txt", "cached", { maxLines: 1 });
  assert.deepEqual(lineLimited.truncatedBy, ["lines"]);
  assert.ok(lineLimited.originalLines > 1);

  const binaryDiff = await getDiff(exec, root, "blob.bin", "cached");
  assert.equal(binaryDiff.binary, true);
  assert.match(binaryDiff.text, /Binary files/);
  const stats = await getLineStats(exec, root, "cached");
  assert.ok(stats.files >= 3);
  assert.ok(stats.added >= 1);
  assert.equal(stats.binaryFiles, 1);
  const workingStats = await getLineStats(exec, root, "working");
  assert.ok(workingStats.deleted >= 1);
  assert.ok(workingStats.added >= 1);

  assert.deepEqual(await previewUntracked(root, "untracked name.txt", 4), { text: "0123", binary: false, truncated: true, bytesRead: 5 });
  await writeFile(join(root, "untracked.bin"), Buffer.from([65, 0, 66]));
  assert.equal((await previewUntracked(root, "untracked.bin")).binary, true);
  await assert.rejects(() => previewUntracked(root, "../outside"), /escapes/);
  await assert.rejects(() => previewUntracked(root, "nested"), /regular file/);
  await symlink("untracked name.txt", join(root, "link.txt"));
  await assert.rejects(() => previewUntracked(root, "link.txt"), /symlink/);

  await git(root, "checkout", "--detach");
  const detached = await getRepoState(exec, root);
  assert.equal(detached.kind, "repo");
  if (detached.kind === "repo") assert.equal(detached.status.branch.detached, true);
});
