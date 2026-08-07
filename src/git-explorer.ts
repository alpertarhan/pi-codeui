import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import { formatDuration, relativeTime, type ActivityRecord, type ActivityTracker } from "./activity.ts";
import { getDiff, previewUntracked, type DiffScope, type GitExec } from "./git/git.ts";
import type { FileChange, TextResult } from "./git/types.ts";
import type { GitStateController } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { BORDER_PRESETS, DENSITY_PRESETS, type CodeuiSettings } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

export type ExplorerScope = "working" | "staged";
type ExplorerView = "changes" | "activity";
export type GitExplorerResult = { action: "edit"; root: string; path: string } | undefined;
export interface GitExplorerOptions {
  embedded?: boolean;
  reservedRows?: number;
  getTerminalRows?: () => number;
  activity?: ActivityTracker;
}
type DiffState = { kind: "empty" } | { kind: "loading" } | { kind: "error"; message: string } | ({ kind: "ready" } & TextResult);

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
  private view: ExplorerView = "changes";
  private listStart = 0;
  private activitySelected = 0;
  private activityStart = 0;
  private activityDetailScroll = 0;
  private lastActivityDetailCount = 0;
  private lastMouseClick: { view: ExplorerView; index: number; at: number } | undefined;
  private files: FileChange[] = [];
  private diff: DiffState = { kind: "empty" };
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private dismissed = false;
  private lastDiffPage = 8;
  private readonly embedded: boolean;
  private readonly reservedRows: number;
  private readonly getTerminalRows: () => number;
  private readonly activity: ActivityTracker | undefined;
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
    this.reservedRows = options.reservedRows ?? 0;
    this.getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows ?? 24);
    this.activity = options.activity;
    this.unsubscribe = git.onChange(() => this.syncFiles());
    this.unsubscribeActivity = this.activity?.onChange(() => {
      this.activitySelected = Math.min(this.activitySelected, Math.max(0, (this.activity?.records.length ?? 1) - 1));
      this.syncFiles(false);
      this.requestRender();
    });
    this.syncFiles();
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.escape)) {
      this.dismiss();
      return;
    }
    if (data === "a") {
      this.view = "activity";
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (data === "g") {
      this.view = "changes";
      this.focus = "list";
      this.requestRender();
      return;
    }
    if (this.view === "changes" && matchesKey(data, Key.tab)) {
      this.scope = this.scope === "working" ? "staged" : "working";
      this.selected = 0;
      this.listStart = 0;
      this.syncFiles();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.focus = this.focus === "list" ? "diff" : "list";
      this.requestRender();
      return;
    }
    if (data === "r") {
      void this.git.refresh();
      return;
    }
    if (data === "e") {
      const path = this.view === "changes" ? this.files[this.selected]?.path : this.activity?.records[this.activitySelected]?.path;
      const repo = this.repo();
      if (path && repo) this.dismiss({ action: "edit", root: repo.root, path });
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
    if (pageDown) this.scrollDiff(this.lastDiffPage);
    else if (pageUp) this.scrollDiff(-this.lastDiffPage);
    else if ((down || up) && this.focus === "diff") this.scrollDiff(down ? 1 : -1);
    else if (down || up) this.select(this.selected + (down ? 1 : -1));
  }

  handleMouse(x: number, y: number, width: number, now = Date.now()): boolean {
    if (!this.embedded || width < 4 || x < 0 || y < 0) return false;
    const settings = this.getSettings();
    const border = BORDER_PRESETS[settings.appearance.borders];
    const density = DENSITY_PRESETS[settings.appearance.density];
    const inner = Math.max(1, width - visibleWidth(border.vertical));
    const localX = Math.max(0, x - visibleWidth(border.vertical));
    const maxRows = Math.max(5, this.getTerminalRows() - this.reservedRows);
    const gap = density.gap > 0 && maxRows >= 12;
    const nowLines = maxRows >= 9 ? (this.activity?.current ? 2 : 1) : maxRows >= 7 ? 1 : 0;
    const bodyStart = 1 + nowLines + (gap ? 1 : 0);
    const bodyHeight = Math.max(1, maxRows - 2 - nowLines - (gap ? 2 : 0));

    if (y === 0) {
      if (localX >= inner - 8) this.view = "activity";
      else if (localX >= inner - 18) this.view = "changes";
      this.focus = "list";
      this.requestRender();
      return true;
    }
    if (y < bodyStart || y >= bodyStart + bodyHeight) return true;

    let inList = true;
    let listRow = y - bodyStart;
    let listPanelWidth = inner;
    if (inner >= 76) {
      listPanelWidth = Math.max(24, Math.floor(inner * 0.38));
      inList = localX < listPanelWidth;
    } else {
      const listHeight = Math.min(this.view === "activity" ? 7 : 5, Math.max(bodyHeight >= 5 ? 2 : 1, Math.floor((bodyHeight - 1) * (this.view === "activity" ? 0.42 : 0.35))));
      inList = listRow < listHeight;
      if (!inList) listRow -= listHeight + 1;
    }

    if (!inList) {
      this.focus = "diff";
      this.requestRender();
      return true;
    }
    this.focus = "list";
    if (listRow === 0) {
      if (this.view === "changes") {
        this.scope = localX < 13 ? "working" : "staged";
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
        if (record.path && (doubleClick || localX >= listPanelWidth - 4)) {
          const repo = this.repo();
          if (repo) this.dismiss({ action: "edit", root: repo.root, path: record.path });
          this.lastMouseClick = undefined;
          return true;
        }
        this.selectActivity(index);
        this.lastMouseClick = { view: "activity", index, at: now };
      }
    } else {
      const index = this.listStart + listRow - 1;
      const file = this.files[index];
      if (file) {
        const doubleClick = this.lastMouseClick?.view === "changes" && this.lastMouseClick.index === index && now - this.lastMouseClick.at <= 500;
        if (doubleClick || localX >= listPanelWidth - 4) {
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

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.theme.fg("accent", "Git"), width, "")];
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
    const title = this.theme.bold(this.theme.fg("accent", `${icons.brand}  GIT EXPLORER`));
    const tabs = `${this.view === "changes" ? this.theme.fg("accent", "CHANGES") : this.theme.fg("muted", "Changes")}  ${this.view === "activity" ? this.theme.fg("accent", "ACTIVITY") : this.theme.fg("muted", "Activity")}`;
    content.push(`${title}${" ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(tabs)))}${tabs}`);
    const now = this.renderNow(inner, maxRows >= 9 ? 2 : maxRows >= 7 ? 1 : 0);
    content.push(...now);
    if (gap) content.push("");
    const bodyHeight = Math.max(1, maxRows - (this.embedded ? 2 : 4) - now.length - (gap ? 2 : 0));

    const renderList = (panelWidth: number, height: number) => this.view === "changes" ? this.renderList(panelWidth, height) : this.renderActivityList(panelWidth, height);
    const renderDetail = (panelWidth: number, height: number) => this.view === "changes" ? this.renderDiff(panelWidth, height) : this.renderActivityDetail(panelWidth, height);
    if (inner >= 76) {
      const listWidth = Math.max(24, Math.floor(inner * 0.38));
      const detailWidth = inner - listWidth - 3;
      const list = renderList(listWidth, bodyHeight);
      const detail = renderDetail(detailWidth, bodyHeight);
      for (let i = 0; i < bodyHeight; i++) content.push(`${fit(list[i] ?? "", listWidth)} ${this.theme.fg("borderMuted", border.vertical || "|")} ${fit(detail[i] ?? "", detailWidth)}`);
    } else if (bodyHeight < 3) {
      content.push(...renderList(inner, 1));
      if (bodyHeight > 1) content.push(...renderDetail(inner, 1));
    } else {
      const listHeight = Math.min(this.view === "activity" ? 7 : 5, Math.max(bodyHeight >= 5 ? 2 : 1, Math.floor((bodyHeight - 1) * (this.view === "activity" ? 0.42 : 0.35))));
      const detailHeight = bodyHeight - listHeight - 1;
      content.push(...renderList(inner, listHeight));
      content.push(this.theme.fg("borderMuted", border.horizontal.repeat(inner)));
      content.push(...renderDetail(inner, detailHeight));
    }
    if (gap) content.push("");
    const fullHints = this.view === "changes" ? "a activity  j/k move  Tab scope  ↗/double-click/e nvim  r refresh  q editor" : "g changes  j/k move  Enter detail  ↗/double-click/e nvim  q editor";
    const compactHints = this.view === "changes" ? "a activity  j/k  Tab  ↗/dbl/e  r  q" : "g changes  j/k  Enter  ↗/dbl/e  q";
    content.push(this.theme.fg("dim", visibleWidth(fullHints) <= inner ? fullHints : compactHints));

    const borderToken = this.focused ? "borderAccent" : "border";
    if (this.embedded) return content.map((line) => this.theme.fg(borderToken, border.vertical) + fit(line, inner));
    const framed = content.map((line) => this.theme.fg(borderToken, border.vertical) + fit(line, inner) + this.theme.fg(borderToken, border.vertical));
    const horizontal = (left: string, right: string) => this.theme.fg(borderToken, truncateToWidth(`${left}${border.horizontal.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`, width, ""));
    return [horizontal(border.topLeft, border.topRight), ...framed, horizontal(border.bottomLeft, border.bottomRight)];
  }

  invalidate(): void {
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
    const scoped = repo ? filesForScope(repo.status.files, this.scope, this.getSettings().git.showUntracked) : [];
    this.files = this.activity?.orderFiles(scoped) ?? scoped;
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

  private renderNow(width: number, maxLines: number): string[] {
    if (maxLines <= 0) return [];
    const record = this.activity?.current;
    if (!record) return [this.theme.fg("dim", "NOW  ○ idle · waiting for the next AI action")].slice(0, maxLines);
    const status = record.status === "running" ? this.theme.fg("warning", "●") : record.status === "error" ? this.theme.fg("error", "✕") : this.theme.fg("success", "✓");
    const timing = record.status === "running" ? relativeTime(record.startedAt) : record.durationMs === undefined ? "" : formatDuration(record.durationMs);
    const lines = [`${this.theme.fg("dim", "NOW  ")}${status} ${this.theme.fg("text", record.what)}${timing ? this.theme.fg("dim", `  ${timing}`) : ""}`];
    if (maxLines > 1) lines.push(`${this.theme.fg("dim", "WHY ")} ${this.theme.fg("muted", record.why)}`);
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
    if (!records.length) lines.push(this.theme.fg("muted", "  No AI actions in this session"));
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

  private renderActivityDetail(width: number, height: number): string[] {
    const record = this.activity?.records[this.activitySelected];
    const header = this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} DEVELOPER INSIGHT`);
    if (!record) return [header, this.theme.fg("muted", "Select an AI action")].slice(0, height);
    const fields: Array<[string, string, "text" | "muted" | "success" | "error" | "warning"]> = [
      ["WHAT", record.what, "text"],
      ["WHY", record.why, "muted"],
      ["HOW", record.how, "muted"],
      ["RESULT", record.result, record.status === "error" ? "error" : record.status === "running" ? "warning" : "success"],
    ];
    const detail: string[] = [];
    for (const [label, value, color] of fields) {
      const prefix = `${this.theme.fg("dim", label.padEnd(7))}`;
      const wrapped = wrapTextWithAnsi(`${prefix}${this.theme.fg(color, sanitizeTerminalLine(value))}`, Math.max(1, width));
      detail.push(...wrapped);
    }
    this.lastActivityDetailCount = detail.length;
    const visible = Math.max(0, height - 1);
    this.activityDetailScroll = Math.min(this.activityDetailScroll, Math.max(0, detail.length - visible));
    return [header, ...detail.slice(this.activityDetailScroll, this.activityDetailScroll + visible)].slice(0, height);
  }

  private renderList(width: number, height: number): string[] {
    const working = this.scope === "working";
    const scope = `${working ? this.theme.fg("accent", "WORKING") : this.theme.fg("muted", "Working")}  ${working ? this.theme.fg("muted", "Staged") : this.theme.fg("accent", "STAGED")}`;
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} `) + `${scope}${this.theme.fg("dim", `  ·  ${this.files.length} files`)}`];
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
      const row = fitWithSuffix(text, this.theme.fg("accent", " ↗"), width);
      lines.push(i === this.selected ? this.theme.bg("selectedBg", row) : row);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.files[this.selected];
    if (!file) return this.renderWorkspaceOverview(width, height);
    const truncated = this.diff.kind === "ready" && this.diff.truncated ? this.theme.fg("warning", " [truncated]") : "";
    const lines = [this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} DIFF  ${sanitizeTerminalLine(file.path)}`) + truncated];
    const bodyHeight = Math.max(1, height - 1);
    this.lastDiffPage = Math.max(1, bodyHeight - 1);
    if (this.diff.kind === "loading") lines.push(this.theme.fg("dim", "Loading diff…"));
    else if (this.diff.kind === "error") lines.push(this.theme.fg("error", sanitizeTerminalLine(this.diff.message)));
    else if (this.diff.kind === "empty") lines.push(this.theme.fg("muted", file ? "No diff" : "Select a file"));
    else if (this.diff.binary) lines.push(this.theme.fg("warning", "Binary file"));
    else {
      const source = this.diff.text ? formatUnifiedDiff(this.diff.text) : [{ text: "No textual changes", color: "toolDiffContext" as const }];
      const maxScroll = Math.max(0, source.length - bodyHeight + (this.diff.truncated ? 1 : 0));
      this.diffScroll = Math.max(0, Math.min(this.diffScroll, maxScroll));
      for (const line of source.slice(this.diffScroll, this.diffScroll + bodyHeight)) lines.push(this.theme.fg(line.color, line.text));
      if (this.diff.truncated && lines.length < height) lines.push(this.theme.fg("warning", "… diff truncated"));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderWorkspaceOverview(width: number, height: number): string[] {
    const repo = this.repo();
    const lines = [this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} WORKSPACE OVERVIEW`)];
    if (!repo) return [...lines, this.theme.fg("muted", "No Git repository")].slice(0, height);
    const status = repo.status;
    const branch = status.branch;
    const sync = branch.gone ? "upstream gone" : [branch.ahead ? `↑${branch.ahead}` : "", branch.behind ? `↓${branch.behind}` : ""].filter(Boolean).join(" ") || "in sync";
    const changeCount = status.files.filter((file) => this.getSettings().git.showUntracked || !file.untracked).length;
    const records = this.activity?.records ?? [];
    const mutations = records.filter((record) => record.kind === "edit" || record.kind === "write").length;
    const commands = records.filter((record) => ["bash", "test", "build", "lint"].includes(record.kind)).length;
    const checks = records.filter((record) => ["test", "build", "lint"].includes(record.kind)).length;
    const errors = records.filter((record) => record.status === "error").length;
    lines.push(this.theme.fg(changeCount ? "warning" : "success", changeCount ? `${changeCount} files changed` : "✓ Working tree clean"));
    lines.push(`${this.theme.fg("dim", "BRANCH  ")}${this.theme.fg("text", branch.name ?? "detached")}${this.theme.fg("dim", `  ·  ${sync}`)}`);
    lines.push(`${this.theme.fg("dim", "SESSION ")}${this.theme.fg("text", `${records.length} actions`)}${this.theme.fg("dim", `  ·  ${mutations} mutations  ·  ${commands} commands  ·  ${checks} checks`)}${errors ? this.theme.fg("error", `  ·  ${errors} errors`) : ""}`);
    const latest = records[0];
    if (latest) {
      lines.push("");
      lines.push(`${this.theme.fg("dim", "LATEST  ")}${this.theme.fg("text", sanitizeTerminalLine(latest.what))}`);
      lines.push(`${this.theme.fg("dim", "RESULT  ")}${this.theme.fg(latest.status === "error" ? "error" : latest.status === "running" ? "warning" : "success", sanitizeTerminalLine(latest.result))}`);
    }
    lines.push("");
    lines.push(this.theme.fg("dim", "Click ↗ or double-click a file to open Neovim"));
    while (lines.length < height) lines.push("");
    return lines.map((line) => truncateToWidth(line, width, "…")).slice(0, height);
  }

  private scrollDiff(delta: number): void {
    if (this.diff.kind !== "ready" || this.diff.binary) return;
    const count = this.diff.text ? formatUnifiedDiff(this.diff.text).length : 0;
    this.diffScroll = Math.max(0, Math.min(this.diffScroll + delta, Math.max(0, count - 1)));
    this.requestRender();
  }
}
