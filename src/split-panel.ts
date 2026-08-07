import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HStack,
  VStack,
  isViewportTUI,
  type Component,
  type TUI,
  type TuiInputListener,
  type ViewportTUI,
} from "@earendil-works/pi-tui";
import type { ActivityTracker } from "./activity.ts";
import type { GitExec } from "./git/git.ts";
import { GitExplorer, type GitExplorerResult } from "./git-explorer.ts";
import type { GitStateController } from "./git-state.ts";
import type { CodeuiSettings } from "./settings.ts";

type InternalViewportTui = ViewportTUI & {
  layoutRoot?: Component;
  getFocusedComponent?: () => Component | null;
  inputListeners?: Set<TuiInputListener>;
};

type DisposableComponent = Component & { dispose?(): void };

export interface SplitPanelOptions {
  git: GitStateController;
  activity?: ActivityTracker;
  exec: GitExec;
  getSettings: () => Readonly<CodeuiSettings>;
  theme: Theme;
  header?: DisposableComponent;
  footer?: DisposableComponent;
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
  private splitRoot: Component | undefined;
  private panel: GitExplorer | undefined;
  private previousFocus: Component | null = null;
  private panelColumns = 0;
  private panelColumnsOverride: number | undefined;
  private resizing = false;
  private resizeNotice: string | undefined;
  private resizeNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastDividerPress = 0;
  private unsubscribeMouse: (() => void) | undefined;
  private disposed = false;

  constructor(tui: TUI, options: SplitPanelOptions) {
    this.tui = tui;
    this.options = options;
  }

  get installed(): boolean {
    if (!isViewportTUI(this.tui) || !this.splitRoot) return false;
    return (this.tui as InternalViewportTui).layoutRoot === this.splitRoot;
  }

  get diagnostic(): string {
    const settings = this.options.getSettings().explorer;
    if (this.installed) return `split active (${this.tui.terminal.columns} cols) · panel ${this.panelColumns} cols`;
    if (settings.layout !== "split") return "overlay configured";
    if (this.tui.mode !== "fullscreen") return `split fallback (TUI mode: ${this.tui.mode})`;
    if (this.tui.terminal.columns < settings.minOverlayColumns) {
      return `split fallback (${this.tui.terminal.columns} < ${settings.minOverlayColumns} cols)`;
    }
    if (!isViewportTUI(this.tui)) return "split fallback (viewport API unavailable)";
    return "split fallback (layout root unavailable)";
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
    this.installMouseListener();
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
    const current = internal.getFocusedComponent?.() ?? null;
    if (current !== this.panel) this.previousFocus = current;
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
    this.options.header?.dispose?.();
    this.options.footer?.dispose?.();
    this.disposed = true;
  }

  private installMouseListener(): void {
    if (this.unsubscribeMouse || !isViewportTUI(this.tui)) return;
    const listener: TuiInputListener = (data) => {
      if (!this.installed || !this.panel) return undefined;
      const internal = this.tui as InternalViewportTui;
      if (internal.getFocusedComponent?.() === this.panel) {
        if (data === "[") {
          this.adjustPanelColumns(-4);
          return { consume: true };
        }
        if (data === "]") {
          this.adjustPanelColumns(4);
          return { consume: true };
        }
        if (data === "0") {
          this.resetPanelColumns();
          return { consume: true };
        }
      }
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
      if (!match) return undefined;
      const button = Number(match[1]);
      const x = Number(match[2]) - 1;
      const y = Number(match[3]) - 1;
      const release = match[4] === "m";
      const movement = (button & 32) !== 0;
      if (this.resizing) {
        if (release) {
          this.resizing = false;
          this.showResizeNotice();
        } else if (movement) this.resizePanelTo(this.tui.terminal.columns - x);
        return { consume: true };
      }
      const panelStart = this.tui.terminal.columns - this.panelColumns;
      const headerRows = this.options.header ? 2 : 0;
      const footerRows = this.options.footer ? 2 : 0;
      const panelRows = this.tui.terminal.rows - headerRows - footerRows;
      if (movement) return x >= panelStart ? { consume: true } : undefined;
      if (x < panelStart || y < headerRows || y >= headerRows + panelRows) return undefined;
      if (!release && (button & 64) === 0 && (button & 3) === 0 && x <= panelStart + 1) {
        const now = Date.now();
        this.focus();
        if (now - this.lastDividerPress <= 350) this.resetPanelColumns();
        else {
          this.resizing = true;
          this.showResizeNotice("DRAG", true);
        }
        this.lastDividerPress = now;
        return { consume: true };
      }
      if (!release) {
        this.focus();
        const localX = x - panelStart;
        const localY = y - headerRows;
        this.panel.handleMouse(localX, localY, this.panelColumns);
        if ((button & 64) !== 0) this.panel.handleInput((button & 3) === 0 ? "k" : "j");
      }
      return { consume: true };
    };
    this.unsubscribeMouse = this.tui.addInputListener(listener);
    const internal = this.tui as InternalViewportTui;
    const listeners = internal.inputListeners;
    if (listeners?.has(listener)) {
      const existing = [...listeners].filter((candidate) => candidate !== listener);
      listeners.clear();
      listeners.add(listener);
      for (const candidate of existing) listeners.add(candidate);
    }
  }

  private adjustPanelColumns(delta: number): void {
    this.resizePanelTo(this.panelColumns + delta);
  }

  private resizePanelTo(columns: number): void {
    const next = this.clampPanelColumns(columns);
    this.panelColumnsOverride = next;
    if (next !== this.panelColumns && this.originalRoot && this.panel) this.mount(this.originalRoot, this.panel, next);
    this.showResizeNotice(this.resizing ? "DRAG" : undefined, this.resizing);
  }

  private resetPanelColumns(): void {
    this.panelColumnsOverride = undefined;
    const next = this.getPanelColumns();
    if (next !== this.panelColumns && this.originalRoot && this.panel) this.mount(this.originalRoot, this.panel, next);
    this.showResizeNotice("RESET");
  }

  private showResizeNotice(prefix?: string, hold = false): void {
    if (this.resizeNoticeTimer) clearTimeout(this.resizeNoticeTimer);
    const percent = Math.round((this.panelColumns / Math.max(1, this.tui.terminal.columns)) * 100);
    this.resizeNotice = `${prefix ? `${prefix} · ` : ""}${percent}% · ${this.panelColumns} cols`;
    this.tui.requestRender();
    if (hold) return;
    this.resizeNoticeTimer = setTimeout(() => {
      this.resizeNotice = undefined;
      this.resizeNoticeTimer = undefined;
      this.tui.requestRender();
    }, 1400);
    this.resizeNoticeTimer.unref?.();
  }

  private clampPanelColumns(columns: number): number {
    const max = Math.max(30, Math.min(96, this.tui.terminal.columns - 40));
    return Math.max(30, Math.min(max, Math.round(columns)));
  }

  private createPanel(): GitExplorer {
    return new GitExplorer(
      this.options.git,
      this.options.exec,
      this.options.getSettings,
      this.options.theme,
      () => this.tui.requestRender(),
      (result) => this.deactivate(result),
      {
        embedded: true,
        reservedRows: (this.options.header ? 2 : 0) + (this.options.footer ? 2 : 0),
        getTerminalRows: () => this.tui.terminal.rows,
        getResizeStatus: () => this.resizeNotice,
        activity: this.options.activity,
      },
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
    const content = new HStack([
      { component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 40 },
      { component: panel, basis: panelColumns, grow: 0, shrink: 1, minSize: 30, maxSize: panelColumns },
    ]);
    const rows = [];
    if (this.options.header) rows.push({ component: this.options.header });
    rows.push({ component: content, basis: 0, grow: 1, shrink: 1, minSize: 5 });
    if (this.options.footer) rows.push({ component: this.options.footer });
    this.splitRoot = rows.length === 1 ? content : new VStack(rows);
    this.tui.setLayoutRoot(this.splitRoot);
  }

  private getPanelColumns(): number {
    if (this.panelColumnsOverride !== undefined) return this.clampPanelColumns(this.panelColumnsOverride);
    const settings = this.options.getSettings().explorer;
    return this.clampPanelColumns(this.tui.terminal.columns * percentage(settings.splitWidth));
  }

  private restore(): void {
    if (this.resizeNoticeTimer) clearTimeout(this.resizeNoticeTimer);
    this.resizeNoticeTimer = undefined;
    this.resizeNotice = undefined;
    this.resizing = false;
    this.unsubscribeMouse?.();
    this.unsubscribeMouse = undefined;
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
