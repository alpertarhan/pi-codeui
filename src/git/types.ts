export type StatusCode = " " | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

export interface BranchInfo {
  name: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
  gone: boolean;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  index: StatusCode;
  worktree: StatusCode;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface ChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface RepoStatus {
  branch: BranchInfo;
  files: FileChange[];
  counts: ChangeCounts;
}

export type RepoState =
  | { kind: "none" }
  | { kind: "repo"; root: string; status: RepoStatus };

export interface LineStats {
  files: number;
  added: number;
  deleted: number;
  binaryFiles: number;
}

export interface TextResult {
  text: string;
  binary: boolean;
  truncated: boolean;
  truncatedBy: Array<"bytes" | "lines">;
  originalBytes: number;
  originalLines: number;
}

export interface UntrackedPreview {
  text: string;
  binary: boolean;
  truncated: boolean;
  bytesRead: number;
}
