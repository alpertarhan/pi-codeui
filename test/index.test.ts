import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codeui from "../src/index.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) assert.fail("condition not reached before timeout");
    await delay(20);
  }
}

async function themeProject(t: { after: (callback: () => Promise<void>) => void }, theme: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-theme-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "codeui.settings.json"), JSON.stringify({ appearance: { theme } }));
  return root;
}

function extension() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const markdownTransformers: Array<(markdown: string, context: any) => string> = [];
  let gitCalls = 0;
  const execCalls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerShortcut: (key: string, shortcut: unknown) => shortcuts.set(key, shortcut),
    registerMarkdownTransformer: (transformer: (markdown: string, context: any) => string) => markdownTransformers.push(transformer),
    exec: async (command: string, args: string[], options?: Record<string, unknown>) => {
      gitCalls++;
      execCalls.push({ command, args, options });
      if (args[0] === "rev-parse") return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
      if (args[0] === "status") return { stdout: "## main\0 M file.ts\0", stderr: "", code: 0, killed: false };
      if (args[0] === "-c") return { stdout: "/repo/src/rerun.ts(7,8): error TS1: rerun failed", stderr: "", code: 2, killed: false };
      return { stdout: "1\t0\tfile.ts\0", stderr: "", code: 0, killed: false };
    },
  };
  codeui(pi as unknown as ExtensionAPI);
  return { handlers, commands, shortcuts, markdownTransformers, execCalls, get gitCalls() { return gitCalls; } };
}

function context(mode: string, overrides: Record<string, unknown> = {}) {
  const widgets: Array<[string, unknown, unknown]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: string[] = [];
  const customOptions: unknown[] = [];
  const headers: unknown[] = [];
  const footers: unknown[] = [];
  const themes: string[] = [];
  const editorComponents: unknown[] = [];
  let editorComponent: unknown;
  const theme = {
    name: "host-theme",
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    cwd: process.cwd(), mode, hasUI: mode === "tui" || mode === "rpc",
    isProjectTrusted: () => false,
    sessionManager: {
      getBranch: () => [],
      getSessionName: () => undefined,
    },
    ui: {
      theme,
      setTheme: (name: string) => { themes.push(name); theme.name = name; return { success: true }; },
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
  return { ctx, widgets, statuses, notifications, customOptions, headers, footers, themes, editorComponents };
}

test("commands and shortcut register; doctor is safe outside TUI", async () => {
  const ext = extension();
  assert.deepEqual([...ext.commands.keys()], ["codeui", "codeui-reset-workspace", "codeui-refresh", "codeui-vim", "codeui-doctor"]);
  for (const event of ["turn_start", "message_end", "session_info_changed", "session_compact", "session_tree", "tool_execution_start", "tool_execution_update", "tool_execution_end"]) assert.ok(ext.handlers.has(event), `${event} handler missing`);
  assert.ok(ext.shortcuts.has("ctrl+shift+g"));
  assert.equal(ext.markdownTransformers.length, 1);
  assert.equal(ext.markdownTransformers[0]!("Hello", { messageType: "assistant", isStreaming: true, availableWidth: 80 }), "Hello", "non-TUI sessions must retain native output");

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
  assert.deepEqual(tui.themes, [], "inherit startup must preserve the host theme");
  assert.equal(typeof tui.headers.at(-1), "function");
  assert.equal(typeof tui.footers.at(-1), "function");
  assert.match(ext.markdownTransformers[0]!("Hello", { messageType: "assistant", isStreaming: true, availableWidth: 80 }), /Pi.*working/);

  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  assert.ok(tui.widgets.some(([key, value]) => key === "pi-codeui.changes" && value === undefined));
  assert.ok(tui.statuses.some(([key, value]) => key === "pi-codeui.git" && value === undefined));
  assert.ok(tui.statuses.some(([key, value]) => key === "pi-codeui.settings" && value === undefined));
});

test("theme settings transition without redundant host mutations", async (t) => {
  const root = await themeProject(t, "inherit");
  const ext = extension();
  const tui = context("tui", { cwd: root, isProjectTrusted: () => true });
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  assert.deepEqual(tui.themes, []);

  const settingsPath = join(root, ".pi", "codeui.settings.json");
  await writeFile(settingsPath, JSON.stringify({ appearance: { theme: "codeui-midnight" } }));
  await eventually(() => tui.themes.length === 1);
  await writeFile(settingsPath, JSON.stringify({ appearance: { theme: "codeui-midnight" }, widget: { maxFiles: 5 } }));
  await eventually(() => tui.notifications.filter((message) => message.includes("settings reloaded")).length >= 2);
  assert.deepEqual(tui.themes, ["codeui-midnight"], "unrelated reload must not reapply an owned theme");

  await writeFile(settingsPath, JSON.stringify({ appearance: { theme: "other-theme" } }));
  await eventually(() => tui.themes.length === 2);
  await writeFile(settingsPath, JSON.stringify({ appearance: { theme: "inherit" } }));
  await eventually(() => tui.themes.length === 3);
  assert.deepEqual(tui.themes, ["codeui-midnight", "other-theme", "host-theme"]);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  assert.equal(tui.themes.length, 3);
});

test("session replacement and disposal restore the captured host theme before recapture", async (t) => {
  const root = await themeProject(t, "codeui-midnight");
  const ext = extension();
  const first = context("tui", { cwd: root, isProjectTrusted: () => true });
  await ext.handlers.get("session_start")?.({}, first.ctx);

  const second = context("tui", { cwd: root, isProjectTrusted: () => true, ui: (first.ctx as any).ui });
  await ext.handlers.get("session_start")?.({}, second.ctx);
  await ext.handlers.get("session_shutdown")?.({}, second.ctx);
  assert.deepEqual(first.themes, ["codeui-midnight", "host-theme", "codeui-midnight", "host-theme"]);
});

test("external theme changes relinquish ownership and failed themes are never owned", async (t) => {
  const root = await themeProject(t, "codeui-midnight");
  const ext = extension();
  const tui = context("tui", { cwd: root, isProjectTrusted: () => true });
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  (tui.ctx as any).ui.theme.name = "external-theme";
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
  assert.deepEqual(tui.themes, ["codeui-midnight"]);
  assert.equal((tui.ctx as any).ui.theme.name, "external-theme");

  const failedExt = extension();
  const failed = context("tui", { cwd: root, isProjectTrusted: () => true });
  (failed.ctx as any).ui.setTheme = (name: string) => { failed.themes.push(name); return { success: false, error: "missing theme" }; };
  await failedExt.handlers.get("session_start")?.({}, failed.ctx);
  await failedExt.handlers.get("session_shutdown")?.({}, failed.ctx);
  assert.deepEqual(failed.themes, ["codeui-midnight"]);
  assert.equal((failed.ctx as any).ui.theme.name, "host-theme");
  assert.ok(failed.notifications.some((message) => message.includes("pi-codeui theme: missing theme")));
});

test("session start hydrates the active branch before the workspace is installed", async () => {
  const ext = extension();
  let branchReads = 0;
  const branch = [
    { type: "message", id: "u", parentId: null, timestamp: "2026-03-10T12:00:00.000Z", message: { role: "user", content: "Fix it", timestamp: 1_000 } },
    { type: "message", id: "a", parentId: "u", timestamp: "2026-03-10T12:00:01.000Z", message: { role: "assistant", content: [
      { type: "text", text: "Applying the persisted fix." },
      { type: "toolCall", id: "persisted-edit", name: "edit", arguments: { path: "src/resumed.ts", edits: [] } },
      { type: "toolCall", id: "persisted-check", name: "bash", arguments: { command: "npm test" } },
    ], timestamp: 2_000 } },
    { type: "message", id: "r-edit", parentId: "a", timestamp: "2026-03-10T12:00:02.000Z", message: { role: "toolResult", toolCallId: "persisted-edit", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3_000 } },
    { type: "message", id: "r-check", parentId: "r-edit", timestamp: "2026-03-10T12:00:03.000Z", message: { role: "toolResult", toolCallId: "persisted-check", toolName: "bash", content: [{ type: "text", text: "1 test failed" }], isError: true, timestamp: 4_000 } },
  ];
  const tui = context("tui", { sessionManager: { getBranch: () => { branchReads++; return branch; }, getSessionName: () => undefined } });
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  await ext.commands.get("codeui-doctor").handler("", tui.ctx);

  assert.equal(branchReads, 1);
  assert.match(tui.notifications.at(-1) ?? "", /Activity: 2 records/);
  assert.match(tui.notifications.at(-1) ?? "", /Latest request: 1 edited · 1 check · 1 failed/);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
});

test("agent lifecycle scopes review across multiple turns and resets on the next request", async () => {
  const ext = extension();
  const tui = context("tui");
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  const noticesBefore = tui.notifications.length;

  ext.handlers.get("agent_start")?.({}, tui.ctx);
  ext.handlers.get("turn_start")?.({}, tui.ctx);
  ext.handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "src/request.ts", edits: [] } }, tui.ctx);
  ext.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", result: {}, isError: false }, tui.ctx);
  ext.handlers.get("turn_start")?.({}, tui.ctx);
  ext.handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "lint", toolName: "bash", args: { command: "npm run typecheck" } }, tui.ctx);
  ext.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "lint", toolName: "bash", result: {}, isError: true }, tui.ctx);
  ext.handlers.get("agent_end")?.({}, tui.ctx);
  assert.equal(tui.notifications.length, noticesBefore, "request completion must not create a toast");

  await ext.commands.get("codeui-doctor").handler("", tui.ctx);
  assert.match(tui.notifications.at(-1) ?? "", /Latest request: 1 edited · 1 check · 1 failed/);

  ext.handlers.get("agent_start")?.({}, tui.ctx);
  ext.handlers.get("turn_start")?.({}, tui.ctx);
  ext.handlers.get("agent_settled")?.({}, tui.ctx);
  await ext.commands.get("codeui-doctor").handler("", tui.ctx);
  assert.match(tui.notifications.at(-1) ?? "", /Latest request: 0 edited · 0 checks · 0 failed/);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
});

test("Checks rerun integration uses direct shell argv, original cwd/timeout, and completes Activity", async () => {
  const ext = extension();
  const tui = context("tui");
  const confirmations: string[] = [];
  (tui.ctx as any).ui.confirm = async (_title: string, message: string) => { confirmations.push(message); return true; };
  await ext.handlers.get("session_start")?.({}, tui.ctx);
  const raw = "npm run typecheck -- --exact='a b'";
  ext.handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "original-check", toolName: "bash", args: { command: raw, timeout: 17 } }, tui.ctx);
  ext.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "original-check", toolName: "bash", result: { content: [{ type: "text", text: "src/original.ts(1,2): error TS1: original" }] }, isError: true }, tui.ctx);

  let expectedShellCalls = 1;
  (tui.ctx as any).ui.custom = async (factory: any) => {
    const explorer = factory({ requestRender: () => {} }, (tui.ctx as any).ui.theme, {}, () => {});
    explorer.handleInput("c");
    explorer.handleInput("r");
    for (let index = 0; index < 20 && ext.execCalls.filter(({ args }) => args[0] === "-c").length < expectedShellCalls; index++) await delay(0);
    explorer.dispose();
  };
  await ext.commands.get("codeui").handler("", tui.ctx);

  const call = ext.execCalls.find(({ args }) => args[0] === "-c");
  assert.ok(call);
  assert.match(call.command, /^(?:\/bin\/bash|bash)$/);
  assert.deepEqual(call.args, ["-c", raw]);
  assert.deepEqual(call.options, { cwd: process.cwd(), timeout: 17_000 });
  assert.match(confirmations[0] ?? "", /Timeout: 17s/);

  const invalidRaw = "npm run typecheck -- --invalid-timeout";
  ext.handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolCallId: "invalid-timeout-check", toolName: "bash", args: { command: invalidRaw, timeout: Number.NaN } }, tui.ctx);
  ext.handlers.get("tool_execution_end")?.({ type: "tool_execution_end", toolCallId: "invalid-timeout-check", toolName: "bash", result: { content: [{ type: "text", text: "/repo/src/invalid.ts(1,1): error TS1: invalid" }] }, isError: true }, tui.ctx);
  expectedShellCalls = 2;
  await ext.commands.get("codeui").handler("", tui.ctx);
  const invalidCall = ext.execCalls.filter(({ args }) => args[0] === "-c")[1];
  assert.deepEqual(invalidCall?.args, ["-c", invalidRaw]);
  assert.deepEqual(invalidCall?.options, { cwd: process.cwd() });
  assert.match(confirmations[1] ?? "", /Timeout: default/);
  await ext.commands.get("codeui-doctor").handler("", tui.ctx);
  assert.match(tui.notifications.at(-1) ?? "", /Activity: 4 records · 2 problems · error bash/);
  await ext.handlers.get("session_shutdown")?.({}, tui.ctx);
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
