import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseNumstat, parseStatus, PorcelainError } from "./porcelain.ts";
import type { LineStats, RepoState, TextResult, UntrackedPreview } from "./types.ts";

export type GitExec = ExtensionAPI["exec"];
export type DiffScope = "working" | "cached";
export interface PatchHunk {
  index: number;
  header: string;
  patch: string;
}
export const DEFAULT_GIT_TIMEOUT = 10_000;

export class GitError extends Error {
  readonly command: readonly string[];
  readonly code?: number;
  readonly stderr?: string;

  constructor(message: string, command: readonly string[] = [], result?: ExecResult, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitError";
    this.command = command;
    this.code = result?.code;
    this.stderr = result?.stderr;
  }
}

export class GitCancelledError extends GitError {
  constructor(command: readonly string[], result: ExecResult) {
    super("Git command was cancelled or timed out", command, result);
    this.name = "GitCancelledError";
  }
}

export interface GitCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface DiffOptions extends GitCallOptions {
  context?: number;
  maxBytes?: number;
  maxLines?: number;
  ignoreWhitespace?: boolean;
}

async function run(exec: GitExec, args: string[], cwd: string, options: GitCallOptions = {}): Promise<ExecResult> {
  const execOptions: ExecOptions = { cwd, timeout: options.timeout ?? DEFAULT_GIT_TIMEOUT };
  if (options.signal) execOptions.signal = options.signal;
  let result: ExecResult;
  try {
    result = await exec("git", args, execOptions);
  } catch (error) {
    throw new GitError(`failed to execute Git: ${(error as Error).message}`, ["git", ...args], undefined, { cause: error });
  }
  if (result.killed) throw new GitCancelledError(["git", ...args], result);
  return result;
}

function failed(args: string[], result: ExecResult): GitError {
  return new GitError(result.stderr.trim() || `git exited with code ${result.code}`, ["git", ...args], result);
}

export async function detectRoot(exec: GitExec, cwd: string, options: GitCallOptions = {}): Promise<string | undefined> {
  const args = ["rev-parse", "--show-toplevel"];
  const result = await run(exec, args, cwd, options);
  if (result.code !== 0) {
    if (/not a git repository/i.test(result.stderr)) return undefined;
    throw failed(args, result);
  }
  const root = result.stdout.replace(/\r?\n$/, "");
  if (!root) throw new GitError("git returned an empty repository root", ["git", ...args], result);
  return root;
}

export async function getRepoState(exec: GitExec, cwd: string, options: GitCallOptions = {}): Promise<RepoState> {
  const root = await detectRoot(exec, cwd, options);
  if (!root) return { kind: "none" };
  const args = ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"];
  const result = await run(exec, args, root, options);
  if (result.code !== 0) throw failed(args, result);
  try {
    return { kind: "repo", root, status: parseStatus(result.stdout) };
  } catch (error) {
    if (error instanceof PorcelainError) throw new GitError(error.message, ["git", ...args], result, { cause: error });
    throw error;
  }
}

function boundedText(text: string, maxBytes: number, maxLines: number): TextResult {
  const source = Buffer.from(text);
  const originalLines = text === "" ? 0 : (text.match(/\n/g)?.length ?? 0) + (text.endsWith("\n") ? 0 : 1);
  const truncatedBy: Array<"bytes" | "lines"> = [];
  let bounded = source;
  if (source.length > maxBytes) {
    bounded = source.subarray(0, maxBytes);
    truncatedBy.push("bytes");
  }
  let result = bounded.toString("utf8");
  const lines = result.split("\n");
  const boundedLineCount = result === "" ? 0 : lines.length - (result.endsWith("\n") ? 1 : 0);
  if (boundedLineCount > maxLines) {
    result = lines.slice(0, maxLines).join("\n");
    truncatedBy.push("lines");
  }
  return {
    text: result,
    binary: source.includes(0) || /(^|\n)Binary files .* differ(?:\n|$)/.test(text),
    truncated: truncatedBy.length > 0,
    truncatedBy,
    originalBytes: source.length,
    originalLines,
  };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

export async function getDiff(exec: GitExec, root: string, path: string, scope: DiffScope, options: DiffOptions = {}): Promise<TextResult> {
  const context = nonNegativeInteger(options.context ?? 3, "context");
  const maxBytes = nonNegativeInteger(options.maxBytes ?? 512 * 1024, "maxBytes");
  const maxLines = nonNegativeInteger(options.maxLines ?? 2_000, "maxLines");
  const args = ["diff", ...(scope === "cached" ? ["--cached"] : []), "--no-ext-diff", "--no-color", `--unified=${context}`, ...(options.ignoreWhitespace ? ["--ignore-all-space"] : []), "--", path];
  const result = await run(exec, args, root, options);
  if (result.code !== 0) throw failed(args, result);
  return boundedText(result.stdout, maxBytes, maxLines);
}

export function parsePatchHunks(patch: string): PatchHunk[] {
  if (!patch || patch.includes("\0")) return [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk < 0) return [];
  const header = lines.slice(0, firstHunk);
  if (!header.some((line) => line.startsWith("--- ")) || !header.some((line) => line.startsWith("+++ "))) return [];
  const starts: number[] = [];
  for (let index = firstHunk; index < lines.length; index++) if (lines[index]?.startsWith("@@")) starts.push(index);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const body = lines.slice(start, end);
    while (body.at(-1) === "") body.pop();
    return { index, header: body[0] ?? "", patch: `${[...header, ...body].join("\n")}\n` };
  });
}

export async function applyPatchHunk(exec: GitExec, root: string, patch: string, scope: DiffScope, options: GitCallOptions = {}): Promise<void> {
  if (!patch || patch.length > 1024 * 1024 || patch.includes("\0")) throw new GitError("invalid or oversized Git patch hunk");
  const directory = await mkdtemp(join(tmpdir(), "pi-codeui-hunk-"));
  const patchPath = join(directory, "hunk.patch");
  const base = ["apply", "--cached", "--recount", "--unidiff-zero", "--whitespace=nowarn", ...(scope === "cached" ? ["--reverse"] : [])];
  try {
    await writeFile(patchPath, patch, { encoding: "utf8", mode: 0o600 });
    const check = [...base, "--check", "--", patchPath];
    const checked = await run(exec, check, root, options);
    if (checked.code !== 0) throw failed(check, checked);
    const apply = [...base, "--", patchPath];
    const applied = await run(exec, apply, root, options);
    if (applied.code !== 0) throw failed(apply, applied);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function validateCommitMessage(message: string): string {
  const value = message.trim();
  if (!value) throw new GitError("commit message cannot be empty");
  if (value.length > 200) throw new GitError("commit message must be 200 characters or fewer");
  if (/[\r\n\0]/.test(value)) throw new GitError("commit message must be a single safe line");
  return value;
}

export async function commitStaged(exec: GitExec, root: string, message: string, options: GitCallOptions = {}): Promise<void> {
  const value = validateCommitMessage(message);
  const args = ["commit", "-m", value];
  const result = await run(exec, args, root, options);
  if (result.code !== 0) throw failed(args, result);
}

export async function getLineStats(exec: GitExec, root: string, scope: DiffScope, options: GitCallOptions = {}): Promise<LineStats> {
  const args = ["diff", ...(scope === "cached" ? ["--cached"] : []), "--numstat", "-z", "--no-renames", "--no-ext-diff"];
  const result = await run(exec, args, root, options);
  if (result.code !== 0) throw failed(args, result);
  try {
    return parseNumstat(result.stdout);
  } catch (error) {
    if (error instanceof PorcelainError) throw new GitError(error.message, ["git", ...args], result, { cause: error });
    throw error;
  }
}

function repositoryPath(root: string, path: string): { absolutePath: string; fromRoot: string } {
  if (!path || isAbsolute(path) || path.includes("\0")) throw new GitError("Git path must be relative to the repository");
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const fromRoot = relative(absoluteRoot, absolutePath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new GitError("Git path escapes the repository");
  return { absolutePath, fromRoot };
}

async function mutateFiles(exec: GitExec, root: string, paths: string[], args: string[], options: GitCallOptions = {}): Promise<void> {
  for (const path of paths) repositoryPath(root, path);
  const command = [...args, "--", ...paths];
  const result = await run(exec, command, root, options);
  if (result.code !== 0) throw failed(command, result);
}

export async function stageFile(exec: GitExec, root: string, path: string, options: GitCallOptions & { relatedPath?: string } = {}): Promise<void> {
  const { relatedPath, ...callOptions } = options;
  await mutateFiles(exec, root, relatedPath ? [path, relatedPath] : [path], ["add"], callOptions);
}

export async function unstageFile(exec: GitExec, root: string, path: string, options: GitCallOptions & { unbornAdded?: boolean; relatedPath?: string } = {}): Promise<void> {
  const { unbornAdded = false, relatedPath, ...callOptions } = options;
  await mutateFiles(exec, root, relatedPath ? [path, relatedPath] : [path], unbornAdded ? ["rm", "--cached", "--quiet"] : ["restore", "--staged"], callOptions);
}

export async function discardTrackedFile(exec: GitExec, root: string, path: string, options: GitCallOptions = {}): Promise<void> {
  await mutateFiles(exec, root, [path], ["restore", "--worktree"], options);
}

export async function previewUntracked(root: string, path: string, maxBytes = 256 * 1024): Promise<UntrackedPreview> {
  nonNegativeInteger(maxBytes, "maxBytes");
  const absoluteRoot = resolve(root);
  const { absolutePath, fromRoot } = repositoryPath(root, path);

  let current = absoluteRoot;
  for (const part of fromRoot.split(sep)) {
    current = resolve(current, part);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      throw new GitError(`cannot inspect untracked path: ${error.message}`, [], undefined, { cause: error });
    });
    if (stat.isSymbolicLink()) throw new GitError("untracked preview does not follow symlinks");
    if (current !== absolutePath && !stat.isDirectory()) throw new GitError("untracked path has a non-directory parent");
    if (current === absolutePath && !stat.isFile()) throw new GitError("untracked preview requires a regular file");
  }

  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new GitError("untracked preview requires a regular file");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const content = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    return { text: content.toString("utf8"), binary: content.includes(0), truncated, bytesRead };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError(`cannot read untracked path: ${(error as Error).message}`, [], undefined, { cause: error });
  } finally {
    await handle?.close();
  }
}
