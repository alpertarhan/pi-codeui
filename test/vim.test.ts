import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRepoFile, runExternalEditor } from "../src/external-editor.ts";
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
