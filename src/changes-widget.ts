import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { GitStateController, GitViewState } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { BORDER_PRESETS, DENSITY_PRESETS, type CodeuiSettings } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

const fit = (text: string, width: number): string => {
  const value = truncateToWidth(text, Math.max(0, width), "…");
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
};

export function renderChangesWidget(state: GitViewState, settings: Readonly<CodeuiSettings>, theme: Theme, width: number): string[] {
  if (!settings.widget.enabled || width <= 0 || state.kind === "none") return [];
  if (state.kind === "loading" && !state.previous) return [truncateToWidth(theme.fg("dim", "git: loading…"), width, "…")];
  if (state.kind === "error") return [truncateToWidth(theme.fg("error", `git: ${sanitizeTerminalLine(state.message)}`), width, "…")];
  const ready = state.kind === "loading" ? state.previous : state;
  if (!ready || ready.kind === "none") return state.kind === "loading" ? [truncateToWidth(theme.fg("dim", "git: loading…"), width, "")] : [];

  const { icons } = resolveGlyphs(settings);
  const { status, working, cached } = ready;
  const branch = sanitizeTerminalLine(status.branch.name ?? "detached");
  const visibleFiles = status.files.filter((file) => settings.git.showUntracked || !file.untracked);
  const counts = {
    staged: visibleFiles.filter((file) => file.staged).length,
    unstaged: visibleFiles.filter((file) => file.unstaged).length,
    untracked: visibleFiles.filter((file) => file.untracked).length,
    conflicted: visibleFiles.filter((file) => file.conflicted).length,
  };
  const dirty = visibleFiles.length > 0;
  const parts = [
    theme.bold(theme.fg("accent", "CHANGES")),
    theme.fg("accent", `${icons.branch} ${branch}`),
    dirty ? theme.fg("warning", `${icons.added}${counts.staged} ${icons.modified}${counts.unstaged} ${icons.untracked}${counts.untracked} !${counts.conflicted}`) : theme.fg("success", "clean"),
  ];
  const added = working.added + cached.added;
  const deleted = working.deleted + cached.deleted;
  if (dirty) parts.push(theme.fg("toolDiffAdded", `+${added}`), theme.fg("toolDiffRemoved", `-${deleted}`));
  const files = visibleFiles
    .slice(0, settings.widget.maxFiles)
    .map((file) => `${file.conflicted ? "!" : file.untracked ? icons.untracked : file.staged ? icons.added : icons.modified} ${sanitizeTerminalLine(file.path)}`);
  if (files.length) parts.push(theme.fg("muted", files.join("  ")));
  if (state.kind === "loading") parts.push(theme.fg("dim", "refreshing…"));

  const text = parts.join(theme.fg("dim", "  ·  "));
  const density = DENSITY_PRESETS[settings.appearance.density];
  if (density.padding === 0 || width < 4) return [truncateToWidth(text, width, "…")];

  const border = BORDER_PRESETS[settings.appearance.borders];
  const verticalWidth = visibleWidth(border.vertical) * 2;
  const inner = Math.max(0, width - verticalWidth);
  const row = (content: string) => theme.fg("border", border.vertical) + fit(content, inner) + theme.fg("border", border.vertical);
  const top = theme.fg("border", truncateToWidth(`${border.topLeft}${border.horizontal.repeat(Math.max(0, width - visibleWidth(border.topLeft) - visibleWidth(border.topRight)))}${border.topRight}`, width, ""));
  const bottom = theme.fg("border", truncateToWidth(`${border.bottomLeft}${border.horizontal.repeat(Math.max(0, width - visibleWidth(border.bottomLeft) - visibleWidth(border.bottomRight)))}${border.bottomRight}`, width, ""));
  return [top, row(text), bottom];
}

export function createChangesWidget(tui: TUI, theme: Theme, git: GitStateController, getSettings: () => Readonly<CodeuiSettings>): Component & { dispose(): void } {
  const unsubscribe = git.onChange(() => tui.requestRender());
  return {
    render: (width) => renderChangesWidget(git.state, getSettings(), theme, width),
    invalidate: () => {},
    dispose: unsubscribe,
  };
}
