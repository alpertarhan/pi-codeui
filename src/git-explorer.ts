import type { Theme } from "@earendil-works/pi-coding-agent";
import type { QuickfixEntry } from "./external-editor.ts";
import { Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./tui-compat.ts";
import { formatDuration, relativeTime, type ActivityRecord, type ActivityTracker, type Diagnostic } from "./activity.ts";
import { applyPatchHunk, commitStaged, discardTrackedFile, getDiff, parsePatchHunks, previewUntracked, stageFile, unstageFile, validateCommitMessage, type DiffScope, type GitExec, type PatchHunk } from "./git/git.ts";
import type { FileChange, TextResult } from "./git/types.ts";
import type { GitStateController } from "./git-state.ts";
import { fuzzySearch, type RankedSearchDocument, type SearchDocument } from "./search.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { BORDER_PRESETS, DENSITY_PRESETS, type CodeuiSettings } from "./settings.ts";
import { EMPTY_SESSION_OVERVIEW, type SessionMessageSummary, type SessionOverview } from "./session.ts";
import { sanitizeTerminalLine } from "./terminal.ts";
import type { WorkspaceUiState } from "./workspace-state.ts";

export type ExplorerScope = "working" | "staged";
export type ExplorerView = "session" | "changes" | "activity" | "checks";
type ReviewFilter = "latest" | "all";
type GitFileAction = "stage" | "unstage" | "discard";
type WorkspaceSearchValue =
  | { kind: "message"; message: SessionMessageSummary }
  | { kind: "file"; file: FileChange; scope: ExplorerScope }
  | { kind: "activity"; record: ActivityRecord }
  | { kind: "check"; diagnostic: Diagnostic };
export type GitExplorerResult =
  | { action: "edit"; root: string; path: string; line?: number; column?: number }
  | { action: "quickfix"; root: string; entries: QuickfixEntry[] }
  | undefined;
export interface GitExplorerOptions {
  embedded?: boolean;
  blur?: () => void;
  confirm?: (title: string, message: string) => Promise<boolean>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  workspaceState?: Readonly<WorkspaceUiState>;
  onWorkspaceStateChange?: (patch: Partial<WorkspaceUiState>) => void;
  reservedRows?: number;
  getTerminalRows?: () => number;
  getResizeStatus?: () => string | undefined;
  getDockedWidgets?: () => readonly Component[];
  activity?: ActivityTracker;
  getSessionOverview?: () => Readonly<SessionOverview>;
  isAgentRunning?: () => boolean;
  initialView?: ExplorerView;
  onViewChange?: (view: ExplorerView) => void;
  rerunCheck?: (record: ActivityRecord) => Promise<void>;
}
type DiffState = { kind: "empty" } | { kind: "loading" } | { kind: "error"; message: string } | ({ kind: "ready" } & TextResult);
export const MAX_SEARCH_DOCUMENTS = 10_000;

const searchGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeSegments = (value: string): string[] => [...searchGraphemes.segment(value)].map(({ segment }) => segment);
const removeLastGrapheme = (value: string): string => graphemeSegments(value).slice(0, -1).join("");
const limitGraphemes = (value: string, limit: number): string => graphemeSegments(value).slice(0, limit).join("");

const fit = (text: string, width: number): string => {
  const value = truncateToWidth(text, Math.max(0, width), "…");
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
};

const fitWithSuffix = (text: string, suffix: string, width: number): string => {
  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= width) return truncateToWidth(suffix, width, "");
  const value = truncateToWidth(text, width - suffixWidth, "…");
  return `${value}${" ".repeat(Math.max(0, width - suffixWidth - visibleWidth(value)))}${suffix}`;
};

const stackedListHeight = (bodyHeight: number): number =>
  Math.min(7, Math.max(bodyHeight >= 5 ? 2 : 1, Math.floor((bodyHeight - 1) * 0.42)));

const padRows = (lines: readonly string[], height: number): string[] => {
  const rows = lines.slice(0, Math.max(0, height));
  while (rows.length < height) rows.push("");
  return rows;
};

export function filesForScope(files: readonly FileChange[], scope: ExplorerScope, showUntracked = true): FileChange[] {
  return files.filter((file) => scope === "staged" ? file.staged : file.unstaged || file.conflicted || (showUntracked && file.untracked));
}

export interface DisplayDiffLine {
  text: string;
  color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "accent";
}

export function formatUnifiedDiff(text: string): DisplayDiffLine[] {
  const raw = text ? text.split("\n") : [];
  const firstHunk = raw.findIndex((line) => line.startsWith("@@"));
  const source = firstHunk >= 0
    ? raw.slice(firstHunk)
    : raw.filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ "));
  const result: DisplayDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let untrackedLine = 1;
  for (const rawLine of source) {
    const line = sanitizeTerminalLine(rawLine);
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.push({ text: `         ${line}`, color: "accent" });
      continue;
    }
    const added = line.startsWith("+") && !line.startsWith("+++");
    const removed = line.startsWith("-") && !line.startsWith("---");
    if (oldLine !== undefined && newLine !== undefined) {
      const oldNumber = removed || (!added && !removed) ? String(oldLine).padStart(4) : "    ";
      const newNumber = added || (!added && !removed) ? String(newLine).padStart(4) : "    ";
      result.push({ text: `${oldNumber} ${newNumber} ${line}`, color: added ? "toolDiffAdded" : removed ? "toolDiffRemoved" : "toolDiffContext" });
      if (!added) oldLine++;
      if (!removed) newLine++;
    } else if (added) {
      result.push({ text: `     ${String(untrackedLine++).padStart(4)} ${line}`, color: "toolDiffAdded" });
    } else {
      result.push({ text: line, color: removed ? "toolDiffRemoved" : "toolDiffContext" });
    }
  }
  return result;
}

export class GitExplorer implements Focusable {
  focused = false;
  scope: ExplorerScope = "working";
  focus: "list" | "diff" = "list";
  selected = 0;
  diffScroll = 0;
  private view: ExplorerView = "session";
  private reviewFilter: ReviewFilter = "all";
  private seenRequestId = 0;
  private defaultedRequestId = 0;
  private scopedFileCount = 0;
  private listStart = 0;
  private activitySelected = 0;
  private activityStart = 0;
  private activityDetailScroll = 0;
  private lastActivityDetailCount = 0;
  private checkSelected = 0;
  private checkStart = 0;
  private checkDetailScroll = 0;
  private lastCheckDetailCount = 0;
  private searchActive = false;
  private searchQuery = "";
  private searchSelected = 0;
  private searchStart = 0;
  private searchFiles: { root: string; paths: string[] } | undefined;
  private searchFilesLoading = false;
  private searchLoadGeneration = 0;
  private searchCache: { query: string; gitState: GitStateController["state"]; session: Readonly<SessionOverview>; activityVersion: number; searchFiles?: { root: string; paths: string[] }; maxRecords: number; results: RankedSearchDocument<WorkspaceSearchValue>[] } | undefined;
  private diffDisplayCache: { text: string; lines: DisplayDiffLine[]; hunkLines: Map<number, number> } | undefined;
  private hunkCache: { text: string; hunks: PatchHunk[] } | undefined;
  private hunkSelected = 0;
  private selectedSessionMessageId: string | undefined;
  private lastMouseClick: { view: ExplorerView | "search"; index: number; at: number } | undefined;
  private widgetDockCollapsed = false;
  private widgetDockExpanded = false;
  private widgetDockEffectiveCollapsed = false;
  private widgetDockStartRow = -1;
  private mouseFileTarget = false;
  private fileActionStatus: { text: string; tone: "success" | "warning" | "error" } | undefined;
  private fileActionTimer: ReturnType<typeof setTimeout> | undefined;
  private fileActionRunning = false;
  private rerunRunning = false;
  private files: FileChange[] = [];
  private diff: DiffState = { kind: "empty" };
  private awaitingRepository = false;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private dismissed = false;
  private lastDiffPage = 8;
  private readonly embedded: boolean;
  private readonly blur: () => void;
  private readonly reservedRows: number;
  private readonly getTerminalRows: () => number;
  private readonly getResizeStatus: () => string | undefined;
  private readonly getDockedWidgets: () => readonly Component[];
  private readonly confirm: (title: string, message: string) => Promise<boolean>;
  private readonly input: (title: string, placeholder?: string) => Promise<string | undefined>;
  private readonly selectMenu: (title: string, options: string[]) => Promise<string | undefined>;
  private readonly notify: (message: string, level: "info" | "warning" | "error") => void;
  private readonly onWorkspaceStateChange: (patch: Partial<WorkspaceUiState>) => void;
  private readonly activity: ActivityTracker | undefined;
  private readonly getSessionOverview: () => Readonly<SessionOverview>;
  private readonly isAgentRunning: () => boolean;
  private readonly onViewChange: (view: ExplorerView) => void;
  private readonly rerunCheck: ((record: ActivityRecord) => Promise<void>) | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeActivity: (() => void) | undefined;
  private readonly git: GitStateController;
  private readonly exec: GitExec;
  private readonly getSettings: () => Readonly<CodeuiSettings>;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly close: (result?: GitExplorerResult) => void;

  constructor(
    git: GitStateController,
    exec: GitExec,
    getSettings: () => Readonly<CodeuiSettings>,
    theme: Theme,
    requestRender: () => void,
    close: (result?: GitExplorerResult) => void,
    options: GitExplorerOptions = {},
  ) {
    this.git = git;
    this.exec = exec;
    this.getSettings = getSettings;
    this.theme = theme;
    this.requestRender = requestRender;
    this.close = close;
    this.embedded = options.embedded ?? false;
    this.blur = options.blur ?? (() => this.dismiss());
    this.reservedRows = options.reservedRows ?? 0;
    this.getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows ?? 24);
    this.getResizeStatus = options.getResizeStatus ?? (() => undefined);
    this.getDockedWidgets = options.getDockedWidgets ?? (() => []);
    this.confirm = options.confirm ?? (async () => false);
    this.input = options.input ?? (async () => undefined);
    this.selectMenu = options.select ?? (async () => undefined);
    this.notify = options.notify ?? (() => {});
    this.onWorkspaceStateChange = options.onWorkspaceStateChange ?? (() => {});
    this.activity = options.activity;
    this.getSessionOverview = options.getSessionOverview ?? (() => EMPTY_SESSION_OVERVIEW);
    this.isAgentRunning = options.isAgentRunning ?? (() => false);
    this.onViewChange = options.onViewChange ?? (() => {});
    this.rerunCheck = options.rerunCheck;
    this.view = options.initialView ?? this.view;
    this.scope = options.workspaceState?.scope ?? this.scope;
    this.widgetDockCollapsed = options.workspaceState?.widgetDock === "collapsed";
    this.widgetDockExpanded = options.workspaceState?.widgetDock === "expanded";
    this.unsubscribe = git.onChange(() => this.syncFiles());
    this.unsubscribeActivity = this.activity?.onChange(() => {
      this.activitySelected = Math.min(this.activitySelected, Math.max(0, (this.activity?.records.length ?? 1) - 1));
      this.checkSelected = Math.min(this.checkSelected, Math.max(0, (this.activity?.diagnostics.length ?? 1) - 1));
      this.syncFiles(false);
      this.requestRender();
    });
    this.syncFiles();
  }

  get currentView(): ExplorerView {
    return this.view;
  }

  private setView(view: ExplorerView): void {
    this.view = view;
    this.onViewChange(view);
  }

  handleInput(data: string): void {
    if (this.searchActive) {
      this.handleSearchInput(data);
      return;
    }
    if (data === "/") {
      this.searchActive = true;
      this.searchQuery = "";
      this.searchSelected = 0;
      this.searchStart = 0;
      this.widgetDockStartRow = -1;
      void this.loadSearchFiles();
      this.requestRender();
      return;
    }
    if (data === "q" || matchesKey(data, Key.escape)) {
      if (this.embedded) this.blur();
      else this.dismiss();
      return;
    }
    if (data === "?") {
      void this.showHelp();
      return;
    }
    if (data === "h") {
      this.setView("session");
      this.selectedSessionMessageId = undefined;
      this.awaitingRepository = false;
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (data === "a") {
      this.setView("activity");
      this.awaitingRepository = false;
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (data === "g") {
      if (!this.repo()) {
        this.awaitingRepository = true;
        this.notify("Changes are available when this folder is a Git repository.", "info");
        return;
      }
      this.setView("changes");
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (data === "c") {
      this.setView("checks");
      this.awaitingRepository = false;
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (data === "w" && this.getDockedWidgets().length > 0) {
      this.toggleWidgetDock();
      return;
    }
    if (data === "C") {
      void this.composeCommit();
      return;
    }
    if (data === "Q") {
      this.openWorkspaceQuickfix();
      return;
    }
    if (this.view === "changes" && data === "t") {
      const latest = this.activity?.latestRequest;
      if (!latest?.editedPathCount) {
        this.reviewFilter = "all";
        this.setFileActionStatus("Latest request has no successfully edited files; showing all workspace changes", "warning");
      } else {
        this.reviewFilter = this.reviewFilter === "latest" ? "all" : "latest";
        this.selected = 0;
        this.listStart = 0;
        this.syncFiles();
      }
      return;
    }
    if (this.view === "changes" && data === "s") {
      if (this.focus === "diff") void this.runHunkAction();
      else void this.runFileAction(this.scope === "working" ? "stage" : "unstage");
      return;
    }
    if (this.view === "changes" && this.focus === "diff" && (data === "n" || data === "p")) {
      this.selectHunk(this.hunkSelected + (data === "n" ? 1 : -1));
      return;
    }
    if (this.view === "changes" && data === "x") {
      void this.runFileAction("discard");
      return;
    }
    if (this.view === "changes" && data === "m") {
      void this.openActionMenu();
      return;
    }
    if (this.view === "changes" && matchesKey(data, Key.tab)) {
      this.scope = this.scope === "working" ? "staged" : "working";
      this.persistWorkspaceState();
      this.selected = 0;
      this.listStart = 0;
      this.syncFiles();
      return;
    }
    if (matchesKey(data, Key.enter) && !this.usesUnifiedBody()) {
      this.focus = this.focus === "list" ? "diff" : "list";
      this.requestRender();
      return;
    }
    if (data === "r") {
      if (this.view === "checks") void this.runCheckAgain();
      else void this.git.refresh();
      return;
    }
    if (data === "e") {
      const diagnostic = this.view === "checks" ? this.activity?.diagnostics[this.checkSelected] : undefined;
      const path = this.view === "changes" ? this.files[this.selected]?.path : this.view === "activity" ? this.activity?.records[this.activitySelected]?.path : diagnostic?.path;
      const repo = this.repo();
      if (path && repo) this.dismiss({ action: "edit", root: repo.root, path, ...(diagnostic ? { line: diagnostic.line, column: diagnostic.column } : {}) });
      return;
    }
    const down = data === "j" || matchesKey(data, Key.down);
    const up = data === "k" || matchesKey(data, Key.up);
    const pageDown = matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"));
    const pageUp = matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"));
    if (this.view === "activity") {
      if (pageDown) this.scrollActivityDetail(this.lastDiffPage);
      else if (pageUp) this.scrollActivityDetail(-this.lastDiffPage);
      else if ((down || up) && this.focus === "diff") this.scrollActivityDetail(down ? 1 : -1);
      else if (down || up) this.selectActivity(this.activitySelected + (down ? 1 : -1));
      return;
    }
    if (this.view === "checks") {
      if (pageDown) this.scrollCheckDetail(this.lastDiffPage);
      else if (pageUp) this.scrollCheckDetail(-this.lastDiffPage);
      else if ((down || up) && this.focus === "diff") this.scrollCheckDetail(down ? 1 : -1);
      else if (down || up) this.selectCheck(this.checkSelected + (down ? 1 : -1));
      return;
    }
    if (this.view === "session") return;
    if (pageDown) this.scrollDiff(this.lastDiffPage);
    else if (pageUp) this.scrollDiff(-this.lastDiffPage);
    else if ((down || up) && this.focus === "diff") this.scrollDiff(down ? 1 : -1);
    else if (down || up) this.select(this.selected + (down ? 1 : -1));
  }

  private async loadSearchFiles(): Promise<void> {
    const generation = ++this.searchLoadGeneration;
    const root = this.repo()?.root;
    if (!root) {
      this.searchFiles = undefined;
      this.searchFilesLoading = false;
      return;
    }
    if (this.searchFiles?.root !== root) this.searchFiles = undefined;
    this.searchFilesLoading = true;
    try {
      const files = await this.git.loadFiles(true);
      if (this.disposed || generation !== this.searchLoadGeneration || files?.root !== this.repo()?.root) return;
      this.searchFiles = files;
      this.searchCache = undefined;
    } catch {
      if (this.disposed || generation !== this.searchLoadGeneration) return;
    } finally {
      if (!this.disposed && generation === this.searchLoadGeneration) {
        this.searchFilesLoading = false;
        this.requestRender();
      }
    }
  }

  private searchDocuments(): SearchDocument<WorkspaceSearchValue>[] {
    const repo = this.repo();
    const diagnostics = (this.activity?.diagnostics ?? []).map((diagnostic) => ({
      id: `check:${diagnostic.id}`,
      kind: "check" as const,
      title: `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`,
      detail: diagnostic.message,
      keywords: `${diagnostic.source} ${diagnostic.severity}`,
      value: { kind: "check" as const, diagnostic },
    }));
    const searchFiles = this.searchFiles;
    const indexedPaths = searchFiles && searchFiles.root === repo?.root ? searchFiles.paths : [];
    const filesByPath = new Map<string, FileChange>(indexedPaths.map((path) => [path, {
      path, index: " ", worktree: " ", staged: false, unstaged: false, untracked: false, conflicted: false,
    }]));
    for (const file of repo?.status.files ?? []) filesByPath.set(file.path, file);
    const files = [...filesByPath.values()].map((file) => {
      const scope: ExplorerScope = file.worktree !== " " || file.untracked || file.conflicted ? "working" : "staged";
      const states = [file.staged ? "staged" : "", file.worktree !== " " ? "working" : "", file.untracked ? "untracked" : "", file.conflicted ? "conflict" : ""].filter(Boolean).join(" ");
      return {
        id: `file:${file.path}`,
        kind: "file" as const,
        title: sanitizeTerminalLine(file.path),
        detail: `repository file${states ? ` · ${states}` : ""}${file.oldPath ? ` · renamed from ${sanitizeTerminalLine(file.oldPath)}` : ""}`,
        keywords: `${file.index}${file.worktree} ${file.oldPath ?? ""}`,
        value: { kind: "file" as const, file, scope },
      };
    });
    const activity = (this.activity?.records ?? []).map((record) => ({
      id: `activity:${record.id}`,
      kind: "activity" as const,
      title: record.what,
      detail: `${record.path ?? record.kind} · ${record.result}`,
      keywords: `${record.kind} ${record.status} ${record.why} ${record.how}`,
      value: { kind: "activity" as const, record },
    }));
    const messages = this.getSessionOverview().messages.map((message) => ({
      id: `message:${message.id}`,
      kind: "message" as const,
      title: `${message.role === "user" ? "You" : "Pi"} · ${truncateToWidth(message.text, 80, "…")}`,
      detail: message.text,
      keywords: message.role,
      value: { kind: "message" as const, message },
    }));
    return [...messages, ...diagnostics, ...activity, ...files].slice(0, MAX_SEARCH_DOCUMENTS);
  }

  private searchResults(): RankedSearchDocument<WorkspaceSearchValue>[] {
    const gitState = this.git.state;
    const session = this.getSessionOverview();
    const activityVersion = this.activity?.version ?? 0;
    const maxRecords = this.getSettings().explorer.maxSearchRecords;
    const cached = this.searchCache;
    if (cached && cached.query === this.searchQuery && cached.gitState === gitState && cached.session === session && cached.activityVersion === activityVersion && cached.searchFiles === this.searchFiles && cached.maxRecords === maxRecords) return cached.results;
    const results = fuzzySearch(this.searchDocuments(), this.searchQuery, maxRecords);
    this.searchCache = { query: this.searchQuery, gitState, session, activityVersion, searchFiles: this.searchFiles, maxRecords, results };
    return results;
  }

  private handleSearchInput(data: string): void {
    const results = this.searchResults();
    if (matchesKey(data, Key.escape)) {
      this.searchActive = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.revealSearchResult(results[this.searchSelected]);
      return;
    }
    if (data === "e" || matchesKey(data, Key.ctrl("o"))) {
      this.openSearchResult(results[this.searchSelected]);
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.searchSelected = Math.min(Math.max(0, results.length - 1), this.searchSelected + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.searchSelected = Math.max(0, this.searchSelected - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.searchQuery = "";
      this.searchSelected = 0;
      this.searchStart = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.searchQuery = removeLastGrapheme(this.searchQuery);
      this.searchSelected = 0;
      this.searchStart = 0;
      this.requestRender();
      return;
    }
    const characters = [...data];
    if (characters.length > 0 && characters.every((character) => (character.codePointAt(0) ?? 0) >= 32) && !data.includes("\x1b")) {
      this.searchQuery = limitGraphemes(`${this.searchQuery}${data}`, 160);
      this.searchSelected = 0;
      this.searchStart = 0;
      this.requestRender();
    }
  }

  private revealSearchResult(result: RankedSearchDocument<WorkspaceSearchValue> | undefined): void {
    if (!result) return;
    this.searchActive = false;
    const value = result.value;
    if (value.kind === "message") {
      this.setView("session");
      this.selectedSessionMessageId = value.message.id;
    } else if (value.kind === "file") {
      const repo = this.repo();
      if (repo && !repo.status.files.some((file) => file.path === value.file.path)) {
        this.dismiss({ action: "edit", root: repo.root, path: value.file.path });
        return;
      }
      this.setView("changes");
      this.scope = value.scope;
      this.reviewFilter = "all";
      this.syncFiles(false);
      this.selected = Math.max(0, this.files.findIndex((file) => file.path === value.file.path));
      this.listStart = Math.max(0, this.selected - 1);
      void this.loadDiff();
    } else if (value.kind === "activity") {
      this.setView("activity");
      const index = this.activity?.records.findIndex((record) => record.id === value.record.id) ?? -1;
      this.selectActivity(Math.max(0, index));
    } else {
      this.setView("checks");
      const index = this.activity?.diagnostics.findIndex((diagnostic) => diagnostic.id === value.diagnostic.id) ?? -1;
      this.selectCheck(Math.max(0, index));
    }
    this.focus = "list";
    this.requestRender();
  }

  private openSearchResult(result: RankedSearchDocument<WorkspaceSearchValue> | undefined): void {
    if (!result) return;
    const repo = this.repo();
    if (!repo) return;
    const value = result.value;
    if (value.kind === "file") this.dismiss({ action: "edit", root: repo.root, path: value.file.path });
    else if (value.kind === "activity" && value.record.path) this.dismiss({ action: "edit", root: repo.root, path: value.record.path });
    else if (value.kind === "check") this.dismiss({ action: "edit", root: repo.root, path: value.diagnostic.path, line: value.diagnostic.line, column: value.diagnostic.column });
    else this.setFileActionStatus("Selected activity has no file location", "warning");
  }

  private tabs(): Array<{ view: ExplorerView; label: string; compact: string }> {
    return [
      { view: "session", label: "Session", compact: "Sess" },
      { view: "activity", label: "Activity", compact: "Act" },
      ...(this.repo() ? [{ view: "changes" as const, label: "Changes", compact: "Git" }] : []),
      { view: "checks", label: "Checks", compact: "Chk" },
    ];
  }

  private tabText(width: number, styled: boolean): string {
    const compact = width < 60;
    return this.tabs().map((tab) => {
      const label = compact ? tab.compact : tab.label;
      const text = tab.view === this.view ? `[${compact ? label : label.toUpperCase()}]` : label;
      return styled ? this.theme.fg(tab.view === this.view ? "accent" : "muted", text) : text;
    }).join(compact ? " " : "  ");
  }

  private tabAt(x: number, width: number): ExplorerView | undefined {
    const compact = width < 60;
    const gap = compact ? 1 : 2;
    const tabs = this.tabs().map((tab) => ({ ...tab, text: tab.view === this.view ? `[${compact ? tab.compact : tab.label.toUpperCase()}]` : compact ? tab.compact : tab.label }));
    let cursor = width - tabs.reduce((sum, tab, index) => sum + visibleWidth(tab.text) + (index ? gap : 0), 0);
    for (const [index, tab] of tabs.entries()) {
      if (index) cursor += gap;
      const end = cursor + visibleWidth(tab.text);
      if (x >= cursor && x < end) return tab.view;
      cursor = end;
    }
    return undefined;
  }

  private usesUnifiedBody(): boolean {
    if (this.searchActive || this.view === "session") return this.view === "session" && !this.searchActive;
    if (this.view === "changes") return this.files.length === 0;
    if (this.view === "activity") return (this.activity?.records.length ?? 0) === 0;
    return (this.activity?.diagnostics.length ?? 0) === 0;
  }

  handleMouse(x: number, y: number, width: number, now = Date.now(), allowOpen = true): boolean {
    this.mouseFileTarget = false;
    if (!this.embedded || width < 4 || x < 0 || y < 0) return false;
    const settings = this.getSettings();
    const border = BORDER_PRESETS[settings.appearance.borders];
    const density = DENSITY_PRESETS[settings.appearance.density];
    const inner = Math.max(1, width - visibleWidth(border.vertical));
    const localX = Math.max(0, x - visibleWidth(border.vertical));
    const maxRows = Math.max(5, this.getTerminalRows() - this.reservedRows);
    const gap = density.gap > 0 && maxRows >= 12;
    const nowLines = this.renderNow(inner, maxRows >= 9 ? 2 : maxRows >= 7 ? 1 : 0).length;
    const bodyStart = 1 + nowLines + (gap ? 1 : 0);
    const bodyBudget = Math.max(1, maxRows - 2 - nowLines - (gap ? 2 : 0));
    const dockBudget = settings.explorer.dockWidgets && !this.searchActive
      ? Math.max(0, Math.min(settings.explorer.maxDockRows, Math.floor(maxRows * 0.4), bodyBudget - 3))
      : 0;
    const bodyHeight = Math.max(1, bodyBudget - this.renderWidgetDock(inner, dockBudget).length);

    if (this.widgetDockStartRow >= 0 && y >= this.widgetDockStartRow) {
      if (y === this.widgetDockStartRow) this.toggleWidgetDock();
      return true;
    }
    if (y === 0) {
      this.searchActive = false;
      const target = this.tabAt(localX, inner);
      if (target) {
        this.setView(target);
        this.awaitingRepository = false;
      }
      this.focus = "list";
      this.requestRender();
      return true;
    }
    if (y < bodyStart || y >= bodyStart + bodyHeight || this.usesUnifiedBody()) return true;

    let inList = true;
    let listRow = y - bodyStart;
    let listPanelWidth = inner;
    if (inner >= 76) {
      listPanelWidth = Math.max(24, Math.floor(inner * 0.38));
      inList = localX < listPanelWidth;
    } else {
      const listHeight = stackedListHeight(bodyHeight);
      inList = listRow < listHeight;
      if (!inList) listRow -= listHeight + 1;
    }

    if (!inList) {
      this.focus = "diff";
      if (this.view === "changes" && listRow > 0 && this.diff.kind === "ready") {
        const source = this.displayDiffLines(this.diff.text);
        const sourceLine = this.diffScroll + listRow - 1;
        let selected = -1;
        let hunk = -1;
        for (let index = 0; index <= Math.min(sourceLine, source.length - 1); index++) {
          if (source[index]?.text.trimStart().startsWith("@@")) selected = ++hunk;
        }
        if (selected >= 0) this.hunkSelected = selected;
      }
      this.requestRender();
      return true;
    }
    this.focus = "list";
    if (this.searchActive) {
      if (listRow === 0) return true;
      const results = this.searchResults();
      const index = this.searchStart + listRow - 1;
      const result = results[index];
      if (result) {
        const doubleClick = this.lastMouseClick?.view === "search" && this.lastMouseClick.index === index && now - this.lastMouseClick.at <= 500;
        this.searchSelected = index;
        if (allowOpen && (doubleClick || localX >= listPanelWidth - 4)) {
          this.openSearchResult(result);
          this.lastMouseClick = undefined;
        } else this.lastMouseClick = { view: "search", index, at: now };
        this.requestRender();
      }
      return true;
    }
    if (listRow === 0) {
      if (this.view === "changes") {
        this.scope = localX < 13 ? "working" : "staged";
        this.persistWorkspaceState();
        this.selected = 0;
        this.listStart = 0;
        this.syncFiles();
      } else this.requestRender();
      return true;
    }
    if (this.view === "activity") {
      const index = this.activityStart + listRow - 1;
      const record = this.activity?.records[index];
      if (record) {
        const doubleClick = this.lastMouseClick?.view === "activity" && this.lastMouseClick.index === index && now - this.lastMouseClick.at <= 500;
        if (allowOpen && record.path && (doubleClick || localX >= listPanelWidth - 4)) {
          const repo = this.repo();
          if (repo) this.dismiss({ action: "edit", root: repo.root, path: record.path });
          this.lastMouseClick = undefined;
          return true;
        }
        this.selectActivity(index);
        this.lastMouseClick = { view: "activity", index, at: now };
      }
    } else if (this.view === "checks") {
      const index = this.checkStart + listRow - 1;
      const diagnostic = this.activity?.diagnostics[index];
      if (diagnostic) {
        const doubleClick = this.lastMouseClick?.view === "checks" && this.lastMouseClick.index === index && now - this.lastMouseClick.at <= 500;
        if (allowOpen && (doubleClick || localX >= listPanelWidth - 4)) {
          const repo = this.repo();
          if (repo) this.dismiss({ action: "edit", root: repo.root, path: diagnostic.path, line: diagnostic.line, column: diagnostic.column });
          this.lastMouseClick = undefined;
          return true;
        }
        this.selectCheck(index);
        this.lastMouseClick = { view: "checks", index, at: now };
      }
    } else {
      const index = this.listStart + listRow - 1;
      const file = this.files[index];
      if (file) {
        this.mouseFileTarget = true;
        const doubleClick = this.lastMouseClick?.view === "changes" && this.lastMouseClick.index === index && now - this.lastMouseClick.at <= 500;
        if (allowOpen && (doubleClick || localX >= listPanelWidth - 4)) {
          const repo = this.repo();
          if (repo) this.dismiss({ action: "edit", root: repo.root, path: file.path });
          this.lastMouseClick = undefined;
          return true;
        }
        this.select(index);
        this.lastMouseClick = { view: "changes", index, at: now };
      }
    }
    this.requestRender();
    return true;
  }

  openMouseActions(): void {
    if (this.mouseFileTarget) void this.openActionMenu();
  }

  private async showHelp(): Promise<void> {
    const repo = this.repo();
    const hasRows = !this.usesUnifiedBody();
    const canOpen = Boolean(repo && (
      (this.view === "changes" && this.files[this.selected])
      || (this.view === "activity" && this.activity?.records[this.activitySelected]?.path)
      || (this.view === "checks" && this.activity?.diagnostics[this.checkSelected])
    ));
    const options = [
      "h  Session overview",
      "a  Activity",
      ...(repo ? ["g  Changes"] : []),
      "c  Checks",
      "/  Search workspace and conversation",
      ...(hasRows ? ["j/k or arrows  Move selection", "Enter  Switch list/details"] : []),
      ...(canOpen ? ["e  Open selected location"] : []),
      ...(this.view === "changes" && repo ? ["Tab  Switch Worktree/Staged", this.activity?.latestRequest?.editedPathCount ? "t  Latest request/All workspace" : "t  Latest request unavailable (no successful edits)", "r  Refresh Git state"] : []),
      ...(this.view === "changes" && this.files.length ? ["s  Stage/unstage selection", "m  File actions", "Q  Open quickfix"] : []),
      ...(this.view === "checks" && this.activity?.checks.length ? ["r  Rerun selected check"] : []),
      ...(this.view === "checks" && this.activity?.diagnostics.length ? ["Q  Open quickfix"] : []),
      "?  Show this help",
      "Esc or q  Focus editor",
      ...(this.embedded ? ["[ / ]  Resize workspace", "0  Reset workspace width", "z  Toggle review zoom"] : []),
    ];
    await this.selectMenu("Workspace shortcuts · Esc closes", options);
  }

  private async openActionMenu(): Promise<void> {
    const file = this.files[this.selected];
    if (!file || this.fileActionRunning) return;
    const primary = this.scope === "working" ? (file.conflicted ? "Stage resolved file" : "Stage file") : "Unstage file";
    const options = [primary, "Open in Neovim"];
    options.push("Open workspace quickfix");
    if ((this.repo()?.status.counts.staged ?? 0) > 0) options.push("Commit staged changes…");
    if (this.scope === "working" && !file.untracked && !file.conflicted && !file.oldPath) options.push("Discard working changes…");
    const choice = await this.selectMenu(`Actions · ${sanitizeTerminalLine(file.path)}`, options);
    if (choice === primary) await this.runFileAction(this.scope === "working" ? "stage" : "unstage");
    else if (choice === "Open in Neovim") {
      const repo = this.repo();
      if (repo) this.dismiss({ action: "edit", root: repo.root, path: file.path });
    } else if (choice === "Open workspace quickfix") this.openWorkspaceQuickfix();
    else if (choice === "Commit staged changes…") await this.composeCommit();
    else if (choice === "Discard working changes…") await this.runFileAction("discard");
  }

  private selectedCheck(): ActivityRecord | undefined {
    const diagnostic = this.activity?.diagnostics[this.checkSelected];
    return diagnostic
      ? this.activity?.records.find((record) => record.id === diagnostic.checkId)
      : this.activity?.checks[0];
  }

  private async runCheckAgain(): Promise<void> {
    if (this.rerunRunning || this.activity?.isRerunning) {
      this.notify("A check rerun is already running.", "warning");
      return;
    }
    const record = this.selectedCheck();
    if (!record?.rerun) {
      this.notify("The selected check has no stored bash command to rerun.", "warning");
      return;
    }
    if (!this.rerunCheck) {
      this.notify("Check rerun is unavailable in this installation.", "warning");
      return;
    }
    if (record.status === "running") {
      this.notify("The selected check is already running.", "warning");
      return;
    }
    this.rerunRunning = true;
    try {
      const timeout = Number.isFinite(record.rerun.timeout) && record.rerun.timeout! > 0 ? `${record.rerun.timeout}s` : "default";
      const approved = await this.confirm(
        "Rerun this check?",
        `Command:\n${sanitizeTerminalLine(record.rerun.command)}\n\nWorking directory:\n${sanitizeTerminalLine(record.rerun.cwd)}\n\nTimeout: ${timeout}`,
      );
      if (approved) await this.rerunCheck(record);
    } finally {
      this.rerunRunning = false;
    }
  }

  private async runFileAction(action: GitFileAction): Promise<void> {
    const repo = this.repo();
    const file = this.files[this.selected];
    if (!repo || !file || this.fileActionRunning) return;
    if (this.activity?.isEditing(file.path)) {
      this.setFileActionStatus("Wait for the assistant to finish editing this file", "warning");
      return;
    }
    if (action === "unstage" && (this.scope !== "staged" || file.conflicted)) {
      this.setFileActionStatus(file.conflicted ? "Resolve the conflict before unstaging" : "Switch to Staged to unstage", "warning");
      return;
    }
    if (action === "discard") {
      if (this.isAgentRunning()) {
        this.setFileActionStatus("Wait for the assistant to finish before discarding changes", "warning");
        return;
      }
      if (this.scope !== "working") {
        this.setFileActionStatus("Discard is only available in Worktree", "warning");
        return;
      }
      if (file.untracked) {
        this.setFileActionStatus("Untracked deletion is intentionally disabled", "warning");
        return;
      }
      if (file.conflicted) {
        this.setFileActionStatus("Conflict discard is intentionally disabled", "warning");
        return;
      }
      if (file.oldPath) {
        this.setFileActionStatus("Rename discard is intentionally disabled", "warning");
        return;
      }
      const approved = await this.confirm("Discard working changes?", `${file.path}\n\nThis restores the tracked file to its index version and cannot be undone.`);
      if (!approved) return;
      if (this.isAgentRunning()) {
        this.setFileActionStatus("Wait for the assistant to finish before discarding changes", "warning");
        return;
      }
    }

    const verb = action === "stage" ? "Staging" : action === "unstage" ? "Unstaging" : "Discarding changes in";
    this.fileActionRunning = true;
    this.setFileActionStatus(`${verb} ${file.path}…`, "warning", 0);
    try {
      if (action === "stage") await stageFile(this.exec, repo.root, file.path, { relatedPath: file.oldPath });
      else if (action === "unstage") await unstageFile(this.exec, repo.root, file.path, { unbornAdded: repo.status.branch.unborn && file.index === "A", relatedPath: file.oldPath });
      else await discardTrackedFile(this.exec, repo.root, file.path);
      await this.git.refresh();
      this.syncFiles();
      const done = action === "stage" ? "Staged" : action === "unstage" ? "Unstaged" : "Discarded changes in";
      this.setFileActionStatus(`${done} ${file.path}`, "success");
      this.notify(`${done} ${file.path}`, "info");
    } catch (error) {
      const message = sanitizeTerminalLine((error as Error).message);
      this.setFileActionStatus(`${action} failed · ${message}`, "error", 5_000);
      this.notify(`Git ${action} failed: ${message}`, "error");
    } finally {
      this.fileActionRunning = false;
    }
  }

  private workspaceQuickfixEntries(): QuickfixEntry[] {
    const repo = this.repo();
    if (!repo) return [];
    const entries: QuickfixEntry[] = (this.activity?.diagnostics ?? []).map((diagnostic) => ({
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
      message: `[${diagnostic.source.toUpperCase()}] ${diagnostic.message}`,
      severity: diagnostic.severity,
    }));
    const showUntracked = this.getSettings().git.showUntracked;
    for (const file of repo.status.files) {
      if (!showUntracked && file.untracked) continue;
      const states = [file.conflicted ? "conflict" : "", file.staged ? "staged" : "", file.unstaged ? "working" : "", file.untracked ? "untracked" : ""].filter(Boolean).join(" · ");
      entries.push({
        path: file.path,
        line: 1,
        column: 1,
        message: `[Git ${file.index}${file.worktree}] ${states || "changed"}${file.oldPath ? ` · from ${file.oldPath}` : ""}`,
        severity: file.conflicted ? "error" : file.untracked ? "warning" : "info",
      });
    }
    const seen = new Set<string>();
    return entries.filter((entry) => {
      const key = `${entry.path}:${entry.line}:${entry.column ?? 1}:${entry.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private openWorkspaceQuickfix(): void {
    const repo = this.repo();
    if (!repo) return;
    const entries = this.workspaceQuickfixEntries();
    if (!entries.length) {
      this.setFileActionStatus("No changed files or check locations for quickfix", "warning");
      return;
    }
    this.dismiss({ action: "quickfix", root: repo.root, entries });
  }

  private displayDiffLines(text: string): DisplayDiffLine[] {
    if (this.diffDisplayCache?.text === text) return this.diffDisplayCache.lines;
    const lines = formatUnifiedDiff(text);
    const hunkLines = new Map<number, number>();
    let hunkIndex = 0;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]?.text.trimStart().startsWith("@@")) hunkLines.set(index, hunkIndex++);
    }
    this.diffDisplayCache = { text, lines, hunkLines };
    return lines;
  }

  private currentHunks(): PatchHunk[] {
    const file = this.files[this.selected];
    if (!file || this.diff.kind !== "ready" || this.diff.binary || this.diff.truncated || file.untracked || file.conflicted || file.oldPath) return [];
    if (this.hunkCache?.text === this.diff.text) return this.hunkCache.hunks;
    const hunks = parsePatchHunks(this.diff.text);
    this.hunkCache = { text: this.diff.text, hunks };
    return hunks;
  }

  private selectHunk(index: number): void {
    const hunks = this.currentHunks();
    if (!hunks.length) {
      this.setFileActionStatus("No safe patch hunks available", "warning");
      return;
    }
    this.hunkSelected = Math.max(0, Math.min(index, hunks.length - 1));
    const positions = this.displayDiffLines(this.diff.kind === "ready" ? this.diff.text : "")
      .map((line, lineIndex) => line.text.trimStart().startsWith("@@") ? lineIndex : -1)
      .filter((lineIndex) => lineIndex >= 0);
    this.diffScroll = positions[this.hunkSelected] ?? this.diffScroll;
    this.requestRender();
  }

  private async runHunkAction(): Promise<void> {
    const repo = this.repo();
    const file = this.files[this.selected];
    const hunks = this.currentHunks();
    if (!repo || !file || this.fileActionRunning) return;
    if (this.getSettings().git.ignoreWhitespace) {
      this.setFileActionStatus("Disable ignoreWhitespace before patch staging", "warning");
      return;
    }
    if (!hunks.length) {
      this.setFileActionStatus("Hunk actions are unavailable for binary, truncated, untracked, renamed, or conflicted diffs", "warning", 5_000);
      return;
    }
    if (this.activity?.isEditing(file.path)) {
      this.setFileActionStatus("Wait for the assistant to finish editing this file", "warning");
      return;
    }
    this.hunkSelected = Math.min(this.hunkSelected, hunks.length - 1);
    const hunk = hunks[this.hunkSelected]!;
    const scope: DiffScope = this.scope === "staged" ? "cached" : "working";
    const verb = scope === "working" ? "Staging" : "Unstaging";
    this.fileActionRunning = true;
    this.setFileActionStatus(`${verb} hunk ${this.hunkSelected + 1}/${hunks.length}…`, "warning", 0);
    try {
      await applyPatchHunk(this.exec, repo.root, hunk.patch, scope);
      await this.git.refresh();
      this.syncFiles(false);
      const index = this.files.findIndex((candidate) => candidate.path === file.path);
      if (index >= 0) this.selected = index;
      await this.loadDiff();
      this.hunkSelected = 0;
      const done = scope === "working" ? "Staged" : "Unstaged";
      this.setFileActionStatus(`${done} selected hunk in ${file.path}`, "success");
      this.notify(`${done} selected hunk in ${file.path}`, "info");
    } catch (error) {
      const message = sanitizeTerminalLine((error as Error).message);
      this.setFileActionStatus(`Hunk action failed · ${message}`, "error", 5_000);
      this.notify(`Git hunk action failed: ${message}`, "error");
    } finally {
      this.fileActionRunning = false;
    }
  }

  private async composeCommit(): Promise<void> {
    const repo = this.repo();
    if (!repo || this.fileActionRunning) return;
    if (repo.status.counts.staged <= 0) {
      this.setFileActionStatus("Stage at least one file or hunk before committing", "warning");
      return;
    }
    if (repo.status.counts.conflicted > 0) {
      this.setFileActionStatus("Resolve all conflicts before committing", "error");
      return;
    }
    if ((this.activity?.records ?? []).some((record) => record.status === "running")) {
      this.setFileActionStatus("Wait for the active tool action before committing", "warning");
      return;
    }
    const message = await this.input("Commit staged changes", "feat: describe the staged change");
    if (message === undefined) return;
    let safeMessage: string;
    try {
      safeMessage = validateCommitMessage(message);
    } catch (error) {
      this.setFileActionStatus(sanitizeTerminalLine((error as Error).message), "warning");
      return;
    }
    const approved = await this.confirm("Create commit?", `Branch: ${repo.status.branch.name ?? "detached"}\nStaged files: ${repo.status.counts.staged}\n\n${safeMessage}\n\nGit hooks will run normally.`);
    if (!approved) return;
    this.fileActionRunning = true;
    this.setFileActionStatus("Creating commit…", "warning", 0);
    try {
      await commitStaged(this.exec, repo.root, safeMessage, { timeout: 120_000 });
      await this.git.refresh();
      this.syncFiles();
      this.setFileActionStatus(`Committed · ${safeMessage}`, "success", 4_000);
      this.notify(`Committed: ${safeMessage}`, "info");
    } catch (error) {
      const detail = sanitizeTerminalLine((error as Error).message);
      this.setFileActionStatus(`Commit failed · ${detail}`, "error", 6_000);
      this.notify(`Git commit failed: ${detail}`, "error");
    } finally {
      this.fileActionRunning = false;
    }
  }

  private setFileActionStatus(text: string, tone: "success" | "warning" | "error", timeout = 2_500): void {
    if (this.fileActionTimer) clearTimeout(this.fileActionTimer);
    this.fileActionStatus = { text, tone };
    this.requestRender();
    if (timeout <= 0) return;
    this.fileActionTimer = setTimeout(() => {
      this.fileActionStatus = undefined;
      this.fileActionTimer = undefined;
      this.requestRender();
    }, timeout);
    this.fileActionTimer.unref?.();
  }

  private renderHints(width: number): string {
    const repo = this.repo();
    const records = this.activity?.records ?? [];
    const diagnostics = this.activity?.diagnostics ?? [];
    const navigation = [
      ...(this.view === "session" ? [] : ["h Session"]),
      ...(this.view === "activity" ? [] : ["a Activity"]),
      ...(!repo || this.view === "changes" ? [] : ["g Changes"]),
      ...(this.view === "checks" ? [] : ["c Checks"]),
    ];
    const actions: string[] = [];
    const compactActions: string[] = [];
    if (this.view === "changes" && this.files.length > 0) {
      actions.push("Tab Scope", "t Review", "j/k Move");
      compactActions.push("Tab Scope", "t Review", "j/k Move");
      if (this.focus === "diff" && this.currentHunks().length > 0) {
        actions.push("n/p Hunk", `s ${this.scope === "working" ? "Stage" : "Unstage"} hunk`);
        compactActions.push("n/p Hunk", "s Apply");
      } else {
        actions.push(`s ${this.scope === "working" ? "Stage" : "Unstage"}`);
        compactActions.push(`s ${this.scope === "working" ? "Stage" : "Unstage"}`);
        const file = this.files[this.selected];
        if (this.scope === "working" && file && !file.untracked && !file.conflicted && !file.oldPath) actions.push("x Discard");
      }
      actions.push("e Open");
      compactActions.push("e Open");
      const canCommit = (repo?.status.counts.staged ?? 0) > 0
        && (repo?.status.counts.conflicted ?? 0) === 0
        && !records.some((record) => record.status === "running");
      if (canCommit) {
        actions.push("C Commit");
        compactActions.push("C Commit");
      }
      actions.push("Q Quickfix");
      compactActions.push("Q QF");
    } else if (this.view === "activity" && records.length > 0) {
      actions.push("j/k Move");
      compactActions.push("j/k Move");
      if (repo && records[this.activitySelected]?.path) {
        actions.push("e Open");
        compactActions.push("e Open");
      }
    } else if (this.view === "checks" && (this.activity?.checks.length ?? 0) > 0) {
      if (diagnostics.length > 0) {
        actions.push("j/k Move");
        compactActions.push("j/k Move");
        if (repo) {
          actions.push("e Open", "Q Quickfix");
          compactActions.push("e Open", "Q QF");
        }
      }
      if (this.selectedCheck()?.rerun) {
        actions.push("r Rerun");
        compactActions.push("r Rerun");
      }
    }
    if (this.view === "changes" && repo) {
      if (this.files.length === 0) {
        actions.push("Tab Scope", "t Review");
        compactActions.push("Tab Scope", "t Review");
      }
      actions.push("r Refresh");
      compactActions.push("r Refresh");
    }
    if (this.embedded) {
      actions.push("z Zoom");
      compactActions.push("z Zoom");
    }
    const full = [...navigation, ...actions, "/ Search", "? Help", "Esc Editor"].join(" · ");
    if (visibleWidth(full) <= width) return this.theme.fg("muted", full);
    const compact = this.theme.fg("muted", [...compactActions, "/ Find"].join(" · "));
    return fitWithSuffix(compact, this.theme.fg("muted", " · ? · Esc"), width);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.theme.fg("accent", "π"), width, "")];
    const settings = this.getSettings();
    const border = BORDER_PRESETS[settings.appearance.borders];
    const density = DENSITY_PRESETS[settings.appearance.density];
    const edge = visibleWidth(border.vertical);
    const inner = Math.max(1, width - edge * (this.embedded ? 1 : 2));
    const terminalRows = this.getTerminalRows();
    const maxRows = this.embedded ? Math.max(5, terminalRows - this.reservedRows) : Math.max(5, Math.floor(terminalRows * 0.85));
    const gap = density.gap > 0 && maxRows >= 12;
    const content: string[] = [];
    const { icons } = resolveGlyphs(settings);
    const titleTone = this.focused || this.searchActive ? "accent" : "muted";
    const title = this.theme.bold(this.theme.fg(titleTone, this.searchActive ? "⌕  WORKSPACE SEARCH" : `${icons.brand}  WORKSPACE`));
    const tabs = this.tabText(inner, true);
    const resizeStatus = this.getResizeStatus();
    const status = resizeStatus && inner >= 46 ? this.theme.fg("warning", `↔ ${resizeStatus}`) : "";
    const trailing = status ? `${status}  ${tabs}` : tabs;
    const titleWidth = inner - visibleWidth(trailing) - 1;
    const compactTitle = inner < 52 ? "" : titleWidth >= 10 ? truncateToWidth(title, titleWidth, "…") : titleWidth >= visibleWidth(icons.brand) ? this.theme.fg(titleTone, icons.brand) : "";
    content.push(`${compactTitle}${" ".repeat(Math.max(compactTitle ? 1 : 0, inner - visibleWidth(compactTitle) - visibleWidth(trailing)))}${trailing}`);
    const now = this.renderNow(inner, maxRows >= 9 ? 2 : maxRows >= 7 ? 1 : 0);
    content.push(...now);
    if (gap) content.push("");
    const bodyBudget = Math.max(1, maxRows - (this.embedded ? 2 : 4) - now.length - (gap ? 2 : 0));
    const dockBudget = this.embedded && settings.explorer.dockWidgets && !this.searchActive
      ? Math.max(0, Math.min(settings.explorer.maxDockRows, Math.floor(maxRows * 0.4), bodyBudget - 3))
      : 0;
    const widgetDock = this.renderWidgetDock(inner, dockBudget);
    const bodyHeight = Math.max(1, bodyBudget - widgetDock.length);

    const renderList = (panelWidth: number, height: number) => this.searchActive ? this.renderSearchList(panelWidth, height) : this.view === "changes" ? this.renderList(panelWidth, height) : this.view === "activity" ? this.renderActivityList(panelWidth, height) : this.view === "checks" ? this.renderCheckList(panelWidth, height) : this.renderSessionOverview(panelWidth, height);
    const renderDetail = (panelWidth: number, height: number) => this.searchActive ? this.renderSearchDetail(panelWidth, height) : this.view === "changes" ? this.renderDiff(panelWidth, height) : this.view === "activity" ? this.renderActivityDetail(panelWidth, height) : this.view === "checks" ? this.renderCheckDetail(panelWidth, height) : [];
    if (this.usesUnifiedBody()) {
      content.push(...padRows(this.renderUnifiedBody(inner, bodyHeight), bodyHeight));
    } else if (inner >= 76) {
      const listWidth = Math.max(24, Math.floor(inner * 0.38));
      const detailWidth = inner - listWidth - 3;
      const list = renderList(listWidth, bodyHeight);
      const detail = renderDetail(detailWidth, bodyHeight);
      for (let i = 0; i < bodyHeight; i++) content.push(`${fit(list[i] ?? "", listWidth)} ${this.theme.fg("borderMuted", border.vertical || "|")} ${fit(detail[i] ?? "", detailWidth)}`);
    } else if (bodyHeight < 3) {
      content.push(...renderList(inner, 1));
      if (bodyHeight > 1) content.push(...renderDetail(inner, 1));
    } else {
      const listHeight = stackedListHeight(bodyHeight);
      const detailHeight = bodyHeight - listHeight - 1;
      content.push(...padRows(renderList(inner, listHeight), listHeight));
      content.push(this.theme.fg("borderMuted", border.horizontal.repeat(inner)));
      content.push(...padRows(renderDetail(inner, detailHeight), detailHeight));
    }
    if (gap) content.push("");
    this.widgetDockStartRow = widgetDock.length > 0 ? content.length : -1;
    content.push(...widgetDock);
    const searchValue = this.searchActive ? this.searchResults()[this.searchSelected]?.value : undefined;
    const canOpenSearch = Boolean(this.repo() && searchValue && (
      searchValue.kind === "file"
      || searchValue.kind === "check"
      || (searchValue.kind === "activity" && searchValue.record.path)
    ));
    const searchHints = this.theme.fg("muted", `Type to filter · ↑/↓ Select · Enter Reveal${canOpenSearch ? " · Ctrl+O Open" : ""}`);
    content.push(this.searchActive ? fitWithSuffix(searchHints, this.theme.fg("muted", " · Esc Close"), inner) : this.renderHints(inner));

    const borderToken = this.focused ? "borderAccent" : "border";
    if (this.embedded) {
      const handleRow = Math.floor(content.length / 2);
      return content.map((line, index) => this.theme.fg(index === handleRow ? "borderAccent" : borderToken, index === handleRow ? "⋮" : border.vertical) + fit(line, inner));
    }
    const framed = content.map((line) => this.theme.fg(borderToken, border.vertical) + fit(line, inner) + this.theme.fg(borderToken, border.vertical));
    const horizontal = (left: string, right: string) => this.theme.fg(borderToken, truncateToWidth(`${left}${border.horizontal.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`, width, ""));
    return [horizontal(border.topLeft, border.topRight), ...framed, horizontal(border.bottomLeft, border.bottomRight)];
  }

  private persistWorkspaceState(): void {
    const widgetDock = this.widgetDockCollapsed ? "collapsed" : this.widgetDockExpanded ? "expanded" : "auto";
    this.onWorkspaceStateChange({ scope: this.scope, widgetDock });
  }

  private toggleWidgetDock(): void {
    if (this.widgetDockEffectiveCollapsed) {
      this.widgetDockCollapsed = false;
      this.widgetDockExpanded = true;
    } else {
      this.widgetDockCollapsed = true;
      this.widgetDockExpanded = false;
    }
    this.persistWorkspaceState();
    this.requestRender();
  }

  private renderWidgetDock(width: number, height: number): string[] {
    if (height <= 0) return [];
    const widgetLines = this.getDockedWidgets().flatMap((widget) => {
      try {
        return widget.render(width);
      } catch (error) {
        return [this.theme.fg("error", `Widget error: ${sanitizeTerminalLine((error as Error).message)}`)];
      }
    });
    while (widgetLines.length > 0 && visibleWidth(widgetLines[0] ?? "") === 0) widgetLines.shift();
    while (widgetLines.length > 0 && visibleWidth(widgetLines.at(-1) ?? "") === 0) widgetLines.pop();
    if (widgetLines.length === 0) return [];

    const plain = widgetLines.map((line) => stripTerminalSequences(line).trim());
    const todoIndex = plain.findIndex((line) => /Todos\s*\((\d+)\s*\/\s*(\d+)\)/i.test(line));
    const progress = todoIndex >= 0 ? /Todos\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(plain[todoIndex] ?? "") : null;
    const completed = Number(progress?.[1] ?? 0);
    const total = Number(progress?.[2] ?? 0);
    const todoBody = todoIndex >= 0 ? plain.slice(todoIndex + 1).filter(Boolean) : [];
    const completedOnly = total > 0 && completed >= total && todoBody.length > 0 && todoBody.every((line) => /[✓✔]/.test(line) || /^…\s+\d+/.test(line));
    const autoCompact = completedOnly && !this.widgetDockExpanded;
    const collapsed = this.widgetDockCollapsed || autoCompact || height === 1;
    this.widgetDockEffectiveCollapsed = collapsed;

    const state = autoCompact
      ? this.theme.fg("success", `Todos ${completed}/${total} complete`)
      : collapsed
        ? this.theme.fg("dim", `${widgetLines.length} lines`)
        : "";
    const heading = `${this.theme.fg(autoCompact ? "success" : "accent", autoCompact ? "✓" : collapsed ? "▸" : "▾")} ${this.theme.fg("muted", "EXTENSIONS")}${state ? `  ${state}` : ""}${this.theme.fg("dim", `  ·  w ${collapsed ? "expand" : "collapse"}`)}`;
    if (collapsed) return [truncateToWidth(heading, width, "…")];

    const visibleRows = height - 1;
    const lines = widgetLines.slice(0, visibleRows).map((line) => truncateToWidth(line, width, "…"));
    if (widgetLines.length > visibleRows && lines.length > 0) lines[lines.length - 1] = this.theme.fg("dim", `… +${widgetLines.length - visibleRows + 1} hidden widget lines`);
    return [truncateToWidth(heading, width, "…"), ...lines];
  }

  invalidate(): void {
    for (const widget of this.getDockedWidgets()) widget.invalidate();
    this.requestRender();
  }

  settingsChanged(): void {
    this.syncFiles();
  }

  dismiss(result?: GitExplorerResult): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.dispose();
    this.close(result);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    this.abort = undefined;
    this.generation++;
    this.searchLoadGeneration++;
    if (this.fileActionTimer) clearTimeout(this.fileActionTimer);
    this.fileActionTimer = undefined;
    this.unsubscribe();
    this.unsubscribeActivity?.();
  }

  private repo() {
    const state = this.git.state;
    if (state.kind === "repo") return state;
    return state.kind === "loading" && state.previous?.kind === "repo" ? state.previous : undefined;
  }

  private syncFiles(loadDiff = true): void {
    if (this.disposed) return;
    const selectedPath = this.files[this.selected]?.path;
    const repo = this.repo();
    const confirmedNoRepo = this.git.state.kind === "none" || (this.git.state.kind === "loading" && this.git.state.previous?.kind === "none");
    if (!repo && confirmedNoRepo && this.view === "changes") {
      this.setView("session");
      this.focus = "list";
      this.awaitingRepository = true;
    } else if (repo && this.awaitingRepository) {
      this.setView("changes");
      this.focus = "list";
      this.awaitingRepository = false;
    }
    const scoped = repo ? filesForScope(repo.status.files, this.scope, this.getSettings().git.showUntracked) : [];
    this.scopedFileCount = scoped.length;
    const latest = this.activity?.latestRequest;
    if (latest && latest.id !== this.seenRequestId) {
      this.seenRequestId = latest.id;
      this.reviewFilter = "all";
    }
    if (latest?.editedPathCount && latest.id !== this.defaultedRequestId) {
      this.defaultedRequestId = latest.id;
      this.reviewFilter = "latest";
    }
    const latestPaths = new Set(latest?.editedPaths ?? []);
    const filtered = this.reviewFilter === "latest" && latestPaths.size ? scoped.filter((file) => latestPaths.has(file.path)) : scoped;
    this.files = this.activity?.orderFiles(filtered) ?? filtered;
    const preserved = selectedPath ? this.files.findIndex((file) => file.path === selectedPath) : -1;
    this.selected = preserved >= 0 ? preserved : Math.max(0, Math.min(this.selected, Math.max(0, this.files.length - 1)));
    this.listStart = Math.min(this.listStart, this.selected);
    if (loadDiff) void this.loadDiff();
    this.requestRender();
  }

  private select(index: number): void {
    const next = Math.max(0, Math.min(index, Math.max(0, this.files.length - 1)));
    if (next === this.selected) return;
    this.selected = next;
    this.diffScroll = 0;
    this.hunkSelected = 0;
    void this.loadDiff();
    this.requestRender();
  }

  private async loadDiff(): Promise<void> {
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    const repo = this.repo();
    const file = this.files[this.selected];
    if (!repo || !file) {
      this.diff = { kind: "empty" };
      this.requestRender();
      return;
    }
    this.diff = { kind: "loading" };
    this.requestRender();
    try {
      const settings = this.getSettings();
      let result: TextResult;
      if (file.untracked && this.scope === "working") {
        const preview = await previewUntracked(repo.root, file.path);
        const sourceLines = preview.text.split("\n");
        const lines = sourceLines.slice(0, settings.explorer.maxDiffLines);
        result = {
          text: lines.map((line) => `+${line}`).join("\n"),
          binary: preview.binary,
          truncated: preview.truncated || sourceLines.length > lines.length,
          truncatedBy: sourceLines.length > lines.length ? ["lines"] : preview.truncated ? ["bytes"] : [],
          originalBytes: preview.bytesRead,
          originalLines: sourceLines.length,
        };
      } else {
        const scope: DiffScope = this.scope === "staged" ? "cached" : "working";
        result = await getDiff(this.exec, repo.root, file.path, scope, {
          signal: abort.signal,
          context: settings.explorer.diffContext,
          maxLines: settings.explorer.maxDiffLines,
          ignoreWhitespace: settings.git.ignoreWhitespace,
        });
      }
      if (!this.disposed && !abort.signal.aborted && generation === this.generation) {
        this.abort = undefined;
        this.diff = { kind: "ready", ...result };
        this.diffScroll = 0;
        this.hunkSelected = 0;
        this.requestRender();
      }
    } catch (error) {
      if (!this.disposed && !abort.signal.aborted && generation === this.generation) {
        this.abort = undefined;
        this.diff = { kind: "error", message: (error as Error).message };
        this.requestRender();
      }
    }
  }

  private renderUnifiedBody(width: number, height: number): string[] {
    if (this.view === "session") return this.renderSessionOverview(width, height);
    if (this.view === "changes") return this.renderWorkspaceOverview(width, height);
    if (this.view === "activity") return this.renderActivityOverview(width, height);
    return this.renderChecksOverview(width, height);
  }

  private renderSessionOverview(width: number, height: number): string[] {
    const session = this.getSessionOverview();
    const records = this.activity?.records ?? [];
    const running = records.find((record) => record.status === "running");
    const active = this.isAgentRunning();
    const statusTone = running ? "warning" : active ? "accent" : "success";
    const statusIcon = running || active ? "●" : "○";
    const statusText = running?.what ?? (active ? "Responding" : "Ready for your next message");
    const lines = [
      this.theme.bold(this.theme.fg("accent", "SESSION")),
      `${this.theme.fg(statusTone, statusIcon)} ${this.theme.fg("text", statusText)}`,
      "",
      this.theme.bold(this.theme.fg("text", session.title)),
    ];
    if (session.userTurns > 0 || records.length > 0 || session.images > 0) {
      const counts = [
        `${session.userTurns} turn${session.userTurns === 1 ? "" : "s"}`,
        session.images ? `${session.images} image${session.images === 1 ? "" : "s"}` : "",
        records.length ? `${records.length} action${records.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join("  ·  ");
      lines.push(this.theme.fg("muted", counts));
    } else {
      lines.push(this.theme.fg("muted", "Start a conversation or describe a task."));
    }

    const selectedMessage = session.messages.find((message) => message.id === this.selectedSessionMessageId);
    if (selectedMessage) {
      const time = selectedMessage.timestamp ? `  ·  ${relativeTime(selectedMessage.timestamp)}` : "";
      lines.push("", this.theme.bold(this.theme.fg("muted", `MESSAGE · ${selectedMessage.role === "user" ? "YOU" : "PI"}${time}`)));
      lines.push(...wrapTextWithAnsi(this.theme.fg("text", selectedMessage.text), Math.max(1, width - 2)).slice(0, 4).map((line) => `  ${line}`));
    }

    const paths = [...new Set(records.map((record) => record.path).filter((path): path is string => Boolean(path)))].slice(0, 4);
    lines.push("", this.theme.bold(this.theme.fg("muted", "RESOURCES")));
    if (session.images > 0) lines.push(`${this.theme.fg("accent", "◆")} ${session.images} attached image${session.images === 1 ? "" : "s"}`);
    lines.push(...paths.map((path) => `${this.theme.fg("accent", "·")} ${this.theme.fg("text", path)}`));
    if (session.images === 0 && paths.length === 0) lines.push(this.theme.fg("muted", "Files, images, and tool activity appear here when used."));
    return lines.map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private renderActivityOverview(width: number, height: number): string[] {
    return [
      this.theme.bold(this.theme.fg("accent", "ACTIVITY")),
      `${this.theme.fg("muted", "○")} ${this.theme.fg("text", "No tool activity yet")}`,
      "",
      this.theme.fg("muted", "The conversation stays on the left."),
      this.theme.fg("muted", "Research, file, command, and export actions appear here live."),
    ].map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private renderChecksOverview(width: number, height: number): string[] {
    const checks = this.activity?.checks ?? [];
    const running = checks.find((record) => record.status === "running");
    const failed = checks.find((record) => record.status === "error");
    const lines = [this.theme.bold(this.theme.fg("accent", "CHECKS"))];
    if (running) lines.push(`${this.theme.fg("warning", "● RUNNING")}  ${this.theme.fg("text", running.what)}`);
    else if (failed) lines.push(`${this.theme.fg("error", "✕ FAILED")}  ${this.theme.fg("text", "No file locations captured")}`);
    else if (checks.length) lines.push(`${this.theme.fg("success", "✓ CLEAR")}  ${this.theme.fg("text", "No problems from recent checks")}`);
    else lines.push(`${this.theme.fg("muted", "○ NOT RUN")}  ${this.theme.fg("text", "No checks run in this session")}`);
    lines.push("", this.theme.fg("muted", checks.length ? "Test, lint, typecheck, and build results are summarized here." : "Run your normal test, lint, typecheck, or build command to populate this view."));
    return lines.map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private renderNow(width: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];
    if (this.searchActive) {
      const count = this.searchResults().length;
      const repo = this.repo();
      const cursor = this.focused ? CURSOR_MARKER : "";
      const query = this.searchQuery
        ? `${this.searchQuery}${cursor}`
        : `${cursor}${this.theme.fg("muted", `type a message, ${repo ? "path, " : ""}action, or error…`)}`;
      return [truncateToWidth(`${this.theme.fg("accent", "/")} ${query}${this.theme.fg("muted", `  ·  ${count} results  ·  m: messages${repo ? "  f: files" : ""}  a: activity  c: checks`)}`, width, "…")];
    }
    if (this.fileActionStatus) {
      const icon = this.fileActionStatus.tone === "success" ? "✓" : this.fileActionStatus.tone === "error" ? "✕" : "●";
      return [truncateToWidth(`${this.theme.fg("dim", "NOW  ")}${this.theme.fg(this.fileActionStatus.tone, icon)} ${this.theme.fg("text", this.fileActionStatus.text)}`, width, "…")];
    }
    const record = this.activity?.records.find((item) => item.status === "running");
    if (!record) {
      const latest = this.activity?.latestRequest;
      if (!latest || latest.active || (this.view !== "session" && this.view !== "changes")) return [];
      const action = this.view === "session" ? this.repo() ? "g Changes" : "no Git review available" : latest.editedPathCount ? `t ${this.reviewFilter === "latest" ? "All workspace" : "Latest request"}` : "t unavailable · no successful edits";
      const tone = latest.failureCount ? "error" : "success";
      const summary = `${latest.editedPathCount} edited · ${latest.checkCount} ${latest.checkCount === 1 ? "check" : "checks"} · ${latest.failureCount} failed`;
      return [truncateToWidth(`${this.theme.fg("dim", "REVIEW  ")}${this.theme.fg(tone, latest.failureCount ? "✕" : "✓")} ${this.theme.fg("text", summary)}${this.theme.fg("muted", `  ·  ${action}`)}`, width, "…")];
    }
    const status = this.theme.fg("warning", "●");
    const timing = relativeTime(record.startedAt);
    const lines = [`${this.theme.fg("dim", "NOW  ")}${status} ${this.theme.fg("text", record.what)}${timing ? this.theme.fg("dim", `  ${timing}`) : ""}`];
    if (maxLines > 1) lines.push(`${this.theme.fg("muted", "CONTEXT ")}${this.theme.fg("muted", record.why)}`);
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  private selectActivity(index: number): void {
    const count = this.activity?.records.length ?? 0;
    const next = Math.max(0, Math.min(index, Math.max(0, count - 1)));
    if (next === this.activitySelected) return;
    this.activitySelected = next;
    this.activityDetailScroll = 0;
    this.requestRender();
  }

  private scrollActivityDetail(delta: number): void {
    this.activityDetailScroll = Math.max(0, Math.min(this.activityDetailScroll + delta, Math.max(0, this.lastActivityDetailCount - 1)));
    this.requestRender();
  }

  private renderActivityList(width: number, height: number): string[] {
    const records = this.activity?.records ?? [];
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} ACTIVITY  ${records.length}  ·  newest first`)];
    const visible = Math.max(1, height - 1);
    if (this.activitySelected < this.activityStart) this.activityStart = this.activitySelected;
    if (this.activitySelected >= this.activityStart + visible) this.activityStart = this.activitySelected - visible + 1;
    if (!records.length) lines.push(this.theme.fg("muted", "  No tool activity in this session"));
    for (let index = this.activityStart; index < Math.min(records.length, this.activityStart + visible); index++) {
      const record = records[index]!;
      const marker = index === this.activitySelected ? "›" : " ";
      const status = record.status === "running" ? this.theme.fg("warning", "●") : record.status === "error" ? this.theme.fg("error", "✕") : this.theme.fg("success", "✓");
      const subject = record.path ?? record.what;
      const time = record.status === "running" ? relativeTime(record.startedAt) : record.durationMs === undefined ? "" : formatDuration(record.durationMs);
      const text = `${marker} ${status} ${this.theme.fg("muted", record.kind.toUpperCase())} ${sanitizeTerminalLine(subject)}${time ? this.theme.fg("dim", `  ${time}`) : ""}`;
      const row = record.path ? fitWithSuffix(text, this.theme.fg("accent", " ↗"), width) : fit(text, width);
      lines.push(index === this.activitySelected ? this.theme.bg("selectedBg", row) : row);
    }
    return lines.slice(0, height);
  }

  private renderInsightHeader(title: string, status: string, width: number): string {
    return visibleWidth(title) + visibleWidth(status) + 2 <= width
      ? fitWithSuffix(title, status, width)
      : truncateToWidth(title, width, "…");
  }

  private renderInsightSections(
    width: number,
    sections: ReadonlyArray<{ label: string; value: string; tone: "text" | "muted" | "success" | "error" | "warning"; emphasize?: boolean }>,
  ): string[] {
    const rows: string[] = [];
    for (const [index, section] of sections.entries()) {
      if (index > 0) rows.push("");
      const labelTone = section.emphasize ? section.tone : "muted";
      rows.push(this.theme.bold(this.theme.fg(labelTone, section.label)));
      const wrapped = wrapTextWithAnsi(this.theme.fg(section.tone, sanitizeTerminalLine(section.value) || "—"), Math.max(1, width - 2));
      rows.push(...wrapped.map((line) => `  ${line}`));
    }
    return rows;
  }

  private renderActivityDetail(width: number, height: number): string[] {
    const record = this.activity?.records[this.activitySelected];
    const active = this.focus === "diff";
    const title = this.theme.fg(active ? "accent" : "muted", `${active ? "▶" : " "} ACTIVITY DETAILS`);
    if (!record) {
      const header = this.renderInsightHeader(title, this.theme.fg("dim", "○ READY"), width);
      return [header, this.theme.fg("muted", "No activity selected"), this.theme.fg("muted", "Tool actions and results appear here")].slice(0, height);
    }
    const statusTone = record.status === "error" ? "error" : record.status === "running" ? "warning" : "success";
    const statusIcon = record.status === "error" ? "✕" : record.status === "running" ? "●" : "✓";
    const statusLabel = record.status === "error" ? "FAILED" : record.status === "running" ? "RUNNING" : "DONE";
    const detail = this.renderInsightSections(width, [
      { label: "WHAT", value: record.what, tone: "text" },
      { label: "CONTEXT", value: record.why, tone: "muted" },
      { label: "HOW", value: record.how, tone: "muted" },
      { label: "RESULT", value: record.result, tone: statusTone, emphasize: true },
    ]);
    this.lastActivityDetailCount = detail.length;
    const visible = Math.max(0, height - 1);
    this.activityDetailScroll = Math.min(this.activityDetailScroll, Math.max(0, detail.length - visible));
    const end = Math.min(detail.length, this.activityDetailScroll + visible);
    const range = detail.length > visible ? this.theme.fg("dim", `  ${this.activityDetailScroll + 1}-${end}/${detail.length}`) : "";
    const timing = record.status === "running" ? relativeTime(record.startedAt) : record.durationMs === undefined ? "" : formatDuration(record.durationMs);
    const suffix = `${this.theme.fg(statusTone, `${statusIcon} ${statusLabel}`)}${timing ? this.theme.fg("dim", `  ·  ${timing}`) : ""}${range}`;
    const header = this.renderInsightHeader(title, suffix, width);
    return [header, ...detail.slice(this.activityDetailScroll, end)].slice(0, height);
  }

  private renderSearchList(width: number, height: number): string[] {
    const results = this.searchResults();
    this.searchSelected = Math.min(this.searchSelected, Math.max(0, results.length - 1));
    const visible = Math.max(1, height - 1);
    if (this.searchSelected < this.searchStart) this.searchStart = this.searchSelected;
    if (this.searchSelected >= this.searchStart + visible) this.searchStart = this.searchSelected - visible + 1;
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} RESULTS  ${results.length}`)];
    if (!results.length) lines.push(this.theme.fg("muted", this.searchFilesLoading ? "  Loading repository files…" : `  No matches · try m:, ${this.repo() ? "f:, " : ""}a:, c:, or fewer characters`));
    for (let index = this.searchStart; index < Math.min(results.length, this.searchStart + visible); index++) {
      const result = results[index]!;
      const marker = index === this.searchSelected ? "›" : " ";
      const icon = result.kind === "message" ? this.theme.fg("accent", "M") : result.kind === "file" ? this.theme.fg("accent", "F") : result.kind === "check" ? this.theme.fg("error", "!") : this.theme.fg("success", "A");
      const text = `${marker} ${icon} ${result.title}  ${this.theme.fg("dim", result.detail)}`;
      const value = result.value;
      const canOpen = value.kind === "file" || value.kind === "check" || (value.kind === "activity" && Boolean(value.record.path));
      const row = canOpen ? fitWithSuffix(text, this.theme.fg("accent", " ↗"), width) : fit(text, width);
      lines.push(index === this.searchSelected ? this.theme.bg("selectedBg", row) : row);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderSearchDetail(width: number, height: number): string[] {
    const result = this.searchResults()[this.searchSelected];
    const header = this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} QUICK PREVIEW`);
    if (!result) return [header, this.theme.fg("muted", "Refine the query to reveal a workspace item")].slice(0, height);
    const value = result.value;
    const canOpen = Boolean(this.repo());
    const lines = [header, `${this.theme.fg("muted", "TYPE     ")}${this.theme.fg("accent", result.kind.toUpperCase())}`];
    if (value.kind === "message") {
      lines.push(`${this.theme.fg("muted", "ROLE     ")}${this.theme.fg("text", value.message.role === "user" ? "YOU" : "PI")}`);
      lines.push(...wrapTextWithAnsi(`${this.theme.fg("muted", "MESSAGE  ")}${this.theme.fg("text", value.message.text)}`, width));
      lines.push("", this.theme.fg("muted", "Enter reveals the message in Session"));
    } else if (value.kind === "file") {
      lines.push(`${this.theme.fg("muted", "PATH     ")}${this.theme.fg("text", sanitizeTerminalLine(value.file.path))}`);
      lines.push(`${this.theme.fg("muted", "STATE    ")}${this.theme.fg(value.file.conflicted ? "error" : value.file.untracked ? "warning" : "muted", result.detail)}`);
      lines.push("", this.theme.fg("muted", canOpen ? "Enter reveals the diff · Ctrl+O opens Neovim" : "Enter reveals this workspace item"));
    } else if (value.kind === "activity") {
      lines.push(`${this.theme.fg("muted", "ACTION   ")}${this.theme.fg("text", value.record.what)}`);
      lines.push(`${this.theme.fg("muted", "CONTEXT  ")}${this.theme.fg("muted", value.record.why)}`);
      lines.push(`${this.theme.fg("muted", "RESULT   ")}${this.theme.fg(value.record.status === "error" ? "error" : value.record.status === "running" ? "warning" : "success", value.record.result)}`);
      lines.push("", this.theme.fg("muted", value.record.path && canOpen ? "Enter reveals activity · Ctrl+O opens its file" : "Enter reveals the activity record"));
    } else {
      lines.push(`${this.theme.fg("muted", "LOCATION ")}${this.theme.fg("text", `${value.diagnostic.path}:${value.diagnostic.line}:${value.diagnostic.column}`)}`);
      lines.push(`${this.theme.fg("muted", "SEVERITY ")}${this.theme.fg(value.diagnostic.severity, value.diagnostic.severity.toUpperCase())}`);
      lines.push(...wrapTextWithAnsi(`${this.theme.fg("muted", "MESSAGE  ")}${this.theme.fg(value.diagnostic.severity, value.diagnostic.message)}`, width));
      lines.push("", this.theme.fg("muted", canOpen ? "Enter reveals the check · Ctrl+O opens exact location" : "Enter reveals the check"));
    }
    return lines.map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private selectCheck(index: number): void {
    const count = this.activity?.diagnostics.length ?? 0;
    const next = Math.max(0, Math.min(index, Math.max(0, count - 1)));
    if (next === this.checkSelected) return;
    this.checkSelected = next;
    this.checkDetailScroll = 0;
    this.requestRender();
  }

  private scrollCheckDetail(delta: number): void {
    this.checkDetailScroll = Math.max(0, Math.min(this.checkDetailScroll + delta, Math.max(0, this.lastCheckDetailCount - 1)));
    this.requestRender();
  }

  private renderCheckList(width: number, height: number): string[] {
    const diagnostics = this.activity?.diagnostics ?? [];
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = diagnostics.length - errors;
    const summary = diagnostics.length ? `  ·  ${errors} errors${warnings ? `  ·  ${warnings} warnings` : ""}` : "";
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} PROBLEMS  ${diagnostics.length}${summary}`)];
    const visible = Math.max(1, height - 1);
    if (this.checkSelected < this.checkStart) this.checkStart = this.checkSelected;
    if (this.checkSelected >= this.checkStart + visible) this.checkStart = this.checkSelected - visible + 1;
    if (!diagnostics.length) {
      const checks = this.activity?.checks ?? [];
      const running = checks.find((record) => record.status === "running");
      const failed = checks.find((record) => record.status === "error");
      lines.push(running
        ? this.theme.fg("warning", `  ● ${running.what}`)
        : failed
          ? this.theme.fg("error", "  ✕ Check failed · no file locations parsed")
          : checks.length
            ? this.theme.fg("success", "  ✓ No problems from recent checks")
            : this.theme.fg("muted", "  Run tests, typecheck, or lint to populate checks"));
    }
    for (let index = this.checkStart; index < Math.min(diagnostics.length, this.checkStart + visible); index++) {
      const diagnostic = diagnostics[index]!;
      const marker = index === this.checkSelected ? "›" : " ";
      const icon = this.theme.fg(diagnostic.severity === "error" ? "error" : "warning", diagnostic.severity === "error" ? "✕" : "▲");
      const location = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`;
      const text = `${marker} ${icon} ${this.theme.fg("muted", diagnostic.source.toUpperCase())} ${location}  ${diagnostic.message}`;
      const row = fitWithSuffix(text, this.theme.fg("accent", " ↗"), width);
      lines.push(index === this.checkSelected ? this.theme.bg("selectedBg", row) : row);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderCheckDetail(width: number, height: number): string[] {
    const diagnostic = this.activity?.diagnostics[this.checkSelected];
    const active = this.focus === "diff";
    const title = this.theme.fg(active ? "accent" : "muted", `${active ? "▶" : " "} CHECK DETAILS`);
    if (!diagnostic) {
      const recent = this.activity?.checks ?? [];
      const running = recent.find((record) => record.status === "running");
      const failed = recent.find((record) => record.status === "error");
      const headerStatus = failed ? this.theme.fg("error", "✕ FAILED") : running ? this.theme.fg("warning", "● RUNNING") : recent.length ? this.theme.fg("success", "✓ CLEAR") : this.theme.fg("dim", "○ READY");
      const header = this.renderInsightHeader(title, headerStatus, width);
      if (!recent.length) return [header, this.theme.fg("muted", "No checks captured yet"), this.theme.fg("dim", "Run tests, typecheck, lint, or build")].slice(0, height);
      const rows: string[] = [];
      for (const record of recent.slice(0, Math.max(1, Math.floor((height - 1) / 3)))) {
        if (rows.length > 0) rows.push("");
        const tone = record.status === "error" ? "error" : record.status === "running" ? "warning" : "success";
        const icon = record.status === "error" ? "✕" : record.status === "running" ? "●" : "✓";
        rows.push(`${this.theme.fg(tone, icon)} ${this.theme.bold(this.theme.fg("muted", record.kind.toUpperCase()))}`);
        const result = wrapTextWithAnsi(this.theme.fg("text", sanitizeTerminalLine(record.result)), Math.max(1, width - 2));
        rows.push(...result.map((line) => `  ${line}`));
      }
      return [header, ...rows].slice(0, height);
    }
    const check = this.activity?.records.find((record) => record.id === diagnostic.checkId);
    const severityTone = diagnostic.severity === "error" ? "error" : "warning";
    const detail = this.renderInsightSections(width, [
      { label: "LOCATION", value: `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}`, tone: "text" },
      { label: "SEVERITY", value: diagnostic.severity.toUpperCase(), tone: severityTone, emphasize: true },
      { label: "SOURCE", value: diagnostic.source.toUpperCase(), tone: "muted" },
      { label: "MESSAGE", value: diagnostic.message, tone: severityTone, emphasize: true },
      { label: "COMMAND", value: check?.how ?? "Unknown check command", tone: "muted" },
    ]);
    this.lastCheckDetailCount = detail.length;
    const visible = Math.max(0, height - 1);
    this.checkDetailScroll = Math.min(this.checkDetailScroll, Math.max(0, detail.length - visible));
    const end = Math.min(detail.length, this.checkDetailScroll + visible);
    const range = detail.length > visible ? this.theme.fg("dim", `  ${this.checkDetailScroll + 1}-${end}/${detail.length}`) : "";
    const status = this.theme.fg(severityTone, `${diagnostic.severity === "error" ? "✕" : "▲"} ${diagnostic.severity.toUpperCase()}`);
    const header = this.renderInsightHeader(title, `${status}${range}`, width);
    return [header, ...detail.slice(this.checkDetailScroll, end)].slice(0, height);
  }

  private renderList(width: number, height: number): string[] {
    const working = this.scope === "working";
    const repo = this.repo();
    const settings = this.getSettings();
    const workingCount = repo ? filesForScope(repo.status.files, "working", settings.git.showUntracked).length : 0;
    const stagedCount = repo ? filesForScope(repo.status.files, "staged", settings.git.showUntracked).length : 0;
    const scope = width < 52
      ? this.theme.fg("accent", `[${working ? "WT" : "ST"} ${working ? workingCount : stagedCount}]`)
      : `${working ? this.theme.fg("accent", `[WORKTREE ${workingCount}]`) : this.theme.fg("muted", `Worktree ${workingCount}`)}  ${working ? this.theme.fg("muted", `Staged ${stagedCount}`) : this.theme.fg("accent", `[STAGED ${stagedCount}]`)}`;
    const latestAvailable = Boolean(this.activity?.latestRequest?.editedPathCount);
    const filter = this.reviewFilter === "latest" && latestAvailable ? `LATEST REQUEST ${this.files.length}/${this.scopedFileCount}` : `ALL WORKSPACE ${this.files.length}/${this.scopedFileCount}`;
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} `) + scope + this.theme.fg(this.reviewFilter === "latest" && latestAvailable ? "accent" : "muted", `  ·  [${filter}]`)];
    const visible = Math.max(1, height - 1);
    if (this.selected < this.listStart) this.listStart = this.selected;
    if (this.selected >= this.listStart + visible) this.listStart = this.selected - visible + 1;
    if (!this.files.length) lines.push(this.theme.fg("muted", `  No ${this.scope} changes`));
    const icons = resolveGlyphs(this.getSettings()).icons;
    for (let i = this.listStart; i < Math.min(this.files.length, this.listStart + visible); i++) {
      const file = this.files[i]!;
      const editing = this.activity?.isEditing(file.path) ?? false;
      const marker = editing ? this.theme.fg("warning", "●") : i === this.selected ? "›" : " ";
      const icon = file.conflicted ? "!" : file.untracked ? icons.untracked : file.staged && this.scope === "staged" ? icons.added : icons.modified;
      const status = file.conflicted ? "!" : file.untracked ? "?" : this.scope === "staged" ? file.index.trim() || "M" : file.worktree.trim() || "M";
      const path = sanitizeTerminalLine(file.path);
      const rename = file.oldPath ? this.theme.fg("dim", ` ← ${sanitizeTerminalLine(file.oldPath)}`) : "";
      const touched = this.activity?.touchedTimestamp(file.path);
      const time = touched ? this.theme.fg("dim", `  ${relativeTime(touched)}`) : "";
      const text = `${marker} ${this.theme.fg(file.conflicted ? "error" : file.untracked ? "warning" : "muted", status)} ${icon} ${path}${rename}${time}`;
      const stats = this.scope === "staged" ? file.stagedStats : file.workingStats;
      const statText = file.untracked ? this.theme.fg("warning", "new") : stats?.binary ? this.theme.fg("warning", "binary") : stats ? `${this.theme.fg("toolDiffAdded", `+${stats.added}`)} ${this.theme.fg("toolDiffRemoved", `-${stats.deleted}`)}` : "";
      const suffix = statText && width >= visibleWidth(statText) + 24 ? `  ${statText}${this.theme.fg("accent", "  ↗")}` : this.theme.fg("accent", " ↗");
      const row = fitWithSuffix(text, suffix, width);
      lines.push(i === this.selected ? this.theme.bg("selectedBg", row) : row);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.files[this.selected];
    if (!file) return this.renderWorkspaceOverview(width, height);
    const truncated = this.diff.kind === "ready" && this.diff.truncated ? this.theme.fg("warning", " [truncated]") : "";
    const hunks = this.currentHunks();
    this.hunkSelected = Math.min(this.hunkSelected, Math.max(0, hunks.length - 1));
    const hunkStatus = hunks.length ? this.theme.fg("dim", `  ·  HUNK ${this.hunkSelected + 1}/${hunks.length}  ·  n/p select  ·  s ${this.scope === "working" ? "stage" : "unstage"}`) : "";
    const lines = [this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} DIFF  ${sanitizeTerminalLine(file.path)}`) + hunkStatus + truncated];
    const bodyHeight = Math.max(1, height - 1);
    this.lastDiffPage = Math.max(1, bodyHeight - 1);
    if (this.diff.kind === "loading") lines.push(this.theme.fg("dim", "Loading diff…"));
    else if (this.diff.kind === "error") lines.push(this.theme.fg("error", sanitizeTerminalLine(this.diff.message)));
    else if (this.diff.kind === "empty") lines.push(this.theme.fg("muted", file ? "No diff" : "Select a file"));
    else if (this.diff.binary) lines.push(this.theme.fg("warning", "Binary file"));
    else {
      const source = this.diff.text ? this.displayDiffLines(this.diff.text) : [{ text: "No textual changes", color: "toolDiffContext" as const }];
      const maxScroll = Math.max(0, source.length - bodyHeight + (this.diff.truncated ? 1 : 0));
      this.diffScroll = Math.max(0, Math.min(this.diffScroll, maxScroll));
      const hunkLines = this.diffDisplayCache?.text === this.diff.text ? this.diffDisplayCache.hunkLines : undefined;
      for (let index = this.diffScroll; index < Math.min(source.length, this.diffScroll + bodyHeight); index++) {
        const line = source[index]!;
        const selectedHunk = hunkLines?.get(index) === this.hunkSelected;
        const rendered = this.theme.fg(line.color, selectedHunk ? `▶ HUNK ${this.hunkSelected + 1}/${hunks.length}  ${line.text.trimStart()}` : line.text);
        lines.push(selectedHunk ? this.theme.bg("selectedBg", fit(rendered, width)) : rendered);
      }
      if (this.diff.truncated && lines.length < height) lines.push(this.theme.fg("warning", "… diff truncated"));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderWorkspaceOverview(width: number, height: number): string[] {
    const repo = this.repo();
    const lines = [this.theme.bold(this.theme.fg("accent", "CHANGES"))];
    if (!repo) return [...lines, this.theme.fg("muted", "Git features are unavailable in this folder.")].slice(0, height);
    const { status } = repo;
    const branch = status.branch;
    const sync = branch.gone ? "upstream gone" : [branch.ahead ? `↑${branch.ahead}` : "", branch.behind ? `↓${branch.behind}` : ""].filter(Boolean).join(" ") || "synced";
    const settings = this.getSettings();
    const changeCount = status.files.filter((file) => settings.git.showUntracked || !file.untracked).length;
    const worktreeCount = filesForScope(status.files, "working", settings.git.showUntracked).length;
    const stagedCount = filesForScope(status.files, "staged", settings.git.showUntracked).length;
    lines.push(this.theme.fg(changeCount ? "warning" : "success", changeCount ? `${changeCount} changed · ${worktreeCount} worktree · ${stagedCount} staged` : "✓ Working tree clean"));
    lines.push(`${this.theme.fg("muted", "BRANCH  ")}${this.theme.fg("text", branch.name ?? "detached")}${this.theme.fg(branch.gone || branch.ahead || branch.behind ? "warning" : "muted", `  ·  ${sync}`)}`);
    const latestAvailable = Boolean(this.activity?.latestRequest?.editedPathCount);
    const filter = this.reviewFilter === "latest" && latestAvailable ? "Latest request" : "All workspace";
    const explanation = latestAvailable ? `t toggles review · ${this.files.length}/${this.scopedFileCount} ${this.scope} changes match` : "t unavailable · latest request has no successfully edited files";
    lines.push(`${this.theme.fg("muted", "FILTER  ")}${this.theme.fg(this.reviewFilter === "latest" && latestAvailable ? "accent" : "text", filter)}${this.theme.fg("muted", `  ·  ${explanation}`)}`);
    lines.push("", this.theme.fg("muted", changeCount ? "Tab switches Worktree/Staged; select a file to inspect its diff." : "No file changes in this workspace."));
    return lines.map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private scrollDiff(delta: number): void {
    if (this.diff.kind !== "ready" || this.diff.binary) return;
    const count = this.diff.text ? this.displayDiffLines(this.diff.text).length : 0;
    this.diffScroll = Math.max(0, Math.min(this.diffScroll + delta, Math.max(0, count - 1)));
    this.requestRender();
  }
}
