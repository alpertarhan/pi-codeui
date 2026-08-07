import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import type { FileChange } from "./git/types.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

export type ActivityStatus = "running" | "success" | "error";
export type ActivityKind = "read" | "edit" | "write" | "bash" | "search" | "other";

export interface ActivityRecord {
  id: string;
  toolName: string;
  kind: ActivityKind;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  path?: string;
  what: string;
  why: string;
  how: string;
  result: string;
}

export type ActivityListener = () => void;

type ToolArgs = Record<string, unknown>;

const compact = (value: unknown, max = 240): string => {
  const text = sanitizeTerminalLine(String(value ?? "")).replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const lineCount = (value: string): number => value ? value.split("\n").length : 0;

const resultText = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((part) => part && typeof part === "object" && (part as { type?: string }).type === "text") as { text?: string } | undefined;
  return text?.text ? compact(text.text.split("\n")[0], 160) : undefined;
};

export class ActivityTracker {
  private readonly cwd: string;
  private readonly maxRecords: number;
  private readonly listeners = new Set<ActivityListener>();
  private readonly history: ActivityRecord[] = [];
  private readonly touchedAt = new Map<string, number>();
  private narrative = "Waiting for the next AI action";
  private disposed = false;

  constructor(cwd: string, maxRecords = 100) {
    this.cwd = cwd;
    this.maxRecords = maxRecords;
  }

  get records(): readonly ActivityRecord[] {
    return this.history;
  }

  get current(): ActivityRecord | undefined {
    return this.history.find((record) => record.status === "running") ?? this.history[0];
  }

  onChange(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTurn(): void {
    this.narrative = "Understanding the requested change";
    this.emit();
  }

  captureMessage(event: MessageEndEvent): void {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const text = message.content
      .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => (part as { text?: string }).text ?? "")
      .join(" ");
    if (text.trim()) this.narrative = compact(text, 280);
  }

  start(event: ToolExecutionStartEvent, now = Date.now()): void {
    const args = event.args && typeof event.args === "object" ? event.args as ToolArgs : {};
    const path = typeof args.path === "string" ? this.normalizePath(args.path) : undefined;
    const description = this.describe(event.toolName, args, path);
    const record: ActivityRecord = {
      id: event.toolCallId,
      toolName: compact(event.toolName, 40),
      kind: description.kind,
      status: "running",
      startedAt: now,
      path,
      what: description.what,
      why: this.narrative,
      how: description.how,
      result: "In progress",
    };
    this.history.unshift(record);
    if (this.history.length > this.maxRecords) this.history.length = this.maxRecords;
    if (path && (record.kind === "edit" || record.kind === "write")) this.touchedAt.set(path, now);
    this.emit();
  }

  update(event: ToolExecutionUpdateEvent): void {
    const record = this.history.find((item) => item.id === event.toolCallId);
    if (!record || record.status !== "running" || record.result === "Receiving tool output") return;
    record.result = "Receiving tool output";
    this.emit();
  }

  end(event: ToolExecutionEndEvent, now = Date.now()): void {
    const record = this.history.find((item) => item.id === event.toolCallId);
    if (!record) return;
    record.status = event.isError ? "error" : "success";
    record.endedAt = now;
    record.durationMs = Math.max(0, now - record.startedAt);
    const detail = resultText(event.result);
    record.result = event.isError ? `Failed${detail ? ` · ${detail}` : ""}` : `Completed in ${formatDuration(record.durationMs)}${detail ? ` · ${detail}` : ""}`;
    if (record.path && (record.kind === "edit" || record.kind === "write")) this.touchedAt.set(record.path, now);
    this.emit();
  }

  orderFiles(files: readonly FileChange[]): FileChange[] {
    return files.map((file, index) => ({ file, index, touched: this.touchedTimestamp(file.path) ?? 0 }))
      .sort((a, b) => b.touched - a.touched || a.index - b.index)
      .map(({ file }) => file);
  }

  touchedTimestamp(path: string): number | undefined {
    const direct = this.touchedAt.get(path);
    if (direct !== undefined) return direct;
    let newest: number | undefined;
    for (const [candidate, timestamp] of this.touchedAt) {
      if (this.pathsMatch(candidate, path) && (newest === undefined || timestamp > newest)) newest = timestamp;
    }
    return newest;
  }

  isEditing(path: string): boolean {
    return this.history.some((record) => record.path && this.pathsMatch(record.path, path) && (record.kind === "edit" || record.kind === "write") && record.status === "running");
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private pathsMatch(left: string, right: string): boolean {
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
  }

  private normalizePath(path: string): string {
    const absolute = resolve(this.cwd, path);
    const fromCwd = relative(this.cwd, absolute);
    const inside = fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd);
    return sanitizeTerminalLine(inside ? (fromCwd || path).split(sep).join("/") : path);
  }

  private describe(toolName: string, args: ToolArgs, path?: string): Pick<ActivityRecord, "kind" | "what" | "how"> {
    if (toolName === "edit") {
      const edits = Array.isArray(args.edits) ? args.edits as Array<{ oldText?: unknown; newText?: unknown }> : [];
      const oldLines = edits.reduce((sum, edit) => sum + lineCount(String(edit.oldText ?? "")), 0);
      const newLines = edits.reduce((sum, edit) => sum + lineCount(String(edit.newText ?? "")), 0);
      return { kind: "edit", what: `Editing ${path ?? "a file"}`, how: `${edits.length} replacement${edits.length === 1 ? "" : "s"} · ${oldLines} old lines → ${newLines} new lines` };
    }
    if (toolName === "write") {
      const content = String(args.content ?? "");
      return { kind: "write", what: `Writing ${path ?? "a file"}`, how: `${lineCount(content)} lines · ${Buffer.byteLength(content)} bytes` };
    }
    if (toolName === "read") {
      const range = args.offset || args.limit ? ` · lines ${Number(args.offset ?? 1)}–${Number(args.offset ?? 1) + Number(args.limit ?? 0)}` : "";
      return { kind: "read", what: `Inspecting ${path ?? "a file"}`, how: `Read-only inspection${range}` };
    }
    if (toolName === "bash") {
      const command = compact(args.command, 120);
      return { kind: "bash", what: `Running ${command || "a shell command"}`, how: `Shell execution${args.timeout ? ` · timeout ${args.timeout}ms` : ""}` };
    }
    if (toolName === "grep" || toolName === "find" || toolName === "ls") {
      return { kind: "search", what: `${toolName === "grep" ? "Searching code" : toolName === "find" ? "Finding files" : "Listing files"}`, how: compact(JSON.stringify(args), 140) };
    }
    return { kind: "other", what: `Using ${compact(toolName, 60)}`, how: compact(JSON.stringify(args), 140) || "Tool execution" };
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
}
