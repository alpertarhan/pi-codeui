import { stripTerminalSequences, truncateToWidth, visibleWidth } from "./tui-compat.ts";
import type { CodeuiSettings, FallbackGlyphPreset, IconKey } from "./settings.ts";

export const GLYPH_PRESETS: Record<FallbackGlyphPreset, Record<IconKey, string>> = {
  nerd: { brand: "π", branch: "", modified: "󰏫", added: "󰐕", untracked: "󰋗" },
  unicode: { brand: "π", branch: "⑂", modified: "●", added: "+", untracked: "?" },
  ascii: { brand: "pi", branch: "git", modified: "M", added: "A", untracked: "?" },
};

export interface ResolvedGlyphs {
  preset: CodeuiSettings["appearance"]["glyphPreset"];
  icons: Record<IconKey, string>;
  fallbackIcons: Record<IconKey, string>;
}

export function resolveGlyphs(settings: Readonly<CodeuiSettings>): ResolvedGlyphs {
  const { glyphPreset, fallbackGlyphPreset, icons: overrides } = settings.appearance;
  const base = GLYPH_PRESETS[glyphPreset === "custom" ? fallbackGlyphPreset : glyphPreset];
  return {
    preset: glyphPreset,
    icons: { ...base, ...overrides },
    fallbackIcons: { ...GLYPH_PRESETS[fallbackGlyphPreset] },
  };
}

export function fitGlyph(glyph: string, width: number): string {
  const fitted = stripTerminalSequences(truncateToWidth(glyph, width, ""));
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}
