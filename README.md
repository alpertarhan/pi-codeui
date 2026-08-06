# @pi-codeui/core

A customization foundation for a Git-aware, keyboard-first [Pi Coding Agent](https://pi.dev) TUI. It provides layered settings, appearance presets, and a renderer-agnostic read-only Git data layer; it does not render the future Git UI.

## Requirements and installation

- Node.js 22.19.0 or newer
- Pi Coding Agent 0.84.x

```sh
pi install npm:@pi-codeui/core
```

For local development:

```sh
npm install
npm run dev
```

## Settings

Settings are loaded in this order, with later valid fields overriding earlier ones:

1. built-in defaults;
2. global: `path.join(getAgentDir(), "codeui.settings.json")`, normally `~/.pi/agent/codeui.settings.json` and respecting `PI_CODING_AGENT_DIR`;
3. trusted project: `<cwd>/.pi/codeui.settings.json` (`.pi` follows Pi's `CONFIG_DIR_NAME`).

Project settings are never read unless Pi reports the project trusted. Unknown keys are ignored with warnings. Invalid values inherit the previous layer. Malformed JSON makes that file unusable. Editing either applicable file hot reloads settings; malformed live edits preserve the last valid settings.

Start a file with the bundled schema:

```json
{
  "$schema": "https://unpkg.com/@pi-codeui/core/schemas/codeui.settings.schema.json",
  "appearance": {
    "density": "compact",
    "borders": "rounded",
    "glyphPreset": "nerd",
    "fallbackGlyphPreset": "unicode",
    "icons": { "brand": "π" }
  }
}
```

The packaged schema is [`schemas/codeui.settings.schema.json`](./schemas/codeui.settings.schema.json). Supported profiles are:

- density: `compact`, `comfortable`;
- borders: `rounded`, `square`, `minimal`;
- glyphs: `nerd`, `unicode`, `ascii`, `custom`;
- icon overrides: `brand`, `branch`, `modified`, `added`, `untracked`.

`custom` starts from `fallbackGlyphPreset` and applies icon overrides. Overrides also work with the other profiles. `/codeui-doctor` reports active paths, trust, glyph samples, and terminal identity.

## Native theme

Colors remain entirely in Pi's native theme system; pi-codeui does not maintain a second palette. Select `codeui-midnight` with Pi's `/theme` UI or set it in Pi's `settings.json`:

```json
{ "theme": "codeui-midnight" }
```

Pi owns native theme hot reload and renderers should use Pi Theme tokens such as `accent`, `border`, and `toolDiffAdded`.

## Terminal fonts

The host terminal—not pi-codeui—owns font family, size, font features, and ligatures. See [`docs/terminal-profiles.md`](./docs/terminal-profiles.md) for user-managed Ghostty, Kitty, and WezTerm examples. Choose `unicode` or `ascii` when a Nerd Font is unavailable.

## Development

```sh
npm run check
npm test
npm pack --dry-run
npm run dev
```

Inside Pi, use `/codeui-doctor` and `/reload`.

## Scope

The internal Git core detects repositories and exposes typed status, branch, diff, numstat, and bounded untracked-preview data. Git UI, overlays, mutating actions, and Vim behavior remain deferred.

## License

MIT
