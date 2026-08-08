import { basename, relative } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "./tui-compat.ts";
import type { GitStateController, GitViewState } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import type { CodeuiSettings } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";
import { calculateUsageSnapshot, formatTokens, type UsageSnapshot } from "./usage.ts";

const fit = (text: string, width: number, align: "left" | "center" | "right" = "left"): string => {
  const value = truncateToWidth(text, Math.max(0, width), "…");
  const gap = Math.max(0, width - visibleWidth(value));
  if (align === "right") return `${" ".repeat(gap)}${value}`;
  if (align === "center") return `${" ".repeat(Math.floor(gap / 2))}${value}${" ".repeat(Math.ceil(gap / 2))}`;
  return `${value}${" ".repeat(gap)}`;
};

const columns = (
  left: string,
  center: string,
  right: string,
  width: number,
  leftRatio = 0.34,
  centerRatio = 0.32,
): string => {
  if (width < 90) {
    const rightWidth = Math.min(Math.floor(width * 0.44), visibleWidth(right));
    const leftWidth = Math.max(0, width - rightWidth - (rightWidth > 0 ? 2 : 0));
    return truncateToWidth(`${fit(left, leftWidth)}${rightWidth > 0 ? "  " : ""}${fit(right, rightWidth, "right")}`, width, "");
  }
  const gutter = 2;
  const usable = Math.max(0, width - gutter * 2);
  const leftWidth = Math.floor(usable * leftRatio);
  const centerWidth = Math.floor(usable * centerRatio);
  return `${fit(left, leftWidth)}${" ".repeat(gutter)}${fit(center, centerWidth, "center")}${" ".repeat(gutter)}${fit(right, usable - leftWidth - centerWidth, "right")}`;
};

const readyState = (state: GitViewState) => state.kind === "loading" ? state.previous : state;

const branchName = (state: GitViewState): string => {
  const ready = readyState(state);
  return ready?.kind === "repo" ? sanitizeTerminalLine(ready.status.branch.name ?? "detached") : "no git";
};

const projectName = (state: GitViewState, cwd: string): string => {
  const ready = readyState(state);
  const root = ready?.kind === "repo" ? ready.root : cwd;
  return sanitizeTerminalLine(basename(root) || root || "workspace");
};

const gitSummary = (state: GitViewState, settings: Readonly<CodeuiSettings>): { text: string; tone: "success" | "warning" | "error" | "muted" } => {
  const ready = readyState(state);
  if (state.kind === "error") return { text: "git error", tone: "error" };
  if (!ready) return { text: "syncing", tone: "muted" };
  if (ready.kind !== "repo") return { text: "no git", tone: "muted" };
  const count = ready.status.files.filter((file) => settings.git.showUntracked || !file.untracked).length;
  if (!count) return { text: "clean", tone: "success" };
  const added = ready.working.added + ready.cached.added;
  const deleted = ready.working.deleted + ready.cached.deleted;
  return { text: `${count} changed  +${added} -${deleted}`, tone: "warning" };
};

const projectPath = (cwd: string): string => {
  const home = homedir();
  const fromHome = relative(home, cwd);
  return fromHome && !fromHome.startsWith("..") ? `~/${sanitizeTerminalLine(fromHome)}` : sanitizeTerminalLine(cwd);
};

const pathBreadcrumb = (cwd: string, theme: Theme): string => {
  const path = projectPath(cwd);
  const leaf = sanitizeTerminalLine(basename(cwd));
  if (!leaf || !path.endsWith(leaf)) return theme.fg("muted", path);
  return `${theme.fg("muted", path.slice(0, -leaf.length))}${theme.fg("text", leaf)}`;
};

export interface ChromeRenderContext {
  cwd: string;
  model?: string;
  thinking?: string;
  agentRunning: boolean;
  sessionTitle?: string;
  usage: UsageSnapshot;
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
  const summary = gitSummary(state, settings);
  const hasGit = readyState(state)?.kind === "repo";
  const leftLabel = hasGit ? "PROJECT" : "SESSION";
  const leftName = hasGit ? projectName(state, context.cwd) : sanitizeTerminalLine(context.sessionTitle ?? "New conversation");
  const left = `${theme.fg("dim", `${leftLabel}  `)}${theme.bold(theme.fg("accent", leftName))}`;
  const center = hasGit
    ? `${theme.fg("muted", `${icons.branch} ${branchName(state)}`)}${theme.fg("dim", "  ·  ")}${theme.fg(summary.tone, summary.text)}`
    : state.kind === "error"
      ? `${theme.fg("muted", "LOCAL SESSION")}${theme.fg("error", "  ·  git error")}`
      : theme.fg("muted", "LOCAL CONVERSATION");
  const status = context.agentRunning ? "ACTIVE" : "READY";
  const right = theme.bold(theme.fg(context.agentRunning ? "warning" : "success", `●  ${status}`));
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
  const left = `${theme.fg("dim", "CWD  ")}${pathBreadcrumb(context.cwd, theme)}`;
  const center = renderUsageMetrics(context.usage, theme, width < 160);
  const right = renderModelStatus(context.model, context.thinking, theme, width < 160);
  return [theme.fg("border", "─".repeat(width)), columns(left, center, right, width, 0.27, 0.45)];
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

export function renderUsageMetrics(usage: UsageSnapshot, theme: Theme, compact: boolean): string {
  const contextColor = (usage.contextPercent ?? 0) > 90 ? "error" : (usage.contextPercent ?? 0) > 70 ? "warning" : "accent";
  const contextValue = `${usage.contextTokens === null ? "?" : formatTokens(usage.contextTokens)}/${formatTokens(usage.contextWindow)}${usage.contextPercent === null ? "" : ` ${usage.contextPercent.toFixed(0)}%`}`;
  if (compact) {
    return [
      `${theme.fg("dim", "IN ")}${theme.fg("accent", formatTokens(usage.session.input))}`,
      `${theme.fg("dim", "OUT ")}${theme.fg("success", formatTokens(usage.session.output))}`,
      `${theme.fg("dim", "#")}${theme.fg("thinkingHigh", String(usage.turnNumber))}`,
      `${theme.fg("dim", "CTX ")}${theme.fg(contextColor, usage.contextPercent === null ? "?" : `${usage.contextPercent.toFixed(0)}%`)}`,
    ].join(theme.fg("dim", "  ·  "));
  }
  return [
    `${theme.fg("dim", "TOKENS  ")}${theme.fg("accent", formatTokens(usage.session.input))}${theme.fg("dim", " in  ")}${theme.fg("success", formatTokens(usage.session.output))}${theme.fg("dim", " out")}`,
    `${theme.fg("dim", "TURN  ")}${theme.fg("thinkingHigh", String(usage.turnNumber))}`,
    `${theme.fg("dim", "CONTEXT  ")}${theme.fg(contextColor, contextValue)}`,
  ].join(theme.fg("dim", "   ·   "));
}

const THINKING_TONES = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingHigh",
  max: "thinkingMax",
} as const;

export function renderModelStatus(model: string | undefined, thinking: string | undefined, theme: Theme, compact: boolean): string {
  const modelName = sanitizeTerminalLine(model ?? "no model").toUpperCase();
  const level = sanitizeTerminalLine(thinking ?? "off").toLowerCase();
  const thinkingLabel = level === "xhigh" ? "X-HIGH" : level.toUpperCase();
  const thinkingTone = THINKING_TONES[level as keyof typeof THINKING_TONES] ?? "muted";
  if (compact) return `${theme.fg("accent", modelName)}${theme.fg("dim", `  ·  ${thinkingLabel}`)}`;
  return `${theme.fg("dim", "MODEL  ")}${theme.bold(theme.fg("accent", modelName))}${theme.fg("dim", "   THINK  ")}${theme.bold(theme.fg(thinkingTone, thinkingLabel))}`;
}

export function chromeContext(ctx: ExtensionContext, agentRunning: boolean, sessionTitle?: string): ChromeRenderContext {
  return {
    cwd: ctx.cwd,
    model: ctx.model?.id,
    thinking: ctx.thinkingLevel,
    agentRunning,
    sessionTitle,
    usage: calculateUsageSnapshot(ctx.sessionManager, ctx.getContextUsage(), ctx.model?.contextWindow ?? 0),
  };
}
