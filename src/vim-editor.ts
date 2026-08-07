import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";

export type VimMode = "normal" | "insert";

export interface VimEditorOptions {
  startMode: VimMode;
  modal?: boolean;
  label?: string;
  styleMode?: (mode: VimMode, label: string, focused: boolean) => string;
  styleBorder?: (mode: VimMode, text: string, focused: boolean) => string;
  onModeChange?: (mode: VimMode) => void;
}

const NORMAL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  h: "\x1b[D",
  j: "\x1b[B",
  k: "\x1b[A",
  l: "\x1b[C",
  "0": "\x01",
  $: "\x05",
  w: "\x1bf",
  b: "\x1bb",
  x: "\x1b[3~",
});

export class VimEditor extends CustomEditor {
  private mode: VimMode;
  private readonly vimOptions: VimEditorOptions;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    vimOptions: VimEditorOptions,
  ) {
    super(tui, theme, keybindings);
    this.vimOptions = vimOptions;
    this.mode = vimOptions.startMode;
    if (vimOptions.styleBorder) {
      const border = (text: string) => vimOptions.styleBorder!(this.mode, text, this.focused);
      Object.defineProperty(this, "borderColor", { configurable: true, get: () => border, set: () => {} });
    }
  }

  getMode(): VimMode {
    return this.mode;
  }

  private setMode(mode: VimMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.vimOptions.onModeChange?.(mode);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.vimOptions.modal === false) {
      super.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") this.setMode("normal");
      else super.handleInput(data);
      return;
    }

    if (this.mode === "insert") {
      super.handleInput(data);
      return;
    }

    const printable = (Object.keys(NORMAL_KEYS) as KeyId[]).find((key) => matchesKey(data, key));
    if (matchesKey(data, "i")) {
      this.setMode("insert");
      return;
    }
    if (matchesKey(data, "a")) {
      super.handleInput("\x1b[C");
      this.setMode("insert");
      return;
    }
    if (printable) {
      super.handleInput(NORMAL_KEYS[printable]!);
      return;
    }

    // Ignore printable text and paste in normal mode; preserve Pi/app control shortcuts.
    const plainPrintable = !data.startsWith("\x1b") && Array.from(data).some((char) => char.charCodeAt(0) >= 32);
    if (plainPrintable || decodeKittyPrintable(data) !== undefined || data.startsWith("\x1b[200~")) return;
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0 || width <= 0) return lines;

    const label = ` ${this.vimOptions.modal === false ? (this.vimOptions.label ?? "PROMPT") : this.mode.toUpperCase()} `;
    const styled = this.vimOptions.styleMode?.(this.mode, label, this.focused) ?? this.borderColor(label);
    const labelWidth = visibleWidth(styled);
    if (labelWidth > width) return lines;

    const last = lines.length - 1;
    lines[last] = `${truncateToWidth(lines[last] ?? "", width - labelWidth, "")}${styled}`;
    return lines;
  }
}
