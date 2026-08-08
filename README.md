# pi-codeui

A conversation-first, code-aware [Pi Coding Agent](https://pi.dev) terminal workspace with session context, safe Git actions, diagnostics, unified search, persistent layout, and Vim/Neovim integration.

## Requirements and installation

- Node.js 22.19.0 or newer
- Pi Coding Agent 0.84.x

```sh
pi install npm:pi-codeui

# Before the npm release, install directly from GitHub:
pi install git:github.com/alpertarhan/pi-codeui
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
  "$schema": "https://unpkg.com/pi-codeui/schemas/codeui.settings.schema.json",
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

`custom` starts from `fallbackGlyphPreset` and applies icon overrides. Overrides also work with the other profiles. `/codeui-doctor` reports config/trust, glyph samples, Node/terminal viewport, repository, split compatibility, persisted workspace state, Activity/diagnostic counts, and editor ownership.

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
- A project-aware global header/footer spans both columns: the header identifies the current repository instead of repeating the extension brand, pairs branch with Git health, and shows a single agent state. The prompt keeps a quiet structural border while its `PROMPT` label becomes active only when the editor owns focus; Vim mode uses the same treatment for `NORMAL`/`INSERT`.
- The footer gives the current path, prioritized session input/output, the active branch's user-turn ordinal (`TURN 7`), live context-window pressure, and clearly labeled `MODEL`/`THINK` values. Redundant cache/total accounting is intentionally omitted from the primary status bar, and narrower terminals progressively collapse labels instead of crowding the prompt.
- The rail opens on a session-local `Session` overview with the conversation title, turn/image/action counts, and reliable file/image resources. Active tool work adds a transient `NOW`/`CONTEXT` strip; completed work remains in the newest-first Activity timeline instead of masquerading as current work.
- The fullscreen sidebar is an integrated rail joined directly to the global header/footer rather than a floating box. Session is always available; Changes appears only for Git repositories, while Activity and Checks work for coding, research, export, and general chat tools. Empty Session, Changes, Activity, and Checks views each use one contextual body instead of duplicate list/detail placeholders. A lightweight unref'd probe reveals Changes automatically when the folder becomes a Git repository.
- Pi widgets that would normally consume transcript height above/below the editor—including `rpiv-todo`—are generically relocated into an `EXTENSIONS` dock in the right rail. Press `w` or click its heading to collapse it; no third-party fork is required. Completed-only todo lists auto-compact to a single success summary and can still be expanded with `w`.
- Test, build, typecheck, and lint commands receive first-class activity labels and surface useful result lines.
- The `Checks` tab parses common TypeScript, ESLint, and test `path:line:column` diagnostics, groups the latest result per check command, and opens the exact problem location in Neovim.
- `/` opens dependency-free unified search across conversation messages, changed files, tool activity, and diagnostics. Use `m:`, `f:`, `a:`, or `c:` prefixes, arrow keys to select, `Enter` to reveal in its native tab, and `Ctrl+O` to open file-backed targets directly.
- `Q` exports current diagnostics plus every visible changed file to a native Vim/Neovim quickfix list, opens the first entry, and supports normal `:cnext`/`:cprev` navigation.
- Workspace-specific width percentage, Worktree/Staged scope, and explicit Extensions dock mode survive reload/resume through `~/.pi/agent/codeui.workspace-state.json`. The active tab is deliberately session-local, so every new conversation starts on Session. `/codeui-reset-workspace` clears only the current workspace's saved layout state.
- Clean and not-yet-run states use calm, explicit summaries instead of zero-heavy counters or irrelevant actions; Checks distinguishes `NOT RUN`, `RUNNING`, `CLEAR`, and `FAILED`.
- `/codeui` or `Ctrl+Shift+G` focuses the split panel, or opens the fallback Explorer.
- `/codeui-refresh` refreshes repository state.
- `/codeui-reset-workspace` clears the current workspace's persisted width/scope/dock state.
- `/codeui-vim` toggles embedded Vim mode for the current session.
- `/codeui-doctor` reports active customization and editor settings.
- `/reload` reloads the extension and Pi resources.

Workspace rail controls: click anywhere in the fullscreen rail to focus it; click Pi's prompt/editor region on the left to return keyboard focus without closing or resetting the rail. Session/Activity/Changes/Checks tabs, Worktree/Staged scope, and file/activity/problem/search rows are mouse-selectable. Press `h`, `a`, `g`, or `c` for Session, Activity, Changes, or Checks; `?` opens contextual shortcut help. Press `/` for unified search; `m:`, `f:`, `a:`, and `c:` filter messages, files, activity, and checks. `Enter` reveals a result and `Ctrl+O` opens file-backed targets. In Changes, `Tab` switches Worktree/Staged; `s` stages or unstages; `m` or right-click opens file actions; guarded `x`, `C`, and `Q` provide discard, commit, and quickfix flows. In a diff, `Enter` focuses details and `n`/`p` selects a hunk. Drag the centered `⋮` divider or use `[`/`]` to resize; `0` resets it. `q`/`Escape` returns focus to Pi's editor while the split remains visible. Footer hints show only actions currently available. Regular TUI mode, narrow terminals, and `explorer.layout: "overlay"` use the existing overlay fallback.

The transient `NOW`/`CONTEXT` strip is derived from Pi's assistant narrative and active tool lifecycle events. Activity records are session-local, bounded, display-only, and never injected into model context. Activity Details presents `WHAT`, `CONTEXT`, `HOW`, and `RESULT` as vertically separated, scrollable sections with textual `RUNNING`/`DONE`/`FAILED` status and timing. Check Details uses the same hierarchy for location, severity, source, message, and command, so neither panel depends on color alone. Edit/write timestamps also order changed files newest-first and mark files currently being edited.

The current UI follows [the terminal mockup](./docs/mockups/pi-codeui-terminal.png).

## Development verification

```sh
npm ci
npm run verify
npm pack --dry-run
```

GitHub Actions runs the same typecheck, full temporary-repository test suite, and package-content smoke check on Node.js 22.19.0. Release history is maintained in [CHANGELOG.md](./CHANGELOG.md). Pre-1.0 users should read [the v1 migration guide](./docs/MIGRATION-v1.md); maintainers use [the release checklist](./docs/RELEASING.md).

## Scope

The changes widget remains display-only. Git Explorer supports shell-free per-file and per-hunk stage/unstage, guarded tracked-file discard, native Neovim quickfix export, and a single-line commit composer with staged/conflict/active-action guards, explicit confirmation, normal Git hooks, automatic refresh, and failure recovery. Hunk actions are intentionally unavailable for binary, truncated, untracked, renamed, conflicted, or whitespace-filtered diffs. Untracked deletion, conflict/rename discard, multi-line commit bodies, commit amend/signing, and replacement of Pi's transcript renderer remain deferred. Embedded Vim mode intentionally implements only the documented core motions; it is not a Vim emulator.

### Split-layout compatibility

Pi's public extension API currently exposes overlays but not side panels. To deliver a reflowing split without maintaining a separate Pi fork, the current pre-1.0 adapter wraps Pi 0.84's fullscreen `layoutRoot` with pi-tui's `HStack` and restores it on reload/shutdown. This adapter is intentionally bounded to the package's Pi 0.84 peer range. If the internal root is unavailable, pi-codeui fails closed to the overlay/dashboard instead of replacing an unknown layout. A future upstream `setSidePanel` API should replace this adapter.

The versioned installed-extension audit, global UI ownership contract, widget-density notes, cross-install pi-tui compatibility layer, and runtime checks are documented in [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).

## License

MIT
