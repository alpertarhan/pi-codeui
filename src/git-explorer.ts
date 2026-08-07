import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { getDiff, previewUntracked, type DiffScope, type GitExec } from "./git/git.ts";
import type { FileChange, TextResult } from "./git/types.ts";
import type { GitStateController } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { BORDER_PRESETS, DENSITY_PRESETS, type CodeuiSettings } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

export type ExplorerScope = "working" | "staged";
export type GitExplorerResult = { action: "edit"; root: string; path: string } | undefined;
export interface GitExplorerOptions { embedded?: boolean; }
type DiffState = { kind: "empty" } | { kind: "loading" } | { kind: "error"; message: string } | ({ kind: "ready" } & TextResult);

const fit = (text: string, width: number): string => {
  const value = truncateToWidth(text, Math.max(0, width), "…");
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
};

export function filesForScope(files: readonly FileChange[], scope: ExplorerScope, showUntracked = true): FileChange[] {
  return files.filter((file) => scope === "staged" ? file.staged : file.unstaged || file.conflicted || (showUntracked && file.untracked));
}

export class GitExplorer implements Focusable {
  focused = false;
  scope: ExplorerScope = "working";
  focus: "list" | "diff" = "list";
  selected = 0;
  diffScroll = 0;
  private listStart = 0;
  private files: FileChange[] = [];
  private diff: DiffState = { kind: "empty" };
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private dismissed = false;
  private lastDiffPage = 8;
  private readonly embedded: boolean;
  private readonly unsubscribe: () => void;
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
    this.unsubscribe = git.onChange(() => this.syncFiles());
    this.syncFiles();
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.escape)) {
      this.dismiss();
      return;
    }
    if (matchesKey(data, Key.tab)) {
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
      const file = this.files[this.selected];
      const repo = this.repo();
      if (file && repo) this.dismiss({ action: "edit", root: repo.root, path: file.path });
      return;
    }
    const down = data === "j" || matchesKey(data, Key.down);
    const up = data === "k" || matchesKey(data, Key.up);
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) this.scrollDiff(this.lastDiffPage);
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) this.scrollDiff(-this.lastDiffPage);
    else if ((down || up) && this.focus === "diff") this.scrollDiff(down ? 1 : -1);
    else if (down || up) this.select(this.selected + (down ? 1 : -1));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.theme.fg("accent", "Git"), width, "")];
    const settings = this.getSettings();
    const border = BORDER_PRESETS[settings.appearance.borders];
    const density = DENSITY_PRESETS[settings.appearance.density];
    const edge = visibleWidth(border.vertical);
    const inner = Math.max(1, width - edge * 2);
    const terminalRows = process.stdout.rows ?? 24;
    const maxRows = this.embedded ? Math.max(5, terminalRows) : Math.max(5, Math.floor(terminalRows * 0.85));
    const gap = density.gap > 0 && maxRows >= 10;
    const bodyHeight = Math.max(1, maxRows - 4 - (gap ? 2 : 0));
    const content: string[] = [];
    const working = this.scope === "working";
    content.push(`${this.theme.fg("accent", "Git Explorer")}  ${working ? this.theme.fg("accent", "[Working]") : this.theme.fg("muted", "Working")}  ${working ? this.theme.fg("muted", "Staged") : this.theme.fg("accent", "[Staged]")}`);
    if (gap) content.push("");

    if (inner >= 76) {
      const listWidth = Math.max(24, Math.floor(inner * 0.34));
      const diffWidth = inner - listWidth - 3;
      const list = this.renderList(listWidth, bodyHeight);
      const diff = this.renderDiff(diffWidth, bodyHeight);
      for (let i = 0; i < bodyHeight; i++) content.push(`${fit(list[i] ?? "", listWidth)} ${this.theme.fg("borderMuted", border.vertical || "|")} ${fit(diff[i] ?? "", diffWidth)}`);
    } else if (bodyHeight < 3) {
      content.push(...this.renderList(inner, 1));
      if (bodyHeight > 1) content.push(...this.renderDiff(inner, 1));
    } else {
      const listHeight = Math.min(5, Math.max(bodyHeight >= 5 ? 2 : 1, Math.floor((bodyHeight - 1) * 0.35)));
      const diffHeight = bodyHeight - listHeight - 1;
      content.push(...this.renderList(inner, listHeight));
      content.push(this.theme.fg("borderMuted", border.horizontal.repeat(inner)));
      content.push(...this.renderDiff(inner, diffHeight));
    }
    if (gap) content.push("");
    content.push(this.theme.fg("dim", "j/k select/scroll · Tab scope · Enter focus · PgUp/PgDn scroll · e nvim · r refresh · q close"));

    const framed = content.map((line) => this.theme.fg("border", border.vertical) + fit(line, inner) + this.theme.fg("border", border.vertical));
    const horizontal = (left: string, right: string) => this.theme.fg("border", truncateToWidth(`${left}${border.horizontal.repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)))}${right}`, width, ""));
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
  }

  private repo() {
    const state = this.git.state;
    if (state.kind === "repo") return state;
    return state.kind === "loading" && state.previous?.kind === "repo" ? state.previous : undefined;
  }

  private syncFiles(): void {
    if (this.disposed) return;
    const repo = this.repo();
    this.files = repo ? filesForScope(repo.status.files, this.scope, this.getSettings().git.showUntracked) : [];
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.files.length - 1)));
    this.listStart = Math.min(this.listStart, this.selected);
    void this.loadDiff();
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

  private renderList(width: number, height: number): string[] {
    const lines = [this.theme.fg(this.focus === "list" ? "accent" : "muted", `${this.focus === "list" ? "▶" : " "} Files (${this.files.length})`)];
    const visible = Math.max(1, height - 1);
    if (this.selected < this.listStart) this.listStart = this.selected;
    if (this.selected >= this.listStart + visible) this.listStart = this.selected - visible + 1;
    if (!this.files.length) lines.push(this.theme.fg("muted", `  No ${this.scope} changes`));
    const icons = resolveGlyphs(this.getSettings()).icons;
    for (let i = this.listStart; i < Math.min(this.files.length, this.listStart + visible); i++) {
      const file = this.files[i]!;
      const marker = i === this.selected ? ">" : " ";
      const icon = file.conflicted ? "!" : file.untracked ? icons.untracked : file.staged && this.scope === "staged" ? icons.added : icons.modified;
      const text = `${marker} ${icon} ${sanitizeTerminalLine(file.path)}`;
      lines.push(i === this.selected ? this.theme.bg("selectedBg", fit(text, width)) : text);
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private renderDiff(width: number, height: number): string[] {
    const file = this.files[this.selected];
    const truncated = this.diff.kind === "ready" && this.diff.truncated ? this.theme.fg("warning", " [truncated]") : "";
    const lines = [this.theme.fg(this.focus === "diff" ? "accent" : "muted", `${this.focus === "diff" ? "▶" : " "} ${sanitizeTerminalLine(file?.path ?? "Diff")}`) + truncated];
    const bodyHeight = Math.max(1, height - 1);
    this.lastDiffPage = Math.max(1, bodyHeight - 1);
    if (this.diff.kind === "loading") lines.push(this.theme.fg("dim", "Loading diff…"));
    else if (this.diff.kind === "error") lines.push(this.theme.fg("error", sanitizeTerminalLine(this.diff.message)));
    else if (this.diff.kind === "empty") lines.push(this.theme.fg("muted", file ? "No diff" : "Select a file"));
    else if (this.diff.binary) lines.push(this.theme.fg("warning", "Binary file"));
    else {
      const source = this.diff.text ? this.diff.text.split("\n") : ["No textual changes"];
      const maxScroll = Math.max(0, source.length - bodyHeight + (this.diff.truncated ? 1 : 0));
      this.diffScroll = Math.max(0, Math.min(this.diffScroll, maxScroll));
      for (const rawLine of source.slice(this.diffScroll, this.diffScroll + bodyHeight)) {
        const line = sanitizeTerminalLine(rawLine);
        const color = line.startsWith("+") && !line.startsWith("+++") ? "toolDiffAdded" : line.startsWith("-") && !line.startsWith("---") ? "toolDiffRemoved" : "toolDiffContext";
        lines.push(this.theme.fg(color, line));
      }
      if (this.diff.truncated && lines.length < height) lines.push(this.theme.fg("warning", "… diff truncated"));
    }
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  private scrollDiff(delta: number): void {
    if (this.diff.kind !== "ready" || this.diff.binary) return;
    const count = this.diff.text ? this.diff.text.split("\n").length : 0;
    this.diffScroll = Math.max(0, Math.min(this.diffScroll + delta, Math.max(0, count - 1)));
    this.requestRender();
  }
}
