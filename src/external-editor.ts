import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ExternalEditorResult {
  status: number | null;
  error?: string;
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
): ExternalEditorResult {
  const [binary, ...baseArgs] = command;
  if (!binary) return { status: null, error: "No external editor command configured" };

  let absolute: string;
  try {
    absolute = resolveRepoFile(root, repoPath);
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) };
  }

  const result = spawn(binary, [...baseArgs, "--", absolute], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  return {
    status: result.status,
    error: result.error?.message,
  };
}

export async function openExternalEditor(
  ctx: ExtensionContext,
  command: readonly string[],
  root: string,
  repoPath: string,
): Promise<ExternalEditorResult> {
  return ctx.ui.custom<ExternalEditorResult>((tui, _theme, _keybindings, done) => {
    tui.stop();
    let result: ExternalEditorResult;
    try {
      result = runExternalEditor(command, root, repoPath);
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
