import { getLineStats, getRepoState, type GitExec } from "./git/git.ts";
import type { LineStats, RepoState } from "./git/types.ts";

export type GitViewState =
  | { kind: "loading"; previous?: GitReadyState }
  | GitReadyState
  | { kind: "error"; message: string };
export type GitReadyState =
  | { kind: "none" }
  | { kind: "repo"; root: string; status: Extract<RepoState, { kind: "repo" }>["status"]; working: LineStats; cached: LineStats };

export class GitStateController {
  state: GitViewState = { kind: "loading" };
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly exec: GitExec;
  private readonly cwd: string;
  private readonly debounceMs: number;

  constructor(exec: GitExec, cwd: string, debounceMs = 75) {
    this.exec = exec;
    this.cwd = cwd;
    this.debounceMs = debounceMs;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  schedule(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), this.debounceMs);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = ++this.generation;
    const previous = this.state.kind === "repo" || this.state.kind === "none" ? this.state : undefined;
    this.setState(previous ? { kind: "loading", previous } : { kind: "loading" });
    try {
      const repo = await getRepoState(this.exec, this.cwd, { signal: abort.signal });
      if (repo.kind === "none") return this.finish(generation, abort, { kind: "none" });
      const [working, cached] = await Promise.all([
        getLineStats(this.exec, repo.root, "working", { signal: abort.signal }),
        getLineStats(this.exec, repo.root, "cached", { signal: abort.signal }),
      ]);
      this.finish(generation, abort, { ...repo, working, cached });
    } catch (error) {
      if (!this.disposed && !abort.signal.aborted && generation === this.generation) {
        abort.abort();
        this.abort = undefined;
        this.setState({ kind: "error", message: (error as Error).message });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.listeners.clear();
    this.generation++;
  }

  private finish(generation: number, abort: AbortController, state: GitViewState): void {
    if (this.disposed || abort.signal.aborted || generation !== this.generation) return;
    this.abort = undefined;
    this.setState(state);
  }

  private setState(state: GitViewState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
