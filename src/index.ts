import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { createChangesWidget } from "./changes-widget.ts";
import { getSettingsPaths } from "./config.ts";
import { GitExplorer } from "./git-explorer.ts";
import { GitStateController } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { SettingsController } from "./settings-controller.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { sanitizeTerminalLine } from "./terminal.ts";

export { detectRoot, getDiff, getLineStats, getRepoState, GitCancelledError, GitError, previewUntracked } from "./git/git.ts";
export { parseBranch, parseNumstat, parseStatus, PorcelainError } from "./git/porcelain.ts";
export type { BranchInfo, ChangeCounts, FileChange, LineStats, RepoState, RepoStatus, StatusCode, TextResult, UntrackedPreview } from "./git/types.ts";

const CHANGES_KEY = "pi-codeui.changes";
const GIT_KEY = "pi-codeui.git";

interface Runtime {
  settings: SettingsController;
  git: GitStateController;
  ctx: ExtensionContext;
  unsubscribe: () => void;
  explorer?: GitExplorer;
}

export default function codeui(pi: ExtensionAPI): void {
  let settings: SettingsController | undefined;
  let runtime: Runtime | undefined;

  const clearUI = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(CHANGES_KEY, undefined);
    ctx.ui.setStatus(GIT_KEY, undefined);
    ctx.ui.setStatus(SettingsController.statusKey, undefined);
  };

  const disposeRuntime = (ctx?: ExtensionContext): void => {
    const previousCtx = runtime?.ctx;
    runtime?.explorer?.dismiss();
    runtime?.unsubscribe();
    runtime?.git.dispose();
    runtime = undefined;
    settings?.dispose();
    settings = undefined;
    if (previousCtx) clearUI(previousCtx);
    if (ctx && ctx !== previousCtx) clearUI(ctx);
  };

  const installWidget = (): void => {
    if (!runtime) return;
    const { ctx, git } = runtime;
    const current = runtime.settings.current;
    ctx.ui.setWidget(CHANGES_KEY, current.widget.enabled
      ? (tui, theme) => createChangesWidget(tui, theme, git, () => runtime?.settings.current ?? DEFAULT_SETTINGS)
      : undefined, { placement: current.widget.placement });
    runtime.explorer?.settingsChanged();
  };

  const openExplorer = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || !runtime) {
      if (ctx.hasUI) ctx.ui.notify("Git Explorer is available in interactive TUI sessions.", "warning");
      return;
    }
    const active = runtime;
    await active.git.refresh();
    if (runtime !== active) return;
    if (active.git.state.kind === "none") {
      ctx.ui.notify("Git Explorer: current directory is not a Git repository.", "info");
      return;
    }
    if (active.git.state.kind === "error") {
      ctx.ui.notify(`Git Explorer: ${sanitizeTerminalLine(active.git.state.message)}`, "error");
      return;
    }
    const explorerSettings = active.settings.current.explorer;
    const wide = (process.stdout.columns ?? 0) >= explorerSettings.minOverlayColumns;
    try {
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const explorer = new GitExplorer(active.git, pi.exec.bind(pi), () => active.settings.current, theme, () => tui.requestRender(), () => done());
        active.explorer = explorer;
        return explorer;
      }, wide ? {
        overlay: true,
        overlayOptions: { width: explorerSettings.overlayWidth, maxHeight: "85%", anchor: "right-center" },
      } : undefined);
    } finally {
      active.explorer?.dispose();
      active.explorer = undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    disposeRuntime();
    settings = new SettingsController(
      getSettingsPaths(ctx.cwd),
      ctx.isProjectTrusted(),
      ctx.mode === "tui" ? ctx.ui : undefined,
      75,
      installWidget,
    );
    await settings.start(ctx.mode === "tui");
    if (ctx.mode !== "tui") return;

    const git = new GitStateController(pi.exec.bind(pi), ctx.cwd);
    const unsubscribe = git.onChange(() => {
      if (!runtime) return;
      const state = git.state;
      ctx.ui.setStatus(GIT_KEY, state.kind === "error" ? ctx.ui.theme.fg("error", "git error") : undefined);
    });
    runtime = { settings, git, ctx, unsubscribe };
    await git.refresh();
    installWidget();
  });

  pi.on("session_shutdown", (_event, ctx) => disposeRuntime(ctx));

  pi.on("tool_result", (event) => {
    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") runtime?.git.schedule();
  });
  pi.on("agent_settled", () => runtime?.git.schedule());

  pi.registerCommand("codeui", {
    description: "Open the read-only Git Explorer",
    handler: async (_args, ctx) => openExplorer(ctx),
  });
  pi.registerShortcut(Key.ctrlShift("g"), {
    description: "Open the read-only Git Explorer",
    handler: openExplorer,
  });
  pi.registerCommand("codeui-refresh", {
    description: "Refresh pi-codeui Git state",
    handler: async (_args, ctx) => {
      if (!runtime) {
        if (ctx.hasUI) ctx.ui.notify("pi-codeui Git state is only active in the interactive TUI.", "warning");
        return;
      }
      const active = runtime;
      await active.git.refresh();
      if (runtime === active && active.git.state.kind === "error") ctx.ui.notify(`Git refresh failed: ${sanitizeTerminalLine(active.git.state.message)}`, "error");
    },
  });

  pi.registerCommand("codeui-doctor", {
    description: "Report pi-codeui settings, glyphs, and terminal appearance ownership",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== "tui") return;
      const paths = getSettingsPaths(ctx.cwd);
      const current = settings?.current ?? DEFAULT_SETTINGS;
      const glyphs = resolveGlyphs(current);
      const terminal = process.env.TERM_PROGRAM || process.env.TERM || "unknown";
      ctx.ui.notify([
        `Global config: ${paths.global}`,
        `Project config: ${paths.project} (${ctx.isProjectTrusted() ? "trusted/active" : "untrusted/ignored"})`,
        `Glyph preset: ${glyphs.preset}`,
        `Samples: ${glyphs.icons.brand} ${glyphs.icons.branch} ${glyphs.icons.modified} ${glyphs.icons.added} ${glyphs.icons.untracked}`,
        `Terminal: ${terminal}`,
        "Font family, size, features, and ligatures are managed by the host terminal.",
      ].join("\n"), "info");
    },
  });
}
