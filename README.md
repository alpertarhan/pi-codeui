# @pi-codeui/core

A Git-aware, keyboard-first [Pi Coding Agent](https://pi.dev) TUI with a persistent changes summary and read-only Git Explorer.

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
    "theme": "codeui-midnight",
    "density": "compact",
    "borders": "rounded",
    "glyphPreset": "nerd",
    "fallbackGlyphPreset": "unicode",
    "icons": { "brand": "π" }
  },
  "chrome": {
    "header": true,
    "footer": true,
    "editor": true
  },
  "explorer": {
    "layout": "split",
    "splitWidth": "34%",
    "overlayWidth": "52%",
    "minOverlayColumns": 100,
    "dockWidgets": true,
    "maxDockRows": 12
  }
}
```

The packaged schema is [`schemas/codeui.settings.schema.json`](./schemas/codeui.settings.schema.json). Supported profiles are:

- theme: `codeui-midnight` by default, any installed Pi theme name, or `inherit`;
- density: `compact`, `comfortable`;
- borders: `rounded`, `square`, `minimal`;
- glyphs: `nerd`, `unicode`, `ascii`, `custom`;
- icon overrides: `brand`, `branch`, `modified`, `added`, `untracked`;
- Explorer layout: `split` (default) or `overlay`;
- split width: 20–50% via `explorer.splitWidth`;
- generic extension-widget docking in the right rail via `explorer.dockWidgets`; `maxDockRows` limits it to 3–24 rows;
- mockup-style global header/footer and bordered prompt via `chrome.header`, `chrome.footer`, and `chrome.editor`.

`custom` starts from `fallbackGlyphPreset` and applies icon overrides. Overrides also work with the other profiles. `/codeui-doctor` reports active paths, trust, glyph samples, and terminal identity.

## Native theme

Colors remain entirely in Pi's native theme system; pi-codeui does not maintain a second palette. Select `codeui-midnight` with Pi's `/theme` UI or set it in Pi's `settings.json`:

```json
{ "theme": "codeui-midnight" }
```

Pi owns native theme hot reload and renderers should use Pi Theme tokens such as `accent`, `border`, and `toolDiffAdded`.

## Terminal fonts

The host terminal—not pi-codeui—owns font family, size, font features, and ligatures. See [`docs/terminal-profiles.md`](./docs/terminal-profiles.md) for user-managed Ghostty, Kitty, and WezTerm examples. Choose `unicode` or `ascii` when a Nerd Font is unavailable.

## Vim and Neovim

Embedded Vim mode is deliberately small and optional:

```json
{
  "vim": {
    "enabled": true,
    "startMode": "insert",
    "externalEditor": ["nvim"]
  }
}
```

Normal mode supports `h`/`j`/`k`/`l`, `w`/`b`, `0`/`$`, `x`, `i`, and `a`. The editor border shows `NORMAL` or `INSERT`; Pi control shortcuts continue to pass through. `/codeui-vim` toggles the mode for the current session without rewriting configuration.

Pi's built-in `Ctrl+G` flow edits the current prompt using Pi's own `settings.json` `externalEditor` setting (for example, `"externalEditor": "nvim"`). Separately, Git Explorer's `e` key suspends Pi's TUI, opens the selected repository file with pi-codeui's `vim.externalEditor` argv array, resumes Pi, and refreshes Git state. The command is executed directly—never through a shell.

## Development

```sh
npm run check
npm test
npm pack --dry-run
npm run dev
```

Inside Pi:

- In fullscreen mode, Git Explorer remains mounted as a true right-side split and Pi's transcript/editor reflows on the left.
- A global CodeUI header/footer spans both columns; the prompt uses a bordered `PROMPT` editor, or `NORMAL`/`INSERT` when Vim mode is enabled.
- The footer shows cumulative session input/output, uncached latest-turn input+output, cached tokens, total provider tokens, and live context-window usage with warning/error thresholds. `TURN` deliberately excludes cache so it is not double-counted beside `CACHE`.
- The sidebar continuously exposes the AI's current action, its latest stated rationale, and a newest-first developer activity timeline.
- The fullscreen sidebar is an integrated rail joined directly to the global header/footer rather than a floating box; clean repositories show a workspace/session overview instead of an empty diff pane.
- Pi widgets that would normally consume transcript height above/below the editor—including `rpiv-todo`—are generically relocated into an `EXTENSIONS` dock in the right rail. Press `w` or click its heading to collapse it; no third-party fork is required. Completed-only todo lists auto-compact to a single success summary and can still be expanded with `w`.
- Test, build, typecheck, and lint commands receive first-class activity labels and surface useful result lines.
- Clean workspaces use a calm ready state instead of zero-heavy counters or irrelevant file-opening hints; Working/Staged tabs always show their own counts.
- `/codeui` or `Ctrl+Shift+G` focuses the split panel, or opens the fallback Explorer.
- `/codeui-refresh` refreshes repository state.
- `/codeui-vim` toggles embedded Vim mode for the current session.
- `/codeui-doctor` reports active customization and editor settings.
- `/reload` reloads the extension and Pi resources.

Git Explorer controls: click anywhere in the fullscreen rail to focus it; Changes/Activity tabs, Working/Staged scope, and file/activity rows are mouse-selectable, and the wheel follows the clicked list/detail region. Drag the centered `⋮` divider left/right for live sidebar resizing; double-click the divider to reset it. While focused, `[` shrinks, `]` grows, and `0` resets to `explorer.splitWidth`. The title reports percentage/columns during resizing, with responsive bounds that protect the main transcript. A single file click selects it for diff preview; click the trailing `↗`, double-click the row, or press `e` to open it safely in Neovim. Keyboard controls remain: `j`/`k` or arrows select; `a` opens Activity; `g` returns to Changes; `Tab` switches Working/Staged; `Enter` toggles list/detail focus; `PageUp`/`PageDown` or `Ctrl+U`/`Ctrl+D` scroll details; `e` opens the selected file in Neovim; `r` refreshes; `q`/`Escape` returns focus to Pi's editor while the split stays visible. Regular TUI mode, narrow terminals, and `explorer.layout: "overlay"` use the existing overlay/dashboard fallback.

The always-visible `NOW`/`WHY` card is derived from Pi's assistant narrative and tool lifecycle events. Activity records are session-local, bounded, display-only, and never injected into model context. The Activity detail panel explains `WHAT`, `WHY`, `HOW`, and `RESULT`; edit/write timestamps also order changed files newest-first and mark files currently being edited.

The current UI follows [the terminal mockup](./docs/mockups/pi-codeui-terminal.png).

## Scope

The changes widget and Git Explorer remain read-only. Staging, unstaging, patch selection, discarding, and replacement of Pi's transcript/header/footer remain deferred. Embedded Vim mode intentionally implements only the documented core motions; it is not a Vim emulator.

### Split-layout compatibility

Pi's public extension API currently exposes overlays but not side panels. To deliver a reflowing split without maintaining a separate Pi fork, `@pi-codeui/core` 0.1.x wraps Pi 0.84's fullscreen `layoutRoot` with pi-tui's `HStack` and restores it on reload/shutdown. This adapter is intentionally bounded to the package's Pi 0.84 peer range. If the internal root is unavailable, pi-codeui fails closed to the overlay/dashboard instead of replacing an unknown layout. A future upstream `setSidePanel` API should replace this adapter.

## License

MIT
