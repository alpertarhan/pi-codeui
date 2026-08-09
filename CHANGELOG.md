# Changelog

All notable changes to `pi-codeui` are documented here. The project follows semantic versioning after the 1.0 release.

## Unreleased

## 1.2.0 - 2026-08-09

### Added

- Hydrate completed tool Activity and Checks from resumed session history.
- Add a latest-request summary and `t` review filter for files changed by successful direct `edit`/`write` calls, without claiming file ownership.
- Search all tracked and non-ignored untracked repository files alongside messages, Activity, and Checks; add `explorer.maxSearchRecords` (1–200, default 50).
- Show separate per-file Worktree and Staged numstats.
- Add confirmed Checks rerun with `r`, preserving the original Bash validation command, cwd, and finite timeout in seconds.
- Add temporary fullscreen-split review zoom with `z` and IME-safe grapheme/cursor handling in Search.
- Poll for repository discovery every 30 seconds only while outside a Git repository.

### Changed

- Default `appearance.theme` to `inherit`; CodeUI Midnight remains bundled, recommended, and opt-in.
- Raise the default fullscreen split threshold from 100 to 120 columns and keep `[` / `]` / `0` / `z` scoped to fullscreen split mode.
- Use compact `Sess` / `Act` / `Git` / `Chk` tabs and action-first contextual hints at constrained widths.
- Treat `r` as Checks rerun in Checks and Git refresh elsewhere.
- Preserve host/user theme changes by restoring a CodeUI-selected theme only while CodeUI still owns it.

### Fixed

- Resolve activity paths and Git data against the detected repository root in nested monorepo directories.
- Keep working and staged line statistics attached to the correct files, including rename paths.
- Preserve full validation timeout semantics when displaying and rerunning Bash checks.

### Security

- Block tracked-file discard for the entire agent-active period and recheck after confirmation.
- Make the rerun shell boundary explicit: confirmation shows the sanitized full command, cwd, and timeout, while execution passes the original untruncated command only as `/bin/bash|bash -c <rawCommand>`.

## 1.1.0 - 2026-08-08

- Add public-API transcript identity labels for user and Pi messages, including a streaming `working` state, without replacing Pi's native transcript or tools.
- Move prompt mode/status to the left border and add responsive send, external-editor, and workspace shortcut hints on the right.
- Keep the compact dirty-Changes strip beside the prompt while the split rail is active; clean, non-Git, loading, and error states stay quiet.
- Add `chrome.messageLabels` to disable transcript labels when a minimal native transcript is preferred.

## 1.0.1 - 2026-08-08

- Replace the conceptual README hero mockup with an actual fullscreen terminal capture so the published package sets accurate visual expectations.

## 1.0.0 - 2026-08-08

- Make the rail conversation-first with a session-local `Session` home, conversation/resource counts, and general-chat activity labels.
- Replace duplicate empty list/detail placeholders with one contextual Session, Changes, Activity, or Checks body.
- Search session messages with `m:` alongside files, activity, and diagnostics.
- Show only currently available footer actions, add contextual `?` help, and separate agent `ACTIVE` from Git Worktree/Staged terminology.
- Keep width, Git scope, and extension-dock preferences persistent while resetting the active tab to Session for each conversation.
- Redesign the project README and add contributing, conduct, security, issue, and pull-request guidance for public collaboration.

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
