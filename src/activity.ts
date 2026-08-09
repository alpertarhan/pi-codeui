import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  SessionEntry,
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

export interface ActivityRerun {
  command: string;
  cwd: string;
  timeout?: number;
}

export interface ActivityRerunResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  error?: unknown;
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
  rerun?: ActivityRerun;
}

export type ActivityListener = () => void;

export interface LatestRequestSummary {
  id: number;
  active: boolean;
  editedPaths: readonly string[];
  editedPathCount: number;
  checkCount: number;
  failureCount: number;
}

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
const checkKey = (record: ActivityRecord): string => record.rerun
  ? `${record.kind}:${record.rerun.cwd}:${record.rerun.timeout ?? ""}:${record.rerun.command}`
  : `${record.kind}:${record.how}`;

function normalizeDiagnosticPath(cwd: string, root: string, candidate: string): string | undefined {
  const cleaned = candidate.trim().replace(/^[>(❯)\s]+/, "").replace(/^file:\/\//, "").replace(/^['"]|['"]$/g, "");
  if (!cleaned) return undefined;
  const absolute = resolve(cwd, cleaned);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  return sanitizeTerminalLine(fromRoot.split(sep).join("/"));
}

export function parseDiagnostics(output: string, cwd: string, source: Diagnostic["source"], checkId: string = source, root = cwd): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  let eslintPath: string | undefined;
  const push = (candidate: string, line: string, column: string | undefined, severity: string | undefined, message: string): void => {
    const path = normalizeDiagnosticPath(cwd, root, candidate);
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
  private root: string;
  private readonly maxRecords: number;
  private readonly listeners = new Set<ActivityListener>();
  private readonly history: ActivityRecord[] = [];
  private readonly touchedAt = new Map<string, number>();
  private readonly requestByTool = new Map<string, number>();
  private latest: { id: number; active: boolean; editedPaths: Set<string>; checkCount: number; failureCount: number } | undefined;
  private nextRequestId = 0;
  private nextRerunId = 0;
  private rerunRunning = false;
  private narrative = "Waiting for the next action";
  private revision = 0;
  private disposed = false;

  constructor(cwd: string, maxRecords = 100) {
    this.cwd = resolve(cwd);
    this.root = this.cwd;
    this.maxRecords = maxRecords;
  }

  setRoot(root: string): void {
    const previous = this.root;
    this.root = resolve(root);
    if (this.root === previous) return;
    const rebase = (path: string): string => this.pathFromRoot(resolve(previous, path), path);
    for (const record of this.history) {
      if (record.path) record.path = rebase(record.path);
      for (const diagnostic of record.diagnostics ?? []) diagnostic.path = rebase(diagnostic.path);
    }
    const touched = [...this.touchedAt];
    this.touchedAt.clear();
    for (const [path, timestamp] of touched) this.touchedAt.set(rebase(path), timestamp);
    if (this.latest) this.latest.editedPaths = new Set([...this.latest.editedPaths].map(rebase));
    this.emit();
  }

  get records(): readonly ActivityRecord[] {
    return this.history;
  }

  get version(): number {
    return this.revision;
  }

  get isRerunning(): boolean {
    return this.rerunRunning;
  }

  get latestRequest(): LatestRequestSummary | undefined {
    if (!this.latest) return undefined;
    const editedPaths = [...this.latest.editedPaths];
    return { ...this.latest, editedPaths, editedPathCount: editedPaths.length };
  }

  get current(): ActivityRecord | undefined {
    return this.history.find((record) => record.status === "running") ?? this.history[0];
  }

  get checks(): readonly ActivityRecord[] {
    const seen = new Set<string>();
    return this.history.filter((record) => {
      const key = checkKey(record);
      if (!validationKinds.has(record.kind) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  get diagnostics(): readonly Diagnostic[] {
    const seen = new Set<string>();
    const current: Diagnostic[] = [];
    for (const record of this.history) {
      const key = checkKey(record);
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

  beginRequest(): void {
    this.latest = { id: ++this.nextRequestId, active: true, editedPaths: new Set(), checkCount: 0, failureCount: 0 };
    this.emit();
  }

  finalizeRequest(): void {
    if (!this.latest?.active) return;
    this.latest.active = false;
    this.emit();
  }

  hydrate(entries: readonly SessionEntry[]): void {
    type Call = { id: string; name: string; args: ToolArgs; why: string; timestamp: number; entryIndex: number; partIndex: number };
    type Result = { name: string; content: unknown; isError: boolean; timestamp: number };
    const calls: Call[] = [];
    const results = new Map<string, Result>();
    let lastUserIndex = -1;
    let narrative = this.narrative;
    const timestamp = (entry: SessionEntry, message: { timestamp?: unknown }, entryFirst = false): number => {
      const messageTime = typeof message.timestamp === "number" ? message.timestamp : NaN;
      const entryTime = Date.parse(entry.timestamp);
      if (entryFirst && Number.isFinite(entryTime)) return entryTime;
      return Number.isFinite(messageTime) ? messageTime : Number.isFinite(entryTime) ? entryTime : 0;
    };

    entries.forEach((entry, entryIndex) => {
      if (entry.type !== "message") return;
      const message = entry.message as { role?: string; content?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; timestamp?: unknown };
      if (message.role === "user") {
        lastUserIndex = entryIndex;
        return;
      }
      if (message.role === "assistant" && Array.isArray(message.content)) {
        const text = message.content
          .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
          .map((part) => String((part as { text?: unknown }).text ?? ""))
          .join(" ");
        if (text.trim()) narrative = compact(text, 280);
        message.content.forEach((part, partIndex) => {
          if (!part || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") return;
          const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
          if (typeof call.id !== "string" || typeof call.name !== "string") return;
          calls.push({
            id: call.id,
            name: call.name,
            args: call.arguments && typeof call.arguments === "object" ? call.arguments as ToolArgs : {},
            why: narrative,
            timestamp: timestamp(entry, message, true),
            entryIndex,
            partIndex,
          });
        });
        return;
      }
      if (message.role === "toolResult" && typeof message.toolCallId === "string" && typeof message.toolName === "string") {
        results.set(message.toolCallId, {
          name: message.toolName,
          content: message.content,
          isError: message.isError === true,
          timestamp: timestamp(entry, message),
        });
      }
    });

    const completed = calls
      .filter((call) => results.has(call.id) && !this.history.some((record) => record.id === call.id))
      .sort((left, right) => left.timestamp - right.timestamp || left.entryIndex - right.entryIndex || left.partIndex - right.partIndex)
      .slice(-this.maxRecords);
    let requestStarted = false;
    for (const call of completed) {
      if (!requestStarted && lastUserIndex >= 0 && call.entryIndex > lastUserIndex) {
        this.beginRequest();
        requestStarted = true;
      }
      this.narrative = call.why;
      this.start({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args }, call.timestamp);
      const result = results.get(call.id)!;
      this.end({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: result.name,
        result: { content: result.content },
        isError: result.isError,
      }, result.timestamp);
    }
    if (lastUserIndex >= 0) {
      if (!requestStarted) this.beginRequest();
      this.finalizeRequest();
    }
    this.narrative = narrative;
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
    if (this.history.some((record) => record.id === event.toolCallId)) return;
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
      ...(event.toolName === "bash" && validationKinds.has(description.kind) && typeof args.command === "string" ? {
        rerun: {
          command: args.command,
          cwd: this.cwd,
          ...(typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0 ? { timeout: args.timeout } : {}),
        },
      } : {}),
    };
    this.history.unshift(record);
    if (this.history.length > this.maxRecords) this.history.length = this.maxRecords;
    if (this.latest?.active) this.requestByTool.set(record.id, this.latest.id);
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
    const requestId = this.requestByTool.get(event.toolCallId);
    this.requestByTool.delete(event.toolCallId);
    if (!record || record.status !== "running") return;
    record.status = event.isError ? "error" : "success";
    record.endedAt = now;
    record.durationMs = Math.max(0, now - record.startedAt);
    const output = resultOutput(event.result);
    const detail = resultText(event.result);
    record.result = event.isError ? `Failed${detail ? ` · ${detail}` : ""}` : `Completed in ${formatDuration(record.durationMs)}${detail ? ` · ${detail}` : ""}`;
    if (validationKinds.has(record.kind)) record.diagnostics = parseDiagnostics(output, this.cwd, record.kind as Diagnostic["source"], record.id, this.root);
    if (record.path && (record.kind === "edit" || record.kind === "write")) this.touchedAt.set(record.path, now);
    const latest = requestId !== undefined && this.latest?.id === requestId ? this.latest : undefined;
    if (latest) {
      if (!event.isError && record.path && (record.kind === "edit" || record.kind === "write")) latest.editedPaths.add(record.path);
      if (validationKinds.has(record.kind)) {
        latest.checkCount++;
        if (event.isError) latest.failureCount++;
      }
    }
    this.emit();
  }

  async rerun(record: ActivityRecord, execute: (rerun: ActivityRerun) => Promise<ActivityRerunResult>): Promise<ActivityRecord | undefined> {
    if (!record.rerun || !validationKinds.has(record.kind) || this.rerunRunning) return undefined;
    this.rerunRunning = true;
    const id = `rerun-${Date.now()}-${++this.nextRerunId}`;
    const timeout = Number.isFinite(record.rerun.timeout) && record.rerun.timeout! > 0 ? record.rerun.timeout : undefined;
    const rerun = { command: record.rerun.command, cwd: record.rerun.cwd, ...(timeout === undefined ? {} : { timeout }) };
    try {
      this.start({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "bash",
        args: { command: rerun.command, ...(rerun.timeout === undefined ? {} : { timeout: rerun.timeout }) },
      });
      try {
        const result = await execute(rerun);
        const error = result.error instanceof Error ? result.error.message : result.error === undefined ? "" : String(result.error);
        const output = [result.stdout, result.stderr, error].filter(Boolean).join("\n");
        this.end({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "bash",
          result: { content: output ? [{ type: "text", text: output }] : [] },
          isError: result.code !== 0 || result.killed || Boolean(result.error),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.end({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "bash",
          result: { content: [{ type: "text", text: message }] },
          isError: true,
        });
      }
      return this.history.find((item) => item.id === id);
    } finally {
      this.rerunRunning = false;
    }
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
    this.requestByTool.clear();
    this.listeners.clear();
  }

  private pathsMatch(left: string, right: string): boolean {
    return left === right;
  }

  private normalizePath(path: string): string {
    return this.pathFromRoot(resolve(this.cwd, path), path);
  }

  private pathFromRoot(absolute: string, fallback: string): string {
    const fromRoot = relative(this.root, absolute);
    const inside = fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
    return sanitizeTerminalLine(inside ? (fromRoot || fallback).split(sep).join("/") : fallback);
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
      const timeout = args.timeout ? ` · timeout ${args.timeout}s` : "";
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
