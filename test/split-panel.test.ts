import assert from "node:assert/strict";
import test from "node:test";
import { TuiAltScreen, VStack, type Component, type Terminal } from "@earendil-works/pi-tui";
import { GitStateController } from "../src/git-state.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";
import { extractExtensionWidgetDock, SplitPanelController } from "../src/split-panel.ts";

function terminal(columns = 160, rows = 30): Terminal {
  return {
    columns,
    rows,
    kittyProtocolActive: false,
    start: () => {}, stop: () => {}, drainInput: async () => {}, write: () => {}, moveBy: () => {},
    hideCursor: () => {}, showCursor: () => {}, clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {},
    setTitle: () => {}, setProgress: () => {},
  };
}

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};

const component = (): Component => ({ render: () => ["main"], invalidate: () => {} });

const focusable = () => ({
  focused: false,
  render: () => ["editor"],
  invalidate: () => {},
  handleInput: () => {},
});

test("Pi extension widgets are extracted from the transcript dock", () => {
  const line = (text: string): Component => ({ render: () => [text], invalidate: () => {} });
  const above = line("TODO WIDGET");
  const below = line("BELOW WIDGET");
  const dock = new VStack([line("pending"), line("status"), above, line("editor"), below, line("footer")]);
  const root = new VStack([line("transcript"), dock]);
  const extracted = extractExtensionWidgetDock(root);
  assert.deepEqual(extracted.widgets, [above, below]);
  assert.doesNotMatch(extracted.mainRoot.render(80).join("\n"), /TODO WIDGET|BELOW WIDGET/);
  assert.match(extracted.widgets.flatMap((widget) => widget.render(80)).join("\n"), /TODO WIDGET/);
});

test("split restores responsive panel width and publishes resize state", () => {
  const term = terminal(160, 40);
  const tui = new TuiAltScreen(term);
  const editor = focusable();
  tui.setLayoutRoot(new VStack([editor, component()]));
  tui.setFocus(editor);
  const patches: unknown[] = [];
  const controller = new SplitPanelController(tui, {
    git: new GitStateController(async () => ({ stdout: "", stderr: "", code: 1, killed: false }), "/repo", 0),
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    getSettings: () => DEFAULT_SETTINGS,
    theme: theme as any,
    workspaceState: { panelWidthPercent: 44 },
    onWorkspaceStateChange: (patch) => patches.push(patch),
    onAction: () => {},
  });
  assert.equal(controller.ensure(), true);
  assert.match(controller.diagnostic, /panel 70 cols/);
  controller.focus();
  (tui as any).handleTerminalInput("]");
  assert.match(controller.diagnostic, /panel 74 cols/);
  assert.deepEqual(patches.at(-1), { panelWidthPercent: 46 });
  (tui as any).handleTerminalInput("0");
  assert.deepEqual(patches.at(-1), { panelWidthPercent: undefined });
  controller.dispose();
});

test("fullscreen split wraps and restores Pi's existing layout root", () => {
  const tui = new TuiAltScreen(terminal(), false, "/tmp");
  const originalRoot = component();
  const editor = focusable();
  tui.setLayoutRoot(originalRoot);
  tui.setFocus(editor);
  const settings = cloneSettings(DEFAULT_SETTINGS);
  const git = new GitStateController(async () => ({ stdout: "", stderr: "", code: 128, killed: false }), "/repo");
  const controller = new SplitPanelController(tui, {
    git,
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getSettings: () => settings,
    theme: theme as any,
    header: { render: (width) => ["header".padEnd(width), "─".repeat(width)], invalidate: () => {} },
    footer: { render: (width) => ["─".repeat(width), "footer".padEnd(width)], invalidate: () => {} },
    onAction: () => {},
  });

  assert.equal(controller.ensure(), true);
  assert.equal(controller.installed, true);
  assert.match(controller.diagnostic, /split active \(160 cols\)/);
  assert.ok((tui as any).layoutRoot instanceof VStack);
  const splitLines = ((tui as any).layoutRoot as VStack).render(160);
  const initialTitleColumn = splitLines.find((line) => line.includes("GIT EXPLORER"))?.indexOf("GIT EXPLORER") ?? -1;
  assert.ok(initialTitleColumn > 40, "Explorer must render beside, not over, the main root");
  (tui as any).handleTerminalInput("\x1b[<0;109;3M");
  assert.notEqual(tui.getFocusedComponent(), editor, "clicking inside the sidebar must focus it");

  (tui as any).handleTerminalInput("]");
  const keyboardTitleColumn = ((tui as any).layoutRoot as VStack).render(160).find((line) => line.includes("GIT EXPLORER"))?.indexOf("GIT EXPLORER") ?? -1;
  assert.ok(keyboardTitleColumn < initialTitleColumn, "] must enlarge the focused sidebar");
  assert.match(controller.diagnostic, /panel 58 cols/);
  (tui as any).handleTerminalInput("0");
  assert.match(controller.diagnostic, /panel 54 cols/);

  (tui as any).handleTerminalInput("\x1b[<0;107;3M");
  (tui as any).handleTerminalInput("\x1b[<32;91;3M");
  (tui as any).handleTerminalInput("\x1b[<0;91;3m");
  const draggedTitleColumn = ((tui as any).layoutRoot as VStack).render(160).find((line) => line.includes("GIT EXPLORER"))?.indexOf("GIT EXPLORER") ?? -1;
  assert.ok(draggedTitleColumn < initialTitleColumn, "dragging the divider left must enlarge the sidebar");
  assert.match(((tui as any).layoutRoot as VStack).render(160).join("\n"), /70 cols/);
  assert.match(controller.diagnostic, /panel 70 cols/);
  const focusedPanel = tui.getFocusedComponent();
  (tui as any).handleTerminalInput("\x1b[<0;21;11M");
  assert.equal(tui.getFocusedComponent(), focusedPanel, "transcript text clicks must preserve panel focus and selection behavior");
  (tui as any).handleTerminalInput("\x1b[<0;21;26M");
  assert.equal(tui.getFocusedComponent(), editor, "clicking the prompt region must restore editor focus");
  (tui as any).handleTerminalInput("\x1b[<0;94;4M");
  assert.notEqual(tui.getFocusedComponent(), editor);
  (tui.getFocusedComponent() as any).handleInput("q");
  assert.equal(tui.getFocusedComponent(), editor);
  assert.equal(controller.installed, true);

  controller.dispose();
  assert.equal((tui as any).layoutRoot, originalRoot);
  git.dispose();
});

test("split stays disabled for overlay preference and narrow terminals", () => {
  const tui = new TuiAltScreen(terminal(90), false, "/tmp");
  const originalRoot = component();
  tui.setLayoutRoot(originalRoot);
  const settings = cloneSettings(DEFAULT_SETTINGS);
  const git = new GitStateController(async () => ({ stdout: "", stderr: "", code: 128, killed: false }), "/repo");
  const controller = new SplitPanelController(tui, {
    git,
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getSettings: () => settings,
    theme: theme as any,
    onAction: () => {},
  });

  assert.equal(controller.ensure(), false);
  assert.match(controller.diagnostic, /90 < 100 cols/);
  (tui.terminal as any).columns = 160;
  settings.explorer.layout = "overlay";
  assert.equal(controller.ensure(), false);
  assert.equal((tui as any).layoutRoot, originalRoot);
  controller.dispose();
  git.dispose();
});
