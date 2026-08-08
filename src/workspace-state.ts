import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WORKSPACE_STATE_FILE_NAME = "codeui.workspace-state.json";
const VERSION = 1;
const MAX_WORKSPACES = 100;

export type PersistedExplorerScope = "working" | "staged";
export type PersistedWidgetDock = "auto" | "collapsed" | "expanded";

export interface WorkspaceUiState {
  panelWidthPercent?: number;
  scope?: PersistedExplorerScope;
  widgetDock?: PersistedWidgetDock;
}

type StoredWorkspace = WorkspaceUiState & { updatedAt: number };
type StateFile = { version: number; workspaces: Record<string, StoredWorkspace> };

const emptyFile = (): StateFile => ({ version: VERSION, workspaces: {} });
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T | undefined => typeof value === "string" && choices.includes(value as T) ? value as T : undefined;

function normalizeWorkspace(value: unknown): StoredWorkspace | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const panelWidthPercent = typeof raw.panelWidthPercent === "number" && Number.isFinite(raw.panelWidthPercent)
    ? Math.max(18, Math.min(70, Math.round(raw.panelWidthPercent)))
    : undefined;
  return {
    ...(panelWidthPercent === undefined ? {} : { panelWidthPercent }),
    ...(oneOf(raw.scope, ["working", "staged"] as const) ? { scope: oneOf(raw.scope, ["working", "staged"] as const) } : {}),
    ...(oneOf(raw.widgetDock, ["auto", "collapsed", "expanded"] as const) ? { widgetDock: oneOf(raw.widgetDock, ["auto", "collapsed", "expanded"] as const) } : {}),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

export class WorkspaceStateStore {
  readonly path: string;
  readonly warning: string | undefined;
  private state: StateFile;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(path = join(getAgentDir(), WORKSPACE_STATE_FILE_NAME), debounceMs = 250) {
    this.path = path;
    let state = emptyFile();
    let warning: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { version?: unknown }).version !== VERSION) throw new Error("unsupported or malformed workspace state");
      const workspaces = (raw as { workspaces?: unknown }).workspaces;
      if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) throw new Error("workspace map is missing");
      state = emptyFile();
      for (const [root, value] of Object.entries(workspaces)) {
        const normalized = normalizeWorkspace(value);
        if (normalized) state.workspaces[resolve(root)] = normalized;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = `${path}: ${(error as Error).message}`;
    }
    this.state = state;
    this.warning = warning;
    this.debounceMs = debounceMs;
  }

  private readonly debounceMs: number;

  get(root: string): Readonly<WorkspaceUiState> {
    const stored = this.state.workspaces[resolve(root)];
    if (!stored) return {};
    const { updatedAt: _updatedAt, ...state } = stored;
    return { ...state };
  }

  clear(root: string): void {
    const key = resolve(root);
    if (!(key in this.state.workspaces)) return;
    delete this.state.workspaces[key];
    this.markDirty();
  }

  update(root: string, patch: Partial<WorkspaceUiState>): void {
    const key = resolve(root);
    const previous = this.state.workspaces[key] ?? { updatedAt: 0 };
    const merged = normalizeWorkspace({ ...previous, ...patch, updatedAt: Date.now() });
    if (!merged) return;
    this.state.workspaces[key] = merged;
    this.prune();
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushSync(), this.debounceMs);
    this.timer.unref?.();
  }

  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    const directory = dirname(this.path);
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
      this.dirty = false;
    } catch {
      // Workspace state is optional; never break the interactive TUI for persistence.
    }
  }

  dispose(): void {
    this.flushSync();
  }

  private prune(): void {
    const entries = Object.entries(this.state.workspaces);
    if (entries.length <= MAX_WORKSPACES) return;
    entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    this.state.workspaces = Object.fromEntries(entries.slice(0, MAX_WORKSPACES));
  }
}
