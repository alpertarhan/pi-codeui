import type { BranchInfo, FileChange, LineStats, RepoStatus, StatusCode } from "./types.ts";

const CONFLICTS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const STATUS_CODES = new Set([" ", "M", "T", "A", "D", "R", "C", "U", "?", "!"]);

export class PorcelainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PorcelainError";
  }
}

export function parseBranch(record: string): BranchInfo {
  if (!record.startsWith("## ")) throw new PorcelainError("missing branch header");
  const value = record.slice(3);
  const base = { ahead: 0, behind: 0, detached: false, unborn: false, gone: false };
  if (value === "HEAD (no branch)") return { ...base, name: null, detached: true };

  const unborn = value.startsWith("No commits yet on ");
  const branchValue = unborn ? value.slice(18) : value;
  const metadata = / \[([^\]]+)\]$/.exec(branchValue);
  const tracking = (metadata ? branchValue.slice(0, metadata.index) : branchValue).split("...");
  if (!tracking[0] || tracking.length > 2 || (tracking.length === 2 && !tracking[1])) throw new PorcelainError("invalid branch tracking header");
  const branch: BranchInfo = { ...base, name: tracking[0], unborn };
  if (tracking[1]) branch.upstream = tracking[1];
  if (metadata) {
    if (!branch.upstream) throw new PorcelainError("branch metadata requires an upstream");
    for (const item of metadata[1]!.split(", ")) {
      const count = /^(ahead|behind) (\d+)$/.exec(item);
      if (count) branch[count[1] as "ahead" | "behind"] = Number(count[2]);
      else if (item === "gone") branch.gone = true;
      else throw new PorcelainError(`invalid branch metadata: ${item}`);
    }
  }
  return branch;
}

export function parseStatus(output: string): RepoStatus {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length === 0) throw new PorcelainError("empty status output");
  const branch = parseBranch(records.shift()!);
  const files: FileChange[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.length < 4 || record[2] !== " ") throw new PorcelainError(`malformed status record at ${i + 1}`);
    const pair = record.slice(0, 2);
    const index = pair[0] as StatusCode;
    const worktree = pair[1] as StatusCode;
    const path = record.slice(3);
    if (!STATUS_CODES.has(index) || !STATUS_CODES.has(worktree) || !path) throw new PorcelainError(`invalid status record at ${i + 1}`);
    const renamed = index === "R" || index === "C" || worktree === "R" || worktree === "C";
    const oldPath = renamed ? records[++i] : undefined;
    if (renamed && !oldPath) throw new PorcelainError(`rename/copy record at ${i} is missing its source path`);
    const conflicted = CONFLICTS.has(pair);
    const untracked = pair === "??";
    files.push({
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      index,
      worktree,
      conflicted,
      untracked,
      staged: !conflicted && !untracked && index !== " " && index !== "!",
      unstaged: !conflicted && !untracked && worktree !== " " && worktree !== "!",
    });
  }

  return {
    branch,
    files,
    counts: {
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => file.unstaged).length,
      untracked: files.filter((file) => file.untracked).length,
      conflicted: files.filter((file) => file.conflicted).length,
    },
  };
}

export function parseNumstat(output: string): LineStats {
  const stats: LineStats = { files: 0, added: 0, deleted: 0, binaryFiles: 0 };
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t[\s\S]+$/.exec(record);
    if (!match) throw new PorcelainError("malformed numstat record");
    stats.files++;
    if (match[1] === "-" || match[2] === "-") stats.binaryFiles++;
    else {
      stats.added += Number(match[1]);
      stats.deleted += Number(match[2]);
    }
  }
  return stats;
}
