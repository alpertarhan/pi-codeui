# Changelog

All notable changes to `pi-codeui` are documented here. The project follows semantic versioning after the 1.0 release.

## Unreleased

- Make the rail conversation-first with a session-local `Session` home, conversation/resource counts, and general-chat activity labels.
- Replace duplicate empty list/detail placeholders with one contextual Session, Changes, Activity, or Checks body.
- Search session messages with `m:` alongside files, activity, and diagnostics.
- Show only currently available footer actions, add contextual `?` help, and separate agent `ACTIVE` from Git Worktree/Staged terminology.
- Keep width, Git scope, and extension-dock preferences persistent while resetting the active tab to Session for each conversation.

## 1.0.0-rc.4 - 2026-08-08

- Remove runtime imports of optional pi-tui ANSI, width, wrapping, truncation, and Kitty decoding helpers.
- Add a dependency-free terminal compatibility layer and guard optional viewport constructors behind runtime capabilities.
- Add a legacy-host module-load regression with optional pi-tui exports deliberately absent.

## 1.0.0-rc.3 - 2026-08-08

- Remove the optional `isViewportTUI` runtime import that could crash when CodeUI and the host Pi resolved different pi-tui package trees.
- Detect fullscreen split support structurally through `setLayoutRoot` while preserving layout-shape and identity fail-safes.

## 1.0.0-rc.2 - 2026-08-08

- Hide Changes/diff controls outside Git repositories and reveal them automatically after `git init`.
- Redesign Developer and Check Insight as readable vertical sections with textual status, timing, and scroll position.
- Keep non-Git Activity/Checks/Search layouts and hints free of unavailable Git actions.

## 1.0.0-rc.1 - 2026-08-08

- Add deterministic terminal, viewport, Nerd Font/Unicode/ASCII, and non-color accessibility matrices.
- Profile large repositories, diffs, Activity/diagnostics, and fuzzy search; cache repeated diff hunk indexing.
- Validate the configured Pi extension matrix and harden identity-safe adoption of externally replaced layouts.
- Rename the unpublished pre-1.0 package from `@pi-codeui/core` to the canonical `pi-codeui` npm/GitHub identity.
- Add v1 migration, compatibility, and release documentation.

## 0.13.2

- Give stacked Changes, Activity, Checks, and Search views one stable list/insight grid.
- Pad empty and short insight states so Extensions and shortcut hints remain bottom-anchored.
- Keep mouse hit-testing aligned with the shared responsive tab geometry.

## 0.13.1

- Reduce focused prompt chrome to an accent label instead of full-width cyan rules.
- Render the active directory with stronger breadcrumb contrast in `PATH`.
- Keep `X-HIGH` reasoning visually distinct from red error/critical-context states.

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
