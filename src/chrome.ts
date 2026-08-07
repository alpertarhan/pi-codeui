import { basename, relative } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { GitStateController, GitViewState } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import type { CodeuiSettings } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

const fit = (text: string, width: number, align: "left" | "center" | "right" = "left"): string => {
  const value = truncateToWidth(text, Math.max(0, width), "…");
  const gap = Math.max(0, width - visibleWidth(value));
  if (align === "right") return `${" ".repeat(gap)}${value}`;
  if (align === "center") return `${" ".repeat(Math.floor(gap / 2))}${value}${" ".repeat(Math.ceil(gap / 2))}`;
  return `${value}${" ".repeat(gap)}`;
};

const columns = (left: string, center: string, right: string, width: number): string => {
  if (width < 60) {
    const leftWidth = Math.max(0, width - Math.min(24, visibleWidth(right)) - 1);
    return truncateToWidth(`${fit(left, leftWidth)} ${fit(right, width - leftWidth - 1, "right")}`, width, "");
  }
  const leftWidth = Math.floor(width * 0.36);
  const centerWidth = Math.floor(width * 0.28);
  return `${fit(left, leftWidth)}${fit(center, centerWidth, "center")}${fit(right, width - leftWidth - centerWidth, "right")}`;
};

const branchName = (state: GitViewState): string => {
  const ready = state.kind === "loading" ? state.previous : state;
  return ready?.kind === "repo" ? sanitizeTerminalLine(ready.status.branch.name ?? "detached") : "no-git";
};

const projectPath = (cwd: string): string => {
  const home = homedir();
  const fromHome = relative(home, cwd);
  return fromHome && !fromHome.startsWith("..") ? `~/${sanitizeTerminalLine(fromHome)}` : sanitizeTerminalLine(cwd);
};

export interface ChromeRenderContext {
  cwd: string;
  model?: string;
  thinking?: string;
  agentRunning: boolean;
}

export function renderChromeHeader(
  state: GitViewState,
  settings: Readonly<CodeuiSettings>,
  theme: Theme,
  context: ChromeRenderContext,
  width: number,
): string[] {
  if (!settings.chrome.header || width <= 0) return [];
  const { icons } = resolveGlyphs(settings);
  const workspace = basename(context.cwd);
  const workspaceLabel = workspace === "pi-codeui" ? "" : `  ·  ${workspace}`;
  const left = `${theme.fg("accent", `${icons.brand} pi-codeui`)}${theme.fg("dim", workspaceLabel)}`;
  const center = theme.fg("muted", `${icons.branch} ${branchName(state)}`);
  const right = `${theme.fg(context.agentRunning ? "warning" : "success", context.agentRunning ? "● working" : "● ready")}${theme.fg("dim", `  ${context.model ?? "no-model"}`)}`;
  return [columns(left, center, right, width), theme.fg("border", "─".repeat(width))];
}

export function renderChromeFooter(
  state: GitViewState,
  settings: Readonly<CodeuiSettings>,
  theme: Theme,
  context: ChromeRenderContext,
  width: number,
): string[] {
  if (!settings.chrome.footer || width <= 0) return [];
  const ready = state.kind === "loading" ? state.previous : state;
  let git = "git idle";
  if (ready?.kind === "repo") {
    const count = ready.status.files.filter((file) => settings.git.showUntracked || !file.untracked).length;
    git = count ? `${count} changed  +${ready.working.added + ready.cached.added}/-${ready.working.deleted + ready.cached.deleted}` : "✓ clean";
  } else if (state.kind === "error") git = "git error";
  const left = theme.fg("dim", projectPath(context.cwd));
  const center = theme.fg(ready?.kind === "repo" && ready.status.files.length === 0 ? "success" : "muted", git);
  const right = `${theme.fg("accent", context.model ?? "no-model")}${context.thinking ? theme.fg("dim", `  ·  ${context.thinking}`) : ""}`;
  return [theme.fg("border", "─".repeat(width)), columns(left, center, right, width)];
}

export function createChromeBar(
  kind: "header" | "footer",
  tui: TUI,
  theme: Theme,
  git: GitStateController,
  getSettings: () => Readonly<CodeuiSettings>,
  getContext: () => ChromeRenderContext,
): Component & { dispose(): void } {
  const unsubscribe = git.onChange(() => tui.requestRender());
  return {
    render: (width) => kind === "header"
      ? renderChromeHeader(git.state, getSettings(), theme, getContext(), width)
      : renderChromeFooter(git.state, getSettings(), theme, getContext(), width),
    invalidate: () => {},
    dispose: unsubscribe,
  };
}

export function chromeContext(ctx: ExtensionContext, agentRunning: boolean): ChromeRenderContext {
  return {
    cwd: ctx.cwd,
    model: ctx.model?.id,
    thinking: ctx.thinkingLevel,
    agentRunning,
  };
}
