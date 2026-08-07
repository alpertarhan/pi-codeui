import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ExternalEditorResult {
  status: number | null;
  error?: string;
}

export interface EditorPosition {
  line: number;
  column?: number;
}

export interface QuickfixEntry extends EditorPosition {
  path: string;
  message: string;
  severity?: "error" | "warning" | "info";
}

type SpawnEditor = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

export function resolveRepoFile(root: string, repoPath: string): string {
  const absolute = resolve(root, repoPath);
  const fromRoot = relative(root, absolute);
  if (!repoPath || fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error("Refusing to open a path outside the repository");
  }
  return absolute;
}

export function runExternalEditor(
  command: readonly string[],
  root: string,
  repoPath: string,
  spawn: SpawnEditor = spawnSync,
  position?: EditorPosition,
): ExternalEditorResult {
  const [binary, ...baseArgs] = command;
  if (!binary) return { status: null, error: "No external editor command configured" };

  let absolute: string;
  try {
    absolute = resolveRepoFile(root, repoPath);
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }

  const vimPosition = position && /(?:^|[/\\])(?:n?vim)$/.test(binary)
    ? [`+call cursor(${Math.max(1, Math.floor(position.line))},${Math.max(1, Math.floor(position.column ?? 1))})`]
    : [];
  const result = spawn(binary, [...baseArgs, ...vimPosition, "--", absolute], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  return {
    status: result.status,
    error: result.error?.message,
  };
}

export async function runExternalQuickfix(
  command: readonly string[],
  root: string,
  entries: readonly QuickfixEntry[],
  spawn: SpawnEditor = spawnSync,
): Promise<ExternalEditorResult> {
  const [binary, ...baseArgs] = command;
  if (!binary) return { status: null, error: "No external editor command configured" };
  if (!/(?:^|[/\\])(?:n?vim)$/.test(binary)) return { status: null, error: "Workspace quickfix requires Vim or Neovim" };
  if (!entries.length) return { status: null, error: "No workspace locations available for quickfix" };

  let quickfix: Array<{ filename: string; lnum: number; col: number; text: string; type: string; valid: number }>;
  try {
    quickfix = entries.map((entry) => ({
      filename: resolveRepoFile(root, entry.path),
      lnum: Math.max(1, Math.floor(entry.line)),
      col: Math.max(1, Math.floor(entry.column ?? 1)),
      text: entry.message.replace(/[\r\n\0]+/g, " ").slice(0, 500),
      type: entry.severity === "warning" ? "W" : entry.severity === "info" ? "I" : "E",
      valid: 1,
    }));
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }

  const directory = await mkdtemp(join(tmpdir(), "pi-codeui-qf-"));
  const listPath = join(directory, "quickfix.json");
  try {
    await writeFile(listPath, JSON.stringify(quickfix), { encoding: "utf8", mode: 0o600 });
    const escapedPath = listPath.replace(/'/g, "''");
    const load = `call setqflist(json_decode(join(readfile('${escapedPath}'), "\\n")), 'r')`;
    const result = spawn(binary, [...baseArgs, "--cmd", load, "-c", "copen", "-c", "cc"], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    return { status: result.status, error: result.error?.message };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function openExternalQuickfix(
  ctx: ExtensionContext,
  command: readonly string[],
  root: string,
  entries: readonly QuickfixEntry[],
): Promise<ExternalEditorResult> {
  return ctx.ui.custom<ExternalEditorResult>((tui, _theme, _keybindings, done) => {
    tui.stop();
    void runExternalQuickfix(command, root, entries)
      .catch((error) => ({ status: null, error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        tui.start();
        tui.requestRender(true);
        done(result);
      });
    return { render: () => [], invalidate: () => {} };
  });
}

export async function openExternalEditor(
  ctx: ExtensionContext,
  command: readonly string[],
  root: string,
  repoPath: string,
  position?: EditorPosition,
): Promise<ExternalEditorResult> {
  return ctx.ui.custom<ExternalEditorResult>((tui, _theme, _keybindings, done) => {
    tui.stop();
    let result: ExternalEditorResult;
    try {
      result = runExternalEditor(command, root, repoPath, spawnSync, position);
    } catch (error) {
      result = { status: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      tui.start();
      tui.requestRender(true);
    }
    done(result!);
    return { render: () => [], invalidate: () => {} };
  });
}
