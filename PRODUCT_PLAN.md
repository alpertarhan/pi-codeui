# pi-codeui — Product Plan

## 1. Product goal

`pi-codeui` is a Pi Coding Agent extension package that adds a conversation-first, code-aware, keyboard-first terminal UI without replacing Pi's conversation flow.

The selected experience is an integrated terminal workspace:

- project/session-aware global chrome and a bordered, focus-aware prompt;
- a persistent, resizable right rail with a session-local Session home plus Activity, Changes, Checks, Search, and extension widgets;
- safe file/hunk stage, unstage, discard, and commit flows;
- an optional minimal Vim mode for Pi's prompt editor;
- real Neovim integration by suspending Pi's TUI, opening `nvim`, then restoring Pi.

## 2. Platform fit and constraints

Pi's public extension API already supports the required building blocks:

- `ctx.ui.setWidget()` for the persistent Git summary;
- `ctx.ui.custom(..., { overlay: true })` for the diff explorer;
- `ctx.ui.setStatus()` for repository/refresh state;
- `ctx.ui.setEditorComponent()` and `CustomEditor` for modal prompt editing;
- `pi.registerCommand()` and `pi.registerShortcut()` for navigation;
- `pi.exec()` for shell-free Git queries and guarded mutations;
- lifecycle/tool events for event-driven refreshes;
- package themes and Pi's existing theme tokens for styling.

Important limits:

1. Pi currently does not expose a public extension API for permanently reflowing the transcript into columns. For local Pi 0.84 use, the selected experimental adapter identity-checks and wraps the fullscreen renderer's existing `layoutRoot` in pi-tui's `HStack`; it restores the original root on reload/shutdown and falls back if internals are unavailable. The long-term solution remains an upstream `setSidePanel` extension point.
2. Overlay mode is documented as experimental and remains the regular/narrow-terminal fallback.
3. Embedded Vim mode will intentionally be a small modal editor, not a complete Vim implementation.
4. Real Neovim will run as a separate interactive terminal process while Pi's TUI is suspended.
5. Terminal applications cannot portably change the host terminal's font family or toggle ligatures. Ghostty, Kitty, WezTerm, iTerm2, and similar hosts own those settings; this extension controls glyph/icon presets and validates fallbacks.

## 3. UX specification

New conversations start on a single-body Session overview. It derives its title and counts from Pi's existing session entries without a second LLM summary, lists only reliable image/file resources, and keeps code-specific surfaces available without making them the default. Empty Activity, Changes, and Checks views also use one contextual body; Checks distinguishes never-run, running, clear, and failed states. The active tab is session-local, while width, Git scope, and dock preferences remain workspace-persistent.

### 3.1 Persistent widget

Default placement: above the editor.

```text
 Git main  M 3  A 1  ? 2  +48/-17   src/app.ts · src/git.ts · …
```

States:

- clean: `Git main ✓ clean`;
- dirty: branch, staged/unstaged/untracked counts, line statistics, first changed paths;
- loading: subtle refresh indicator;
- not a repository: hidden by default;
- Git error: compact warning plus `/codeui-refresh` hint.

The widget remains display-only so it does not steal focus from the prompt editor.

### 3.2 Diff explorer

Open with `/codeui` or the default shortcut `Ctrl+Shift+G`.

Wide terminal (`>= 100` columns): right-side overlay, roughly 52% width and at most 85% height.

Narrow terminal: transient full-width dashboard instead of an overlay.

```text
╭─ Git Explorer · main ─────────────────────────╮
│ Working  Staged                               │
│ > M src/app.ts                         +8/-2  │
│   A src/git.ts                         +74/-0 │
├─ src/app.ts ──────────────────────────────────┤
│ @@ -18,6 +18,12 @@                            │
│ - old line                                    │
│ + new line                                    │
│                                               │
│ j/k move · tab scope · e nvim · r refresh     │
╰───────────────────────────────────────────────╯
```

Initial controls:

| Key | Action |
|---|---|
| `j` / `k`, arrows | Select changed file / scroll diff |
| `Tab` | Switch working-tree and staged changes |
| `Enter` | Toggle list/diff focus |
| `e` | Open selected file in Neovim |
| `r` | Refresh Git state |
| `Esc` / `q` | Close explorer |

Later safe Git controls:

| Key | Action |
|---|---|
| `s` | Stage selected file |
| `u` | Unstage selected file |
| `p` | Open patch-level staging dashboard |
| `d` | Discard with an explicit confirmation and preview |

### 3.3 Vim and Neovim

Embedded Vim mode is optional and starts in insert mode. The first version supports:

- `Esc`, `i`, `a` for mode changes;
- `h`, `j`, `k`, `l`, `0`, `$`, `w`, `b` for movement;
- `x` for deleting a character;
- Pi's existing app shortcuts through `CustomEditor` fallback;
- a visible `NORMAL` / `INSERT` mode label.

It will not initially implement registers, macros, visual mode, text objects, Ex commands, or a Vimscript engine.

Real Neovim integration has two paths:

1. Pi's built-in `Ctrl+G` external editor flow for editing the current prompt. Users can set `externalEditor` to `nvim`.
2. `e` in Git Explorer suspends Pi's TUI and spawns `nvim -- <selected-file>` with inherited stdio. When Neovim exits, Pi resumes and Git state refreshes.

No shell interpolation will be used for selected file paths.

## 4. Functional scope

### MVP

- detect whether the current directory is a Git worktree;
- parse staged, unstaged, untracked, deleted, conflicted, and renamed paths;
- show branch and compact change statistics;
- preview per-file staged and unstaged diffs;
- show untracked-file previews with size limits;
- persistent widget and responsive explorer;
- manual and event-driven refresh;
- minimal optional Vim mode;
- Neovim opening for prompt and selected files;
- commands, shortcut, config loading, and graceful no-Git behavior.

### Product follow-ups

- stage/unstage selected file;
- patch-level staging;
- safe discard flow;
- commit composer and recent commit log;
- file filtering and fuzzy search;
- jump to the first changed hunk in Neovim;
- conflict markers and merge-oriented view;
- optional Git worktree/submodule indicators;
- packaged light/dark themes and appearance presets;
- package publishing through npm/git and Pi package gallery metadata.

### Non-goals

- replacing Pi's entire transcript renderer;
- implementing a complete Vim clone;
- bundling libgit2 or a Git parsing dependency;
- continuously polling Git while the UI is idle;
- silently modifying the user's global Pi settings;
- destructive Git operations without confirmation.

## 5. Technical architecture

```text
src/
  index.ts                 Extension registration and lifecycle
  config.ts                Global/project config loading and validation
  git.ts                   Git command adapter
  porcelain.ts             `git status --porcelain=v1 -z` parser
  state.ts                 Repository UI state and debounced refresh
  ui/
    changes-widget.ts      Persistent compact summary
    diff-explorer.ts       Responsive overlay/dashboard component
    vim-editor.ts          Minimal modal `CustomEditor`
    interactive-editor.ts  Suspend/resume TUI and spawn Neovim
  format/
    diff.ts                Width-safe ANSI diff rendering
```

Keep modules small and avoid a UI framework or state-management dependency. Use Node built-ins, `pi.exec()`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` only.

### 5.1 Git data flow

Status command:

```text
git status --porcelain=v1 -z --branch --untracked-files=all
```

Diff commands:

```text
git diff --no-ext-diff --no-color --unified=<n> -- <path>
git diff --cached --no-ext-diff --no-color --unified=<n> -- <path>
```

Rules:

- always pass paths after `--`;
- preserve spaces and rename pairs from NUL-delimited porcelain output;
- treat `git diff` exit code `1` as data where applicable, not automatically as failure;
- cap rendered diff lines/bytes and indicate truncation;
- render with Pi theme tokens: `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext`;
- do not send UI-only Git data into model context.

### 5.2 Refresh policy

Refresh on:

- `session_start`;
- explorer open and explicit `r`;
- completion of `edit` and `write` tool executions;
- completion of Bash tool executions that may mutate the worktree;
- `agent_settled`;
- return from Neovim;
- stage/unstage actions.

Debounce closely grouped refreshes. Do not recursively watch the repository or run a permanent polling loop in the first release.

### 5.3 Extension compatibility

- use unique widget/status keys such as `pi-codeui.git`;
- own the global header/footer only inside CodeUI's bounded fullscreen adapter and restore by component identity;
- keep Vim mode off by default because only one custom editor factory can effectively own the editor;
- capture and restore the previous editor factory when toggling Vim mode;
- guard terminal-only behavior with `ctx.mode === "tui"`;
- clean up overlays, editor overrides, and resources on `session_shutdown`;
- provide slash-command fallbacks for every shortcut;
- avoid overriding built-in tools.

## 6. Configuration and appearance

Use two cooperating formats rather than duplicating Pi's theme system:

1. `codeui.settings.json` controls layout, density, glyphs/icons, Git behavior, Vim, and feature flags.
2. Native Pi theme JSON files control colors and remain selectable through Pi's `/theme` UI.

Global configuration respects `PI_CODING_AGENT_DIR` through Pi's exported `getAgentDir()`:

```text
~/.pi/agent/codeui.settings.json
```

Trusted project override:

```text
.pi/codeui.settings.json
```

Proposed schema:

```json
{
  "$schema": "https://unpkg.com/pi-codeui/schemas/codeui.settings.schema.json",
  "appearance": {
    "theme": "codeui-midnight",
    "density": "compact",
    "borders": "rounded",
    "glyphPreset": "nerd",
    "fallbackGlyphPreset": "unicode",
    "icons": {
      "brand": "π",
      "branch": "",
      "modified": "M",
      "added": "A",
      "untracked": "?"
    }
  },
  "chrome": {
    "header": true,
    "footer": true,
    "editor": true
  },
  "widget": {
    "enabled": true,
    "maxFiles": 4,
    "placement": "aboveEditor"
  },
  "explorer": {
    "layout": "split",
    "splitWidth": "34%",
    "overlayWidth": "52%",
    "minOverlayColumns": 100,
    "diffContext": 3,
    "maxDiffLines": 500
  },
  "vim": {
    "enabled": false,
    "startMode": "insert",
    "externalEditor": ["nvim"]
  },
  "git": {
    "showUntracked": true,
    "ignoreWhitespace": false
  }
}
```

Bundled theme example:

```text
themes/codeui-midnight.json
```

It uses Pi's native theme schema and tokens such as `accent`, `border`, `selectedBg`, `toolDiffAdded`, and `toolDiffRemoved`. Pi handles theme selection and theme-file reloading; the extension watches `codeui.settings.json` and rerenders after valid changes.

Font family, size, font features, and ligatures remain terminal-profile settings. The extension provides documented Ghostty/Kitty/WezTerm examples plus `/codeui-doctor` glyph samples. `glyphPreset` can be `nerd`, `unicode`, `ascii`, or `custom`; custom icons are width-measured and safely padded/truncated.

Project configuration is read only after Pi marks the project trusted. Unknown fields are reported once and ignored; invalid values fall back to the last valid configuration rather than breaking the TUI. A `/codeui-settings` command can provide a `SettingsList` UI in a later milestone.

## 7. Commands

| Command | Purpose |
|---|---|
| `/codeui` | Focus the CodeUI workspace |
| `/codeui-refresh` | Refresh repository state |
| `/codeui-vim` | Toggle embedded Vim mode |
| `/codeui-settings` | Open extension settings |
| `/codeui-doctor` | Report Git, Neovim, terminal width, and config status |

## 8. Milestones

### M0 — Package scaffold

Deliverables:

- npm package metadata with `pi.extensions` manifest;
- TypeScript setup and source entry point;
- peer dependencies for Pi packages;
- local launch script using `pi -e`;
- README with install and development instructions.

Acceptance: extension loads, `/reload` works, no UI appears outside TUI mode.

### M1 — Read-only Git core

Deliverables:

- repository detection;
- porcelain parser;
- branch/change/stat models;
- staged, unstaged, rename, conflict, and untracked handling;
- unit tests using parser fixtures and temporary Git repositories.

Acceptance: paths containing spaces and rename records parse correctly; non-Git directories fail quietly.

### M2 — Persistent hybrid UI

Deliverables:

- changed-files widget;
- responsive overlay/full-dashboard explorer;
- diff rendering, scrolling, truncation, and theme support;
- event-driven/debounced refresh;
- commands and default shortcut.

Acceptance: every rendered line stays within terminal width; resize and narrow-terminal fallback remain usable.

### M3 — Vim/Neovim integration

Deliverables:

- optional minimal modal prompt editor;
- mode indicator;
- previous-editor restoration;
- selected-file Neovim opening with TUI suspend/resume;
- documentation for Pi's built-in `externalEditor` setting.

Acceptance: Pi's interrupt, exit, submit, model, and external-editor shortcuts still work; paths are passed without shell interpolation.

### M4 — Safe Git actions

Status: per-file and per-hunk stage/unstage, guarded tracked-file discard, right-click/keyboard actions, single-line commit composition, notifications, and automatic refresh are implemented. Multi-hunk selection and advanced commit operations remain follow-ups.

Deliverables:

- stage and unstage;
- patch selection;
- guarded discard;
- action notifications and automatic refresh.

Acceptance: destructive actions require confirmation; failures never leave the UI showing a false clean state.

### M5 — Customization and distribution

Deliverables:

- config merge/validation;
- `/codeui-settings` and `/codeui-doctor`;
- optional bundled themes;
- npm/git installation for `pi-codeui`;
- screenshots/video and package-gallery metadata;
- compatibility matrix for Kitty, Ghostty, WezTerm, iTerm2, and narrow terminals.

Acceptance: `pi install npm:pi-codeui` loads the extension, bundled themes, and schemas without manual copying.

## 9. Verification strategy

Automated:

- parser tests for every porcelain status pair and rename path;
- temporary-repository integration tests for staged/unstaged/untracked diffs;
- component render tests at widths 60, 80, 100, and 160;
- assertions that `visibleWidth(line) <= renderWidth`;
- config validation and merge tests;
- command failure, cancellation, and diff truncation tests.

Manual TUI matrix:

- regular and fullscreen Pi TUI modes;
- empty, clean, dirty, conflicted, and non-Git directories;
- terminal resize while overlay is open;
- editor mode toggling during and after an agent run;
- Neovim open/close and cancelled/error exits;
- coexistence with another widget/status extension;
- reload, new session, resume, and shutdown cleanup.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Experimental overlay behavior changes | Isolate overlay adapter and retain full-dashboard fallback |
| Custom editor conflicts with another extension | Default off; detect, capture, restore, and warn |
| Large diffs freeze rendering | Lazy per-file loading, byte/line caps, render caching |
| Git paths break parsing or commands | NUL-delimited porcelain, argv arrays, `--` path separator |
| Stale widget after external edits | Refresh on explorer open/manual action; add optional watcher only if users need it |
| Destructive Git action causes data loss | Restrict supported targets, require explicit confirmation, preview/check patches, and fail closed for conflicts/untracked deletion |
| Narrow terminal makes side overlay unusable | Automatic transient dashboard fallback |

## 11. v1 release posture

Milestones M0–M10 are complete. The v1.0.0 release gate requires the terminal/accessibility matrix, large-workspace profile, configured-extension audit, canonical package metadata, full test suite, package-content smoke check, clean-install Pi load, and a green GitHub Actions run. Advanced destructive Git operations remain post-v1 unless they can preserve the same fail-closed contract.
