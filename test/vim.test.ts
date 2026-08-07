import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRepoFile, runExternalEditor, runExternalQuickfix } from "../src/external-editor.ts";
import { VimEditor } from "../src/vim-editor.ts";

const keyMap: Record<string, string[]> = {
  "app.interrupt": ["\x1b"],
  "tui.editor.cursorLeft": ["\x1b[D"],
  "tui.editor.cursorRight": ["\x1b[C"],
  "tui.editor.cursorUp": ["\x1b[A"],
  "tui.editor.cursorDown": ["\x1b[B"],
  "tui.editor.cursorLineStart": ["\x01"],
  "tui.editor.cursorLineEnd": ["\x05"],
  "tui.editor.cursorWordLeft": ["\x1bb"],
  "tui.editor.cursorWordRight": ["\x1bf"],
  "tui.editor.deleteCharForward": ["\x1b[3~"],
};

const keybindings = {
  matches: (data: string, action: string) => keyMap[action]?.includes(data) ?? false,
};

const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {},
};

test("Vim editor switches modes, ignores normal text, and maps core motions", () => {
  let renders = 0;
  const editor = new VimEditor(
    { requestRender: () => { renders++; }, terminal: { rows: 24, columns: 80 } } as any,
    editorTheme as any,
    keybindings as any,
    { startMode: "normal" },
  );
  editor.setText("alpha beta");
  editor.handleInput("0");
  editor.handleInput("x");
  assert.equal(editor.getText(), "lpha beta");

  editor.handleInput("Q");
  editor.handleInput("PASTED TEXT");
  assert.equal(editor.getText(), "lpha beta");
  editor.handleInput("i");
  editor.handleInput("Z");
  assert.equal(editor.getMode(), "insert");
  assert.equal(editor.getText(), "Zlpha beta");

  editor.handleInput("\x1b");
  assert.equal(editor.getMode(), "normal");
  assert.ok(renders >= 2);
  const lines = editor.render(40);
  assert.match(lines.at(-1) ?? "", /NORMAL/);
});

test("Neovim quickfix bridge loads repo-contained JSON and cleans it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-qf-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let listPath = "";
  let entries: unknown;
  let invocation: { command: string; args: readonly string[] } | undefined;
  const result = await runExternalQuickfix(["nvim", "-f"], root, [
    { path: "src/app.ts", line: 12, column: 5, message: "Wrong type", severity: "error" },
    { path: "test/app.test.ts", line: 3, message: "Expected true", severity: "warning" },
  ], (command, args) => {
    invocation = { command, args };
    const load = args[args.indexOf("--cmd") + 1] ?? "";
    listPath = /readfile\('([^']+)'\)/.exec(load)?.[1] ?? "";
    entries = JSON.parse(readFileSync(listPath, "utf8"));
    return { status: 0 };
  });
  assert.equal(result.status, 0);
  assert.equal(invocation?.command, "nvim");
  assert.deepEqual(invocation?.args.slice(-4), ["-c", "copen", "-c", "cc"]);
  assert.deepEqual(entries, [
    { filename: join(root, "src/app.ts"), lnum: 12, col: 5, text: "Wrong type", type: "E", valid: 1 },
    { filename: join(root, "test/app.test.ts"), lnum: 3, col: 1, text: "Expected true", type: "W", valid: 1 },
  ]);
  assert.equal(existsSync(listPath), false);
  assert.match((await runExternalQuickfix(["nvim"], root, [])).error ?? "", /No workspace locations/);
  assert.match((await runExternalQuickfix(["code"], root, [{ path: "src/app.ts", line: 1, message: "changed" }])).error ?? "", /requires Vim or Neovim/);
  assert.match((await runExternalQuickfix(["nvim"], root, [{ path: "../outside", line: 1, message: "bad" }])).error ?? "", /outside the repository/);
});

test("non-modal CodeUI editor preserves normal typing and shows prompt chrome", () => {
  const editor = new VimEditor(
    { requestRender: () => {}, terminal: { rows: 24, columns: 80 } } as any,
    editorTheme as any,
    keybindings as any,
    { startMode: "insert", modal: false, label: "PROMPT", styleBorder: (_mode, text) => `SAFE${text}` },
  );
  editor.borderColor = (text) => `RED${text}`;
  editor.setText("hello");
  editor.handleInput("!");
  assert.equal(editor.getText(), "hello!");
  const rendered = editor.render(40).join("\n");
  assert.match(rendered, /PROMPT/);
  assert.match(rendered, /SAFE/);
  assert.doesNotMatch(rendered, /RED/);
});

test("external editor argv is shell-free and repository-contained", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-codeui-editor-"));
  try {
    let invocation: { command: string; args: readonly string[]; cwd: string } | undefined;
    const result = runExternalEditor(["nvim", "-f"], root, "-strange name.ts", (command, args, options) => {
      invocation = { command, args, cwd: options.cwd };
      return { status: 0 };
    });
    assert.deepEqual(result, { status: 0, error: undefined });
    assert.equal(invocation?.command, "nvim");
    assert.deepEqual(invocation?.args, ["-f", "--", join(root, "-strange name.ts")]);
    assert.equal(invocation?.cwd, root);

    runExternalEditor(["nvim", "-f"], root, "src/app.ts", (command, args, options) => {
      invocation = { command, args, cwd: options.cwd };
      return { status: 0 };
    }, { line: 12, column: 5 });
    assert.deepEqual(invocation?.args, ["-f", "+call cursor(12,5)", "--", join(root, "src/app.ts")]);

    assert.throws(() => resolveRepoFile(root, "../outside.ts"), /outside the repository/);
    const rejected = runExternalEditor(["nvim"], root, "../outside.ts", () => {
      assert.fail("spawn must not run for an unsafe path");
    });
    assert.match(rejected.error ?? "", /outside the repository/);
    assert.equal(runExternalEditor([], root, "file.ts").error, "No external editor command configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
