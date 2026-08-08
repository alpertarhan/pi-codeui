import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { ActivityTracker } from "./activity.ts";
import { createChangesWidget } from "./changes-widget.ts";
import { chromeContext, createChromeBar } from "./chrome.ts";
import { getSettingsPaths } from "./config.ts";
import { openExternalEditor, openExternalQuickfix } from "./external-editor.ts";
import { GitExplorer, type ExplorerView, type GitExplorerResult } from "./git-explorer.ts";
import { GitStateController } from "./git-state.ts";
import { resolveGlyphs } from "./glyphs.ts";
import { SettingsController } from "./settings-controller.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { SplitPanelController } from "./split-panel.ts";
import { summarizeSession, type SessionOverview } from "./session.ts";
import { sanitizeTerminalLine } from "./terminal.ts";
import { VimEditor } from "./vim-editor.ts";
import { WorkspaceStateStore } from "./workspace-state.ts";

export { detectRoot, getDiff, getLineStats, getRepoState, GitCancelledError, GitError, previewUntracked } from "./git/git.ts";
export { parseBranch, parseNumstat, parseStatus, PorcelainError } from "./git/porcelain.ts";
export type { BranchInfo, ChangeCounts, FileChange, LineStats, RepoState, RepoStatus, StatusCode, TextResult, UntrackedPreview } from "./git/types.ts";

const CHANGES_KEY = "pi-codeui.changes";
const GIT_KEY = "pi-codeui.git";

type EditorFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

interface Runtime {
  settings: SettingsController;
  git: GitStateController;
  activity: ActivityTracker;
  workspaceStore: WorkspaceStateStore;
  workspaceRoot: string;
  ctx: ExtensionContext;
  unsubscribe: () => void;
  explorer?: GitExplorer;
  previousEditor?: EditorFactory;
  vimFactory?: NonNullable<EditorFactory>;
  vimOverride?: boolean;
  vimModal?: boolean;
  editorChrome?: boolean;
  split?: SplitPanelController;
  agentRunning: boolean;
  session: SessionOverview;
  workspaceView: ExplorerView;
  requestRender?: () => void;
}

export default function codeui(pi: ExtensionAPI): void {
  let settings: SettingsController | undefined;
  let runtime: Runtime | undefined;

  const clearUI = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(CHANGES_KEY, undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(GIT_KEY, undefined);
    ctx.ui.setStatus(SettingsController.statusKey, undefined);
  };

  const restoreEditor = (active: Runtime): void => {
    if (active.vimFactory && active.ctx.ui.getEditorComponent() === active.vimFactory) {
      active.ctx.ui.setEditorComponent(active.previousEditor);
    }
    active.vimFactory = undefined;
    active.previousEditor = undefined;
    active.vimModal = undefined;
    active.editorChrome = undefined;
  };

  const disposeRuntime = (ctx?: ExtensionContext): void => {
    const active = runtime;
    const previousCtx = active?.ctx;
    active?.explorer?.dismiss();
    active?.split?.dispose();
    if (active) restoreEditor(active);
    active?.unsubscribe();
    active?.activity.dispose();
    active?.git.dispose();
    active?.workspaceStore.dispose();
    runtime = undefined;
    settings?.dispose();
    settings = undefined;
    if (previousCtx) clearUI(previousCtx);
    if (ctx && ctx !== previousCtx) clearUI(ctx);
  };

  const refreshSession = (): void => {
    if (!runtime) return;
    runtime.session = summarizeSession(runtime.ctx.sessionManager.getBranch(), runtime.ctx.sessionManager.getSessionName());
    runtime.requestRender?.();
  };

  const scheduleSessionRefresh = (): void => {
    const active = runtime;
    if (!active) return;
    const immediate = setImmediate(() => {
      if (runtime === active) refreshSession();
    });
    immediate.unref?.();
  };

  const syncVimEditor = (): void => {
    if (!runtime) return;
    const active = runtime;
    const modal = active.vimOverride ?? active.settings.current.vim.enabled;
    const chrome = active.settings.current.chrome.editor;
    const enabled = modal || chrome;
    if (!enabled) {
      restoreEditor(active);
      return;
    }
    if (active.vimFactory && active.vimModal === modal && active.editorChrome === chrome) return;
    if (active.vimFactory) restoreEditor(active);

    active.previousEditor = active.ctx.ui.getEditorComponent();
    active.vimModal = modal;
    active.editorChrome = chrome;
    active.vimFactory = (tui, theme, keybindings) => new VimEditor(tui, theme, keybindings, {
      startMode: active.settings.current.vim.startMode,
      modal,
      label: "PROMPT",
      styleMode: (mode, label, focused) => active.ctx.ui.theme.fg(focused ? (modal && mode === "insert" ? "success" : "accent") : "dim", label),
      styleBorder: (_mode, text) => active.ctx.ui.theme.fg("border", text),
    });
    active.ctx.ui.setEditorComponent(active.vimFactory);
  };

  const handleExplorerAction = async (active: Runtime, result: Exclude<GitExplorerResult, undefined>): Promise<void> => {
    if (runtime !== active) return;
    const editor = active.settings.current.vim.externalEditor;
    const editorResult = result.action === "quickfix"
      ? await openExternalQuickfix(active.ctx, editor, result.root, result.entries)
      : await openExternalEditor(active.ctx, editor, result.root, result.path, result.line ? { line: result.line, column: result.column } : undefined);
    if (runtime !== active) return;
    if (editorResult.error) active.ctx.ui.notify(`External editor failed: ${sanitizeTerminalLine(editorResult.error)}`, "error");
    else if (editorResult.status !== 0) active.ctx.ui.notify(`External editor exited with status ${editorResult.status ?? "unknown"}.`, "warning");
    await active.git.refresh();
  };

  const installWidget = (): void => {
    if (!runtime) return;
    const active = runtime;
    const { ctx, git } = active;
    const current = active.settings.current;
    if (current.appearance.theme !== "inherit") {
      const themeResult = ctx.ui.setTheme(current.appearance.theme);
      if (!themeResult.success) ctx.ui.notify(`pi-codeui theme: ${sanitizeTerminalLine(themeResult.error ?? "theme not found")}`, "warning");
    }
    const context = () => chromeContext(ctx, active.agentRunning, active.session.title);
    const publicChrome = (kind: "header" | "footer", tui: Parameters<typeof createChromeBar>[1], theme: Parameters<typeof createChromeBar>[2]) => {
      const bar = createChromeBar(kind, tui, theme, git, () => active.settings.current, context);
      return {
        render: (width: number) => active.split?.installed ? [] : bar.render(width),
        invalidate: () => bar.invalidate(),
        dispose: () => bar.dispose(),
      };
    };
    ctx.ui.setHeader(current.chrome.header ? (tui, theme) => publicChrome("header", tui, theme) : undefined);
    ctx.ui.setFooter(current.chrome.footer ? (tui, theme) => publicChrome("footer", tui, theme) : undefined);
    ctx.ui.setWidget(CHANGES_KEY, (tui, theme) => {
      active.requestRender = () => tui.requestRender();
      active.split?.dispose();
      const workspaceState = active.workspaceStore.get(active.workspaceRoot);
      active.split = new SplitPanelController(tui, {
        git,
        activity: active.activity,
        getSessionOverview: () => active.session,
        isAgentRunning: () => active.agentRunning,
        getView: () => active.workspaceView,
        onViewChange: (view) => { active.workspaceView = view; },
        exec: pi.exec.bind(pi),
        getSettings: () => active.settings.current,
        theme,
        header: current.chrome.header ? createChromeBar("header", tui, theme, git, () => active.settings.current, context) : undefined,
        footer: current.chrome.footer ? createChromeBar("footer", tui, theme, git, () => active.settings.current, context) : undefined,
        confirm: (title, message) => ctx.ui.confirm(title, message),
        input: (title, placeholder) => ctx.ui.input(title, placeholder),
        select: (title, options) => ctx.ui.select(title, options),
        notify: (message, level) => ctx.ui.notify(message, level),
        workspaceState,
        onWorkspaceStateChange: (patch) => active.workspaceStore.update(active.workspaceRoot, patch),
        onAction: (result) => void handleExplorerAction(active, result),
      });
      active.split.ensure();
      const split = active.split;
      const widget = current.widget.enabled
        ? createChangesWidget(tui, theme, git, () => runtime?.settings.current ?? DEFAULT_SETTINGS)
        : undefined;
      return {
        render: (width: number) => {
          active.split?.ensure();
          return active.split?.installed ? [] : widget?.render(width) ?? [];
        },
        invalidate: () => widget?.invalidate(),
        dispose: () => {
          widget?.dispose?.();
          split.dispose();
          if (active.split === split) active.split = undefined;
        },
      };
    }, { placement: current.widget.placement });
    active.explorer?.settingsChanged();
    active.split?.settingsChanged();
    syncVimEditor();
  };

  const openExplorer = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui" || !runtime) {
      if (ctx.hasUI) ctx.ui.notify("CodeUI is available in interactive TUI sessions.", "warning");
      return;
    }
    const active = runtime;
    if (active.split?.focus()) {
      void active.git.refresh();
      return;
    }
    await active.git.refresh();
    if (runtime !== active) return;
    if (active.git.state.kind === "error") {
      ctx.ui.notify(`CodeUI Git features: ${sanitizeTerminalLine(active.git.state.message)}`, "warning");
    }
    const explorerSettings = active.settings.current.explorer;
    const wide = (process.stdout.columns ?? 0) >= explorerSettings.minOverlayColumns;
    let result: GitExplorerResult;
    try {
      result = await ctx.ui.custom<GitExplorerResult>((tui, theme, _keybindings, done) => {
        const explorer = new GitExplorer(active.git, pi.exec.bind(pi), () => active.settings.current, theme, () => tui.requestRender(), done, {
          activity: active.activity,
          getSessionOverview: () => active.session,
          isAgentRunning: () => active.agentRunning,
          initialView: active.workspaceView,
          onViewChange: (view) => { active.workspaceView = view; },
          confirm: (title, message) => ctx.ui.confirm(title, message),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          select: (title, options) => ctx.ui.select(title, options),
          notify: (message, level) => ctx.ui.notify(message, level),
          workspaceState: active.workspaceStore.get(active.workspaceRoot),
          onWorkspaceStateChange: (patch) => active.workspaceStore.update(active.workspaceRoot, patch),
        });
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

    if (result && runtime === active) await handleExplorerAction(active, result);
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
    const activity = new ActivityTracker(ctx.cwd);
    const workspaceStore = new WorkspaceStateStore();
    const unsubscribe = git.onChange(() => {
      if (!runtime) return;
      const state = git.state;
      ctx.ui.setStatus(GIT_KEY, state.kind === "error" ? ctx.ui.theme.fg("error", "git error") : undefined);
    });
    const session = summarizeSession(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionName());
    runtime = { settings, git, activity, workspaceStore, workspaceRoot: ctx.cwd, ctx, unsubscribe, agentRunning: false, session, workspaceView: "session" };
    await git.refresh();
    if (runtime) runtime.workspaceRoot = git.state.kind === "repo" ? git.state.root : ctx.cwd;
    if (workspaceStore.warning) ctx.ui.notify(`pi-codeui workspace state: ${sanitizeTerminalLine(workspaceStore.warning)}`, "warning");
    installWidget();
  });

  pi.on("session_shutdown", (_event, ctx) => disposeRuntime(ctx));

  pi.on("turn_start", () => runtime?.activity.beginTurn());
  pi.on("message_end", (event) => {
    runtime?.activity.captureMessage(event);
    if (event.message.role !== "user" && event.message.role !== "assistant") return;
    // Pi persists message_end after extension handlers return.
    scheduleSessionRefresh();
  });
  pi.on("session_info_changed", refreshSession);
  pi.on("session_compact", refreshSession);
  pi.on("session_tree", refreshSession);
  pi.on("tool_execution_start", (event) => runtime?.activity.start(event));
  pi.on("tool_execution_update", (event) => runtime?.activity.update(event));
  pi.on("tool_execution_end", (event) => runtime?.activity.end(event));

  pi.on("agent_start", () => {
    if (!runtime) return;
    runtime.agentRunning = true;
    runtime.requestRender?.();
  });
  pi.on("agent_end", () => {
    if (!runtime) return;
    runtime.agentRunning = false;
    runtime.requestRender?.();
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") runtime?.git.schedule();
  });
  pi.on("agent_settled", () => runtime?.git.schedule());

  pi.registerCommand("codeui", {
    description: "Open the CodeUI workspace",
    handler: async (_args, ctx) => openExplorer(ctx),
  });
  pi.registerShortcut(Key.ctrlShift("g"), {
    description: "Focus the CodeUI workspace",
    handler: openExplorer,
  });
  pi.registerCommand("codeui-reset-workspace", {
    description: "Reset saved pi-codeui layout state for this repository",
    handler: async (_args, ctx) => {
      if (!runtime) {
        if (ctx.hasUI) ctx.ui.notify("pi-codeui workspace state is only active in the interactive TUI.", "warning");
        return;
      }
      runtime.workspaceStore.clear(runtime.workspaceRoot);
      runtime.workspaceStore.flushSync();
      installWidget();
      ctx.ui.notify("Reset saved CodeUI width, scope, and widget dock state for this workspace.", "info");
    },
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

  pi.registerCommand("codeui-vim", {
    description: "Toggle pi-codeui Vim mode for this session",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !runtime) {
        if (ctx.hasUI) ctx.ui.notify("Vim mode is available in interactive TUI sessions.", "warning");
        return;
      }
      const active = runtime;
      const enabled = active.vimOverride ?? active.settings.current.vim.enabled;
      active.vimOverride = !enabled;
      syncVimEditor();
      ctx.ui.notify(`Vim mode ${active.vimOverride ? "enabled" : "disabled"} for this session.`, "info");
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
      const workspaceState = runtime ? runtime.workspaceStore.get(runtime.workspaceRoot) : {};
      const repo = runtime?.git.state;
      ctx.ui.notify([
        `Global config: ${paths.global}`,
        `Project config: ${paths.project} (${ctx.isProjectTrusted() ? "trusted/active" : "untrusted/ignored"})`,
        `Theme: ${current.appearance.theme}`,
        `Chrome: header ${current.chrome.header ? "on" : "off"} · footer ${current.chrome.footer ? "on" : "off"} · editor ${current.chrome.editor ? "on" : "off"}`,
        `Glyph preset: ${glyphs.preset}`,
        `Samples: ${glyphs.icons.brand} ${glyphs.icons.branch} ${glyphs.icons.modified} ${glyphs.icons.added} ${glyphs.icons.untracked}`,
        `Runtime: Node ${process.versions.node} · ${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}`,
        `Terminal: ${terminal}`,
        `Repository: ${repo?.kind === "repo" ? repo.root : repo?.kind ?? "inactive"}`,
        `Explorer layout: ${runtime?.split?.diagnostic ?? current.explorer.layout}`,
        `Workspace state: ${runtime?.workspaceStore.path ?? "inactive"} · ${JSON.stringify(workspaceState)}`,
        `Activity: ${runtime?.activity.records.length ?? 0} records · ${runtime?.activity.diagnostics.length ?? 0} problems${runtime?.activity.current ? ` · ${runtime.activity.current.status} ${runtime.activity.current.toolName}` : ""}`,
        `External editor: ${current.vim.externalEditor.join(" ")}`,
        `Embedded Vim: ${(runtime?.vimOverride ?? current.vim.enabled) ? "enabled" : "disabled"}`,
        "Font family, size, features, and ligatures are managed by the host terminal.",
      ].join("\n"), "info");
    },
  });
}
