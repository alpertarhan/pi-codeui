export const ICON_KEYS = ["brand", "branch", "modified", "added", "untracked"] as const;
export type IconKey = (typeof ICON_KEYS)[number];
export type GlyphPreset = "nerd" | "unicode" | "ascii" | "custom";
export type FallbackGlyphPreset = Exclude<GlyphPreset, "custom">;

export interface CodeuiSettings {
  appearance: {
    theme: string;
    density: "compact" | "comfortable";
    borders: "rounded" | "square" | "minimal";
    glyphPreset: GlyphPreset;
    fallbackGlyphPreset: FallbackGlyphPreset;
    icons: Partial<Record<IconKey, string>>;
  };
  chrome: {
    header: boolean;
    footer: boolean;
    editor: boolean;
    messageLabels: boolean;
  };
  widget: {
    enabled: boolean;
    maxFiles: number;
    placement: "aboveEditor" | "belowEditor";
  };
  explorer: {
    layout: "split" | "overlay";
    splitWidth: `${number}%`;
    overlayWidth: `${number}%`;
    minOverlayColumns: number;
    dockWidgets: boolean;
    maxDockRows: number;
    diffContext: number;
    maxDiffLines: number;
  };
  vim: {
    enabled: boolean;
    startMode: "insert" | "normal";
    externalEditor: string[];
  };
  git: {
    showUntracked: boolean;
    ignoreWhitespace: boolean;
  };
}

export const DEFAULT_SETTINGS: Readonly<CodeuiSettings> = Object.freeze({
  appearance: Object.freeze({
    theme: "codeui-midnight",
    density: "compact",
    borders: "rounded",
    glyphPreset: "nerd",
    fallbackGlyphPreset: "unicode",
    icons: Object.freeze({}),
  }),
  chrome: Object.freeze({ header: true, footer: true, editor: true, messageLabels: true }),
  widget: Object.freeze({ enabled: true, maxFiles: 4, placement: "aboveEditor" }),
  explorer: Object.freeze({ layout: "split", splitWidth: "34%", overlayWidth: "52%", minOverlayColumns: 100, dockWidgets: true, maxDockRows: 12, diffContext: 3, maxDiffLines: 500 }),
  vim: Object.freeze({ enabled: false, startMode: "insert", externalEditor: Object.freeze(["nvim"]) as unknown as string[] }),
  git: Object.freeze({ showUntracked: true, ignoreWhitespace: false }),
});

export const DENSITY_PRESETS = {
  compact: { padding: 0, gap: 0 },
  comfortable: { padding: 1, gap: 1 },
} as const;

export const BORDER_PRESETS = {
  rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  square: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
  minimal: { topLeft: "", topRight: "", bottomLeft: "", bottomRight: "", horizontal: "─", vertical: "" },
} as const;

export interface NormalizedSettings {
  settings: CodeuiSettings;
  warnings: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeSettings(raw: unknown, inherited: Readonly<CodeuiSettings> = DEFAULT_SETTINGS): NormalizedSettings {
  const warnings: string[] = [];
  if (!isObject(raw)) return { settings: cloneSettings(inherited), warnings: ["settings: expected an object"] };

  const section = (name: keyof CodeuiSettings): Record<string, unknown> => {
    const value = raw[name];
    if (value === undefined) return {};
    if (isObject(value)) return value;
    warnings.push(`${name}: expected an object`);
    return {};
  };
  reportUnknown(raw, ["$schema", "appearance", "chrome", "widget", "explorer", "vim", "git"], "", warnings);

  const appearance = section("appearance");
  reportUnknown(appearance, ["theme", "density", "borders", "glyphPreset", "fallbackGlyphPreset", "icons"], "appearance", warnings);
  const iconsRaw = appearance.icons;
  const icons = isObject(iconsRaw) ? iconsRaw : {};
  if (iconsRaw !== undefined && !isObject(iconsRaw)) warnings.push("appearance.icons: expected an object");
  reportUnknown(icons, ICON_KEYS, "appearance.icons", warnings);
  const normalizedIcons = { ...inherited.appearance.icons };
  for (const key of ICON_KEYS) {
    const value = icons[key];
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 0 && value.length <= 16 && !/[\x00-\x1f\x7f]/.test(value)) normalizedIcons[key] = value;
    else warnings.push(`appearance.icons.${key}: expected a non-empty, control-free string of at most 16 characters`);
  }

  const chrome = section("chrome");
  reportUnknown(chrome, ["header", "footer", "editor", "messageLabels"], "chrome", warnings);
  const widget = section("widget");
  reportUnknown(widget, ["enabled", "maxFiles", "placement"], "widget", warnings);
  const explorer = section("explorer");
  reportUnknown(explorer, ["layout", "splitWidth", "overlayWidth", "minOverlayColumns", "dockWidgets", "maxDockRows", "diffContext", "maxDiffLines"], "explorer", warnings);
  const vim = section("vim");
  reportUnknown(vim, ["enabled", "startMode", "externalEditor"], "vim", warnings);
  const git = section("git");
  reportUnknown(git, ["showUntracked", "ignoreWhitespace"], "git", warnings);

  return {
    settings: {
      appearance: {
        theme: stringField(appearance, "theme", inherited.appearance.theme, "appearance", warnings),
        density: enumField(appearance, "density", ["compact", "comfortable"], inherited.appearance.density, "appearance", warnings),
        borders: enumField(appearance, "borders", ["rounded", "square", "minimal"], inherited.appearance.borders, "appearance", warnings),
        glyphPreset: enumField(appearance, "glyphPreset", ["nerd", "unicode", "ascii", "custom"], inherited.appearance.glyphPreset, "appearance", warnings),
        fallbackGlyphPreset: enumField(appearance, "fallbackGlyphPreset", ["nerd", "unicode", "ascii"], inherited.appearance.fallbackGlyphPreset, "appearance", warnings),
        icons: normalizedIcons,
      },
      chrome: {
        header: booleanField(chrome, "header", inherited.chrome.header, "chrome", warnings),
        footer: booleanField(chrome, "footer", inherited.chrome.footer, "chrome", warnings),
        editor: booleanField(chrome, "editor", inherited.chrome.editor, "chrome", warnings),
        messageLabels: booleanField(chrome, "messageLabels", inherited.chrome.messageLabels, "chrome", warnings),
      },
      widget: {
        enabled: booleanField(widget, "enabled", inherited.widget.enabled, "widget", warnings),
        maxFiles: integerField(widget, "maxFiles", 1, 20, inherited.widget.maxFiles, "widget", warnings),
        placement: enumField(widget, "placement", ["aboveEditor", "belowEditor"], inherited.widget.placement, "widget", warnings),
      },
      explorer: {
        layout: enumField(explorer, "layout", ["split", "overlay"], inherited.explorer.layout, "explorer", warnings),
        splitWidth: percentageField(explorer, "splitWidth", 20, 50, inherited.explorer.splitWidth, warnings),
        overlayWidth: percentageField(explorer, "overlayWidth", 30, 90, inherited.explorer.overlayWidth, warnings),
        minOverlayColumns: integerField(explorer, "minOverlayColumns", 60, 300, inherited.explorer.minOverlayColumns, "explorer", warnings),
        dockWidgets: booleanField(explorer, "dockWidgets", inherited.explorer.dockWidgets, "explorer", warnings),
        maxDockRows: integerField(explorer, "maxDockRows", 3, 24, inherited.explorer.maxDockRows, "explorer", warnings),
        diffContext: integerField(explorer, "diffContext", 0, 20, inherited.explorer.diffContext, "explorer", warnings),
        maxDiffLines: integerField(explorer, "maxDiffLines", 50, 5000, inherited.explorer.maxDiffLines, "explorer", warnings),
      },
      vim: {
        enabled: booleanField(vim, "enabled", inherited.vim.enabled, "vim", warnings),
        startMode: enumField(vim, "startMode", ["insert", "normal"], inherited.vim.startMode, "vim", warnings),
        externalEditor: stringArrayField(vim, "externalEditor", inherited.vim.externalEditor, warnings),
      },
      git: {
        showUntracked: booleanField(git, "showUntracked", inherited.git.showUntracked, "git", warnings),
        ignoreWhitespace: booleanField(git, "ignoreWhitespace", inherited.git.ignoreWhitespace, "git", warnings),
      },
    },
    warnings,
  };
}

export function cloneSettings(settings: Readonly<CodeuiSettings>): CodeuiSettings {
  return {
    appearance: { ...settings.appearance, icons: { ...settings.appearance.icons } },
    chrome: { ...settings.chrome },
    widget: { ...settings.widget },
    explorer: { ...settings.explorer },
    vim: { ...settings.vim, externalEditor: [...settings.vim.externalEditor] },
    git: { ...settings.git },
  };
}

function reportUnknown(object: Record<string, unknown>, known: readonly string[], prefix: string, warnings: string[]): void {
  for (const key of Object.keys(object)) if (!known.includes(key)) warnings.push(`${prefix ? `${prefix}.` : ""}${key}: unknown field ignored`);
}

function enumField<const T extends string>(object: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T, prefix: string, warnings: string[]): T {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  warnings.push(`${prefix}.${key}: expected ${allowed.join("|")}`);
  return fallback;
}

function booleanField(object: Record<string, unknown>, key: string, fallback: boolean, prefix: string, warnings: string[]): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  warnings.push(`${prefix}.${key}: expected a boolean`);
  return fallback;
}

function integerField(object: Record<string, unknown>, key: string, min: number, max: number, fallback: number, prefix: string, warnings: string[]): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && (value as number) >= min && (value as number) <= max) return value as number;
  warnings.push(`${prefix}.${key}: expected an integer from ${min} to ${max}`);
  return fallback;
}

function percentageField(object: Record<string, unknown>, key: string, min: number, max: number, fallback: `${number}%`, warnings: string[]): `${number}%` {
  const value = object[key];
  if (value === undefined) return fallback;
  const match = typeof value === "string" ? /^(0|[1-9]\d*)%$/.exec(value) : null;
  const number = match ? Number(match[1]) : NaN;
  if (number >= min && number <= max) return value as `${number}%`;
  warnings.push(`explorer.${key}: expected a percentage from ${min}% to ${max}%`);
  return fallback;
}

function stringField(object: Record<string, unknown>, key: string, fallback: string, prefix: string, warnings: string[]): string {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value)) return value;
  warnings.push(`${prefix}.${key}: expected a non-empty, control-free string of at most 128 characters`);
  return fallback;
}

function stringArrayField(object: Record<string, unknown>, key: string, fallback: readonly string[], warnings: string[]): string[] {
  const value = object[key];
  if (value === undefined) return [...fallback];
  if (Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256)) return [...value];
  warnings.push(`vim.${key}: expected 1 to 16 non-empty strings`);
  return [...fallback];
}
