import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HStack,
  isViewportTUI,
  type Component,
  type TUI,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import type { GitExec } from "./git/git.ts";
import { GitExplorer, type GitExplorerResult } from "./git-explorer.ts";
import type { GitStateController } from "./git-state.ts";
import type { CodeuiSettings } from "./settings.ts";

type InternalViewportTui = ViewportTUI & {
  layoutRoot?: Component;
  getFocusedComponent?: () => Component | null;
};

export interface SplitPanelOptions {
  git: GitStateController;
  exec: GitExec;
  getSettings: () => Readonly<CodeuiSettings>;
  theme: Theme;
  onAction: (result: Exclude<GitExplorerResult, undefined>) => void;
}

const percentage = (value: `${number}%`): number => Number.parseInt(value, 10) / 100;

/**
 * Experimental Pi 0.84 adapter. ViewportTUI exposes setLayoutRoot but not the
 * current root, so fullscreen split mode reads the renderer's internal
 * `layoutRoot` field. All mutations are identity-checked and restored.
 */
export class SplitPanelController {
  private readonly tui: TUI;
  private readonly options: SplitPanelOptions;
  private originalRoot: Component | undefined;
  private splitRoot: HStack | undefined;
  private panel: GitExplorer | undefined;
  private previousFocus: Component | null = null;
  private panelColumns = 0;
  private disposed = false;

  constructor(tui: TUI, options: SplitPanelOptions) {
    this.tui = tui;
    this.options = options;
  }

  get installed(): boolean {
    if (!isViewportTUI(this.tui) || !this.splitRoot) return false;
    return (this.tui as InternalViewportTui).layoutRoot === this.splitRoot;
  }

  ensure(): boolean {
    if (this.disposed) return false;
    const settings = this.options.getSettings().explorer;
    const eligible = settings.layout === "split"
      && this.tui.mode === "fullscreen"
      && this.tui.terminal.columns >= settings.minOverlayColumns
      && isViewportTUI(this.tui);
    if (!eligible) {
      this.restore();
      return false;
    }

    const internal = this.tui as InternalViewportTui;
    if (this.installed) {
      const columns = this.getPanelColumns();
      if (columns !== this.panelColumns) this.mount(this.originalRoot!, this.panel!, columns);
      return true;
    }

    const currentRoot = internal.layoutRoot;
    if (!currentRoot) return false;
    this.originalRoot = currentRoot;
    this.panel = this.createPanel();
    this.mount(currentRoot, this.panel, this.getPanelColumns());
    return true;
  }

  focus(): boolean {
    if (!this.ensure() || !this.panel) return false;
    const internal = this.tui as InternalViewportTui;
    this.previousFocus = internal.getFocusedComponent?.() ?? null;
    this.tui.setFocus(this.panel);
    this.tui.requestRender();
    return true;
  }

  settingsChanged(): void {
    if (!this.ensure()) return;
    this.panel?.settingsChanged();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore();
    this.disposed = true;
  }

  private createPanel(): GitExplorer {
    return new GitExplorer(
      this.options.git,
      this.options.exec,
      this.options.getSettings,
      this.options.theme,
      () => this.tui.requestRender(),
      (result) => this.deactivate(result),
      { embedded: true },
    );
  }

  private deactivate(result?: GitExplorerResult): void {
    if (this.disposed) return;
    this.panel?.dispose();
    this.panel = this.createPanel();
    if (this.originalRoot && isViewportTUI(this.tui)) {
      this.mount(this.originalRoot, this.panel, this.getPanelColumns());
    }
    this.tui.setFocus(this.previousFocus);
    this.previousFocus = null;
    this.tui.requestRender();
    if (result) queueMicrotask(() => this.options.onAction(result));
  }

  private mount(originalRoot: Component, panel: GitExplorer, panelColumns: number): void {
    if (!isViewportTUI(this.tui)) return;
    this.panelColumns = panelColumns;
    this.splitRoot = new HStack([
      { component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 40 },
      { component: panel, basis: panelColumns, grow: 0, shrink: 1, minSize: 30, maxSize: panelColumns },
    ]);
    this.tui.setLayoutRoot(this.splitRoot);
  }

  private getPanelColumns(): number {
    const settings = this.options.getSettings().explorer;
    const requested = Math.round(this.tui.terminal.columns * percentage(settings.splitWidth));
    return Math.max(30, Math.min(72, requested));
  }

  private restore(): void {
    this.panel?.dispose();
    this.panel = undefined;
    if (this.originalRoot && this.splitRoot && isViewportTUI(this.tui)) {
      const internal = this.tui as InternalViewportTui;
      if (internal.layoutRoot === this.splitRoot) this.tui.setLayoutRoot(this.originalRoot);
    }
    this.originalRoot = undefined;
    this.splitRoot = undefined;
    this.panelColumns = 0;
    this.previousFocus = null;
  }
}
