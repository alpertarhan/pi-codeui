import assert from "node:assert/strict";
import test from "node:test";
import { HStack, TuiAltScreen, type Component, type Terminal } from "@earendil-works/pi-tui";
import { GitStateController } from "../src/git-state.ts";
import { cloneSettings, DEFAULT_SETTINGS } from "../src/settings.ts";
import { SplitPanelController } from "../src/split-panel.ts";

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
    onAction: () => {},
  });

  assert.equal(controller.ensure(), true);
  assert.equal(controller.installed, true);
  assert.ok((tui as any).layoutRoot instanceof HStack);
  const splitLines = ((tui as any).layoutRoot as HStack).render(160);
  assert.ok((splitLines[1] ?? "").indexOf("Git Explorer") > 40, "Explorer must render beside, not over, the main root");
  assert.equal(controller.focus(), true);
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
  (tui.terminal as any).columns = 160;
  settings.explorer.layout = "overlay";
  assert.equal(controller.ensure(), false);
  assert.equal((tui as any).layoutRoot, originalRoot);
  controller.dispose();
  git.dispose();
});
