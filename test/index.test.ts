import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codeui from "../src/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extension() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  let gitCalls = 0;
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: unknown) => shortcuts.set(key, shortcut),
    exec: async (_command: string, args: string[]) => {
      gitCalls++;
      if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      if (args[0] === "status") return { stdout: "## main\0 M file.ts\0", stderr: "", code: 0, killed: false };
      return { stdout: "1\t0\tfile.ts\0", stderr: "", code: 0, killed: false };
    },
  };
  codeui(pi as unknown as ExtensionAPI);
  return { handlers, commands, shortcuts, get gitCalls() { return gitCalls; } };
}

function context(mode: string, overrides: Record<string, unknown> = {}) {
  const widgets: Array<[string, unknown, unknown]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];
  const customOptions: unknown[] = [];
  const headers: unknown[] = [];
  const footers: unknown[] = [];
  const editorComponents: unknown[] = [];
  let editorComponent: unknown;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    cwd: process.cwd(), mode, hasUI: mode === "tui" || mode === "rpc",
    isProjectTrusted: () => false,
    ui: {
      theme,
      notify: (message: string) => notifications.push(message),
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      setWidget: (key: string, value: unknown, options?: unknown) => widgets.push([key, value, options]),
      setHeader: (value: unknown) => headers.push(value),
      setFooter: (value: unknown) => footers.push(value),
      getEditorComponent: () => editorComponent,
      setEditorComponent: (value: unknown) => { editorComponent = value; editorComponents.push(value); },
      custom: async (factory: any, options?: unknown) => {
        customOptions.push(options);
        let finish!: () => void;
        const done = () => finish();
        const result = new Promise<void>((resolve) => { finish = resolve; });
        const component = factory({ requestRender: () => {} }, theme, {}, done);
        component.dispose?.();
        done();
        return result;
      },
    },
    ...overrides,
  };
  return { ctx, widgets, statuses, notifications, customOptions, headers, footers, editorComponents };
}

test("commands and shortcut register; doctor is safe outside TUI", async () => {
  const ext = extension();
  assert.deepEqual([...ext.commands.keys()], ["codeui", "codeui-refresh", "codeui-vim", "codeui-doctor"]);
  assert.ok(ext.shortcuts.has("ctrl+shift+g"));

  const print = context("print");
  await ext.commands.get("codeui-doctor").handler("", print.ctx);
  assert.deepEqual(print.notifications, []);

  const tui = context("tui");
  await ext.commands.get("codeui-doctor").handler("", tui.ctx);
  assert.match(tui.notifications[0] ?? "", /Global config:/);
  assert.match(tui.notifications[0] ?? "", /Project config:.*untrusted\/ignored/);
  assert.match(tui.notifications[0] ?? "", /Glyph preset: nerd/);
  assert.match(tui.notifications[0] ?? "", /host terminal/);
});

test("lifecycle skips non-TUI resources, installs factory widget in TUI, and cleans unique keys", async () => {
  const ext = extension();
  const rpc = context("rpc");
  await ext.handlers.get("session_start")?.({}, rpc.ctx);
  assert.equal(ext.gitCalls, 0);
  assert.deepEqual(rpc.widgets, []);
  await ext.handlers.get("session_shutdown")?.({}, rpc.ctx);

  const tui = context("tui");
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  assert.ok(ext.gitCalls >= 4);
  const installed = tui.widgets.find(([key, value]) => key === "pi-codeui.changes" && typeof value === "function");
  assert.ok(installed);
  assert.deepEqual(installed?.[2], { placement: "aboveEditor" });

  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  assert.ok(tui.widgets.some(([key, value]) => key === "pi-codeui.changes" && value === undefined));
  assert.ok(tui.statuses.some(([key, value]) => key === "pi-codeui.git" && value === undefined));
  assert.ok(tui.statuses.some(([key, value]) => key === "pi-codeui.settings" && value === undefined));
});

test("Vim mode toggles for the session and restores the previous editor", async () => {
  const ext = extension();
  const tui = context("tui");
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  const chromeFactory = tui.editorComponents.at(-1);
  assert.equal(typeof chromeFactory, "function");

  await ext.commands.get("codeui-vim").handler("", tui.ctx);
  assert.equal(typeof tui.editorComponents.at(-1), "function");
  assert.notEqual(tui.editorComponents.at(-1), chromeFactory);
  assert.match(tui.notifications.at(-1) ?? "", /enabled/);

  await ext.commands.get("codeui-vim").handler("", tui.ctx);
  assert.equal(typeof tui.editorComponents.at(-1), "function");
  assert.match(tui.notifications.at(-1) ?? "", /disabled/);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  assert.equal(tui.editorComponents.at(-1), undefined);
});

test("session shutdown dismisses an open Explorer and resolves its command", async () => {
  const ext = extension();
  const tui = context("tui");
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  let overlay: any;
  let closes = 0;
  (tui.ctx as any).ui.custom = (factory: any) => new Promise<void>((resolve) => {
    overlay = factory({ requestRender: () => {} }, (tui.ctx as any).ui.theme, {}, () => { closes++; resolve(); });
  });

  const command = ext.commands.get("codeui").handler("", tui.ctx);
  for (let i = 0; i < 10 && !overlay; i++) await delay(0);
  assert.ok(overlay);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  await Promise.race([command, delay(250).then(() => assert.fail("Explorer command did not resolve"))]);
  assert.equal(closes, 1);
});

test("refresh events filter tools and explorer uses responsive overlay mode", async () => {
  const ext = extension();
  const tui = context("tui");
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  const initial = ext.gitCalls;
  ext.handlers.get("tool_result")?.({ toolName: "read", isError: false }, tui.ctx);
  await delay(100);
  assert.equal(ext.gitCalls, initial);
  ext.handlers.get("tool_result")?.({ toolName: "bash", isError: true }, tui.ctx);
  ext.handlers.get("tool_result")?.({ toolName: "edit", isError: false }, tui.ctx);
  await delay(100);
  assert.equal(ext.gitCalls, initial + 4);
  ext.handlers.get("agent_settled")?.({}, tui.ctx);
  await delay(100);
  assert.equal(ext.gitCalls, initial + 8);

  const original = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 120 });
  await ext.commands.get("codeui").handler("", tui.ctx);
  assert.deepEqual(tui.customOptions.at(-1), { overlay: true, overlayOptions: { width: "52%", maxHeight: "85%", anchor: "right-center" } });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: 80 });
  await ext.commands.get("codeui").handler("", tui.ctx);
  assert.equal(tui.customOptions.at(-1), undefined);
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: original });

  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
});
