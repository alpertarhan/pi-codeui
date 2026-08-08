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
export type ActivityKind = "read" | "edit" | "write" | "bash" | "test" | "build" | "lint" | "search" | "research" | "export" | "decision" | "other";

export interface Diagnostic {
  id: string;
  checkId: string;
  source: "test" | "build" | "lint";
  severity: "error" | "warning";
  path: string;
  line: number;
  column: number;
  message: string;
}

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
  diagnostics?: Diagnostic[];
}

export type ActivityListener = () => void;

type ToolArgs = Record<string, unknown>;

const compact = (value: unknown, max = 240): string => {
  const text = sanitizeTerminalLine(String(value ?? "")).replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const lineCount = (value: string): number => value ? value.split("\n").length : 0;

const resultOutput = (result: unknown): string => {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("\n")
    .slice(0, 256 * 1024);
};

const resultText = (result: unknown): string | undefined => {
  const output = resultOutput(result);
  if (!output) return undefined;
  const lines = output.split("\n").map((line) => compact(line, 160)).filter(Boolean);
  return lines.findLast((line) => /\b(pass(?:ed)?|fail(?:ed)?|error|tests?|built|compiled|typecheck|lint)\b/i.test(line)) ?? lines[0];
};

const validationKinds = new Set<ActivityKind>(["test", "build", "lint"]);

function normalizeDiagnosticPath(cwd: string, candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/^[>(❯)\s]+/, "").replace(/^file:\/\//, "").replace(/^['"]|['"]$/g, "");
  if (!cleaned) return undefined;
  const absolute = resolve(cwd, cleaned);
  const fromCwd = relative(cwd, absolute);
  if (!fromCwd || fromCwd === ".." || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) return undefined;
  return sanitizeTerminalLine(fromCwd.split(sep).join("/"));
}

export function parseDiagnostics(output: string, cwd: string, source: Diagnostic["source"], checkId: string = source): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  let eslintPath: string | undefined;
  const push = (candidate: string, line: string, column: string | undefined, severity: string | undefined, message: string): void => {
    const path = normalizeDiagnosticPath(cwd, candidate);
    const lineNumber = Number(line);
    const columnNumber = Number(column ?? 1);
    if (!path || !Number.isInteger(lineNumber) || lineNumber < 1 || !Number.isInteger(columnNumber) || columnNumber < 1) return;
    const cleanMessage = compact(message.replace(/^[:\s-]+/, ""), 240) || "Check failed";
    const level = severity?.toLowerCase() === "warning" ? "warning" : "error";
    const key = `${path}:${lineNumber}:${columnNumber}:${level}:${cleanMessage}`;
    if (seen.has(key) || diagnostics.length >= 100) return;
    seen.add(key);
    diagnostics.push({ id: `${checkId}:${diagnostics.length}`, checkId, source, severity: level, path, line: lineNumber, column: columnNumber, message: cleanMessage });
  };

  for (const rawLine of output.split("\n")) {
    const line = sanitizeTerminalLine(rawLine).trimEnd();
    if (!line.trim()) continue;
    const typescript = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(?:[A-Z]+\d+:\s*)?(.+)$/i.exec(line);
    if (typescript) {
      push(typescript[1]!, typescript[2]!, typescript[3], typescript[4], typescript[5]!);
      continue;
    }
    const eslintDetail = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/i.exec(line);
    if (eslintDetail && eslintPath) {
      push(eslintPath, eslintDetail[1]!, eslintDetail[2], eslintDetail[3], eslintDetail[4]!);
      continue;
    }
    const colon = /^(.+?\.[A-Za-z0-9]+):(\d+)(?::(\d+))?:\s*(?:(error|warning)\s*:?[\s]*)?(.+)$/i.exec(line.trim());
    if (colon) {
      push(colon[1]!, colon[2]!, colon[3], colon[4], colon[5]!);
      continue;
    }
    const stack = /\(?([^()\s]+\.[A-Za-z0-9]+):(\d+):(\d+)\)?/.exec(line);
    if (stack && source === "test") {
      push(stack[1]!, stack[2]!, stack[3], "error", line.replace(stack[0], "").trim() || "Test failure");
      continue;
    }
    if (/^(?:\.?\.?\/|\/).+\.[A-Za-z0-9]+$/.test(line.trim())) eslintPath = line.trim();
  }
  return diagnostics;
}

export class ActivityTracker {
  private readonly cwd: string;
  private readonly maxRecords: number;
  private readonly listeners = new Set<ActivityListener>();
  private readonly history: ActivityRecord[] = [];
  private readonly touchedAt = new Map<string, number>();
  private narrative = "Waiting for the next action";
  private revision = 0;
  private disposed = false;

  constructor(cwd: string, maxRecords = 100) {
    this.cwd = cwd;
    this.maxRecords = maxRecords;
  }

  get records(): readonly ActivityRecord[] {
    return this.history;
  }

  get version(): number {
    return this.revision;
  }

  get current(): ActivityRecord | undefined {
    return this.history.find((record) => record.status === "running") ?? this.history[0];
  }

  get checks(): readonly ActivityRecord[] {
    const seen = new Set<string>();
    return this.history.filter((record) => {
      const key = `${record.kind}:${record.how}`;
      if (!validationKinds.has(record.kind) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get diagnostics(): readonly Diagnostic[] {
    const seen = new Set<string>();
    const current: Diagnostic[] = [];
    for (const record of this.history) {
      const key = `${record.kind}:${record.how}`;
      if (!validationKinds.has(record.kind) || record.status === "running" || seen.has(key)) continue;
      seen.add(key);
      current.push(...(record.diagnostics ?? []));
    }
    return current.slice(0, 100);
  }

  onChange(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginTurn(): void {
    this.narrative = "Understanding your request";
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
    const output = resultOutput(event.result);
    const detail = resultText(event.result);
    record.result = event.isError ? `Failed${detail ? ` · ${detail}` : ""}` : `Completed in ${formatDuration(record.durationMs)}${detail ? ` · ${detail}` : ""}`;
    if (validationKinds.has(record.kind)) record.diagnostics = parseDiagnostics(output, this.cwd, record.kind as Diagnostic["source"], record.id);
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
      const command = compact(args.command, 160);
      const lower = command.toLowerCase();
      const timeout = args.timeout ? ` · timeout ${args.timeout}ms` : "";
      if (/((npm|pnpm|yarn|bun)\s+(run\s+)?test|node\s+--test|vitest|jest|pytest|cargo\s+test|go\s+test)/.test(lower)) {
        return { kind: "test", what: "Running the test suite", how: `${command}${timeout}` };
      }
      if (/((npm|pnpm|yarn|bun)\s+(run\s+)?build|cargo\s+build|go\s+build)/.test(lower)) {
        return { kind: "build", what: "Building the project", how: `${command}${timeout}` };
      }
      if (/(tsc|typecheck|eslint|biome\s+check|\blint\b)/.test(lower)) {
        return { kind: "lint", what: "Validating code quality", how: `${command}${timeout}` };
      }
      return { kind: "bash", what: `Running ${command || "a shell command"}`, how: `Shell execution${timeout}` };
    }
    if (toolName === "grep" || toolName === "find" || toolName === "ls") {
      return { kind: "search", what: `${toolName === "grep" ? "Searching content" : toolName === "find" ? "Finding files" : "Listing files"}`, how: compact(JSON.stringify(args), 140) };
    }
    if (/web_(?:search|fetch)|search_web|fetch_url/.test(toolName)) {
      return { kind: "research", what: /fetch|url/.test(toolName) ? "Reading a web source" : "Researching the web", how: compact(JSON.stringify(args), 140) || "Web research" };
    }
    if (/preview_export|export/.test(toolName)) {
      return { kind: "export", what: "Exporting an artifact", how: compact(JSON.stringify(args), 140) || "Artifact export" };
    }
    if (/ask_user|question/.test(toolName)) {
      return { kind: "decision", what: "Requesting a decision", how: compact(JSON.stringify(args), 140) || "User input" };
    }
    return { kind: "other", what: `Using ${compact(toolName, 60)}`, how: compact(JSON.stringify(args), 140) || "Tool execution" };
  }

  private emit(): void {
    if (this.disposed) return;
    this.revision++;
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
