# Changelog

All notable changes to `@pi-codeui/core` are documented here. The project follows semantic versioning after the 1.0 release.

## Unreleased

- v1.0 compatibility and manual terminal-matrix validation.

## 0.13.0

- Replace the global extension advertisement with repository-aware `PROJECT` identity.
- Pair branch and Git health in the header while removing duplicate model information.
- Redesign the footer around prioritized path, token flow, turn, context pressure, model, and thinking groups with responsive disclosure.
- Rename the multi-purpose rail from `GIT EXPLORER` to `WORKSPACE` and add focus-aware prompt chrome.

## 0.12.1

- Restore Pi prompt focus when its left-side editor region is clicked while the fullscreen rail is focused.
- Keep transcript clicks available for native terminal text selection and avoid rebuilding the rail on `q`/`Escape` blur.

## 0.12.0

- Cache formatted diffs, parsed hunks, and unified search results by runtime revision.
- Expand `/codeui-doctor` with runtime, repository, viewport, workspace-state, and diagnostics information.
- Add `npm run verify`, package-content checks, and Node 22.19 GitHub Actions CI.
- Refresh release documentation and package the changelog.

## 0.11.0

- Persist repository-specific panel width, active tab, Git scope, and widget dock mode.
- Add atomic, bounded workspace-state storage and `/codeui-reset-workspace`.

## 0.10.0

- Export diagnostics and changed files to native Vim/Neovim quickfix with `Q`.

## 0.9.0

- Add safe per-hunk stage/unstage and guarded single-line commit composition.

## 0.8.0

- Add unified fuzzy search across files, Activity, and Checks.

## 0.7.0

- Add Problems & Checks parsing and exact Neovim line/column navigation.

## 0.6.0

- Add shell-free per-file Git stage/unstage and confirmed tracked-file discard.

## 0.5.0

- Relocate compatible Pi extension widgets, including rpiv-todo, into the CodeUI rail.

## 0.4.0

- Add mouse and keyboard resizing for the integrated fullscreen rail.

## 0.1.0 – 0.3.x

- Initial configurable Git-aware Pi TUI, fullscreen split layout, Activity insight, Vim/Neovim integration, global chrome, settings/schema/theme support, and mouse interaction.
