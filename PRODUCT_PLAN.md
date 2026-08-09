# pi-codeui — Product Plan

- **Status:** v1.2.0 implemented and release-verified
- **Last updated:** 2026-08-09
- **Package version:** 1.2.0

## 1. Product goal

`pi-codeui` is a conversation-first, code-aware, keyboard-first terminal workspace for Pi Coding Agent. It keeps Pi's native conversation flow while adding Session, Activity, Changes, Checks, Search, extension docking, guarded Git actions, and optional Vim/Neovim workflows.

It is not a replacement transcript renderer or full IDE.

## 2. Current implementation

| Area | Current implementation through v1.2.0 |
| --- | --- |
| Session | Conversation overview, status/counts/resources, session-local active tab, latest-request edit/check/failure summary |
| Activity | Live tool timeline plus completed tool history hydrated from resumed sessions; Bash timeout shown in seconds |
| Changes | Worktree/Staged scopes, diffs/hunks, per-file working/staged numstats, safe stage/unstage/discard/commit, latest-request/all filter |
| Checks | Parsed test/lint/typecheck/build diagnostics, resumed history, confirmed rerun of stored Bash validations |
| Search | Messages, Activity, Checks, all tracked files, and non-ignored untracked repository files; configurable 1–200 result cap (default 50) |
| Layout | Fullscreen split at 120+ columns by default, safe overlay/dashboard fallback, persisted width, temporary `z` review zoom |
| Input | Keyboard/mouse navigation and IME-safe grapheme editing/cursor handling in Search |
| Appearance | Host-theme inheritance by default; bundled opt-in CodeUI Midnight; identity-conditional theme restoration |
| Repository lifecycle | Nested monorepo root handling, event-driven refresh, and 30-second non-repository discovery polling |
| Safety | Repository-relative Git validation, fail-closed actions, agent-active discard block, explicit rerun shell boundary |

The latest-request Changes scope contains only paths from successful direct `edit` and `write` tool results associated with the latest request. It excludes failed calls, Bash/manual changes, and inferred authorship; it is a review filter, not an ownership claim.

## 3. Platform fit and constraints

Pi 0.84 public APIs provide widgets, statuses, overlays, editor replacement, commands/shortcuts, lifecycle/tool events, themes, and process execution. Pi does not expose a public persistent side-panel API, so fullscreen split uses a bounded adapter around the existing `layoutRoot`:

- install only in fullscreen mode at/above `explorer.minOverlayColumns`;
- require the compatible `setLayoutRoot` capability and expected shape;
- restore roots/components only by identity;
- adopt an externally replaced root rather than overwriting it;
- fall back to overlay or transient dashboard when ineligible.

Font family, size, ligatures, and font features remain host-terminal settings. Embedded Vim mode remains intentionally small.

## 4. Architecture and state

```text
src/index.ts                 Extension lifecycle, commands, themes, rerun boundary
src/activity.ts              Live/resumed tool history, checks, latest-request scope
src/git-state.ts             Repository state, numstats, file index, refresh/discovery
src/git/{git,porcelain}.ts   Direct-argv Git adapter and NUL-delimited parsers
src/git-explorer.ts          Session/Activity/Changes/Checks/Search UI and controls
src/split-panel.ts           Bounded fullscreen split, docking, resize, temporary zoom
src/settings*.ts             Trusted merge/validation/live reload
src/session.ts               Conversation overview/resources
src/external-editor.ts       Direct-argv editor and quickfix handoff
```

State ownership:

| State | Lifetime |
| --- | --- |
| Active Session/Activity/Changes/Checks tab | Session-local; new/resumed runtime opens Session |
| Latest-request summary/filter | Current hydrated/live request history; not persisted as authorship |
| Git scope, split width, Extensions dock | Repository workspace-persistent |
| `z` review zoom | Temporary fullscreen split state; never persisted |
| Settings | Built-in → global → trusted project, with last-valid live reload |
| Theme | Host-owned for `inherit`; CodeUI restores only an explicit theme it still owns |

Nested project paths are normalized against the detected repository root before file activity, stats, diffs, and search are correlated.

## 5. Git, search, and refresh

### Git data flow

```text
git rev-parse --show-toplevel
git status --porcelain=v1 -z --branch --untracked-files=all
git diff --numstat -z
git diff --cached --numstat -z
git ls-files -z --cached --others --exclude-standard
```

Paths are passed after `--` where applicable. NUL-delimited output preserves spaces and rename records. Working and staged numstats are attached separately to each file. Diffs/previews are byte/line bounded and marked when truncated.

### Search

Search documents combine:

- session messages (`m:`);
- repository-wide tracked and non-ignored untracked files (`f:`), including unchanged files;
- hydrated/live Activity (`a:`);
- current Checks diagnostics (`c:`).

The repository file list is loaded on search, cached for the current Git generation, and invalidated on refresh. `explorer.maxSearchRecords` accepts 1–200 and defaults to 50; the internal document ceiling remains 10,000.

### Refresh policy

Refresh is debounced and event-driven on session start, workspace open/manual refresh, completed `edit`/`write`/Bash tools, agent settled, editor return, and Git actions. High-frequency idle Git polling and recursive filesystem watching remain excluded.

Exception: while the current directory is not a repository, CodeUI retries repository discovery every 30 seconds so `git init` is noticed without reopening the session. The timer stops once a repository is found or the runtime is disposed.

## 6. Layout, controls, and settings

Default split eligibility is **fullscreen + at least 120 columns + compatible viewport capability**. At/above the threshold an ineligible split uses a right overlay; below it CodeUI uses a transient full-width dashboard.

| Key | Scope | Action |
| --- | --- | --- |
| `h` / `a` / `g` / `c` | Workspace | Session / Activity / Changes / Checks (`Sess` / `Act` / `Git` / `Chk` when compact) |
| `/` | Workspace | Unified Search; `m:` / `f:` / `a:` / `c:` filter sources |
| `t` | Changes | Latest successful direct edit/write files / all workspace changes |
| `Tab` | Changes | Worktree / Staged |
| `s`, `n` / `p` | Changes | Apply selected file/hunk action; move between hunks |
| `m`, `x`, `C`, `Q` | Changes | Menu, confirmed tracked discard, commit, quickfix |
| `r` | Checks | Confirm and rerun selected stored check |
| `r` | Other views | Refresh Git state |
| `[` / `]` / `0` | Fullscreen split only | Resize/reset persistent width |
| `z` | Fullscreen split only | Toggle non-persistent review zoom |
| `w`, `?`, `Esc` / `q` | Workspace | Dock, contextual help, return to prompt |

Footer hints are action-first and only show currently available operations.

Current settings are JSON files plus schema. Key defaults:

```json
{
  "appearance": { "theme": "inherit" },
  "explorer": {
    "layout": "split",
    "splitWidth": "34%",
    "overlayWidth": "52%",
    "minOverlayColumns": 120,
    "maxSearchRecords": 50
  }
}
```

A SettingsList UI and `/codeui-settings` are **future work and do not exist in the current implementation**. Users edit global or trusted-project JSON and use `/codeui-doctor` for diagnostics.

## 7. Security boundaries

Normal Git/editor paths use direct argv execution; selected file paths are never shell-interpolated. Mutations validate repository-relative targets and current state. Unsupported untracked deletion, rename/conflict discard, binary/truncated/whitespace-filtered hunk operations fail closed.

Tracked-file discard:

1. is blocked while the agent is active;
2. validates file/scope/state;
3. shows explicit confirmation;
4. checks agent-active state again after confirmation;
5. performs only the validated tracked discard and refreshes state.

Checks rerun is the one intentional shell boundary. For recognized Bash validation records CodeUI stores the original full command, cwd, and optional finite timeout in seconds. `r` always displays sanitized full values for confirmation, then directly invokes `/bin/bash` (or `bash`) with argv `[-c, rawCommand]`, the stored cwd, and timeout. The display is never truncated for confirmation and the sanitized display string is never executed.

Project settings are read only for Pi-trusted projects. Theme restoration is conditional: if the host/user/another extension changed the selected theme after CodeUI, CodeUI does not overwrite that choice.

## 8. Commands

| Command | Status | Purpose |
| --- | --- | --- |
| `/codeui` | Implemented | Focus/open workspace |
| `/codeui-refresh` | Implemented | Refresh repository state |
| `/codeui-reset-workspace` | Implemented | Reset persisted workspace width/scope/dock |
| `/codeui-vim` | Implemented | Toggle session Vim mode |
| `/codeui-doctor` | Implemented | Report settings/runtime/repository/layout/activity diagnostics |
| `/codeui-settings` | Future | Possible SettingsList UI; not registered or shipped |

## 9. Milestones

| Milestone | Status | Delivered |
| --- | --- | --- |
| M1 Core workspace | Complete | Session-first workspace, compact chrome, responsive fallback |
| M2 Git core | Complete | Nested-root-safe status/diff/numstat parsing and repository state |
| M3 Activity and Checks | Complete | Live timeline, diagnostics, timeout seconds, resumed-history hydration |
| M4 Safe actions | Complete | File/hunk stage/unstage, tracked discard, commit, quickfix, active-agent guard |
| M5 Review workflow | Complete | Latest-request successful edit/write scope and request summary |
| M6 Layout and controls | Complete | 120-column split threshold, action-first hints, scoped `t`/`r`/`z`/resize keys |
| M7 Search and input | Complete | Repository-wide file search, result limit, IME/grapheme handling |
| M8 Refresh, rerun, themes | Complete | 30-second discovery, confirmed Bash rerun boundary, inherit/conditional restore |

## 10. Completion checklist

- [x] Milestones 1–8 implementation verified
- [x] Nested monorepo paths correlate against repository root
- [x] Successful direct edit/write latest-request scope and summary
- [x] Separate per-file Worktree/Staged numstats
- [x] Resumed Activity and Checks hydration
- [x] Repository-wide tracked/non-ignored-untracked Search
- [x] IME-safe grapheme Search input
- [x] Confirmed Checks rerun with full command/cwd/timeout display
- [x] Agent-active destructive discard guard before and after confirmation
- [x] Default 120-column split threshold and temporary `z` zoom
- [x] Host-theme inheritance and identity-conditional restoration
- [x] Low-frequency non-repository discovery exception documented
- [x] Populated product screenshot at `docs/screenshots/pi-codeui-review.png`
- [x] Release version/date and clean package smoke test
- [ ] Future SettingsList design and `/codeui-settings` implementation (not release-blocking)

## 11. Non-goals and future work

Non-goals remain: replacing Pi's transcript, a complete Vim clone, libgit2, recursive repository watching, high-frequency idle Git polling, silent host-setting changes, and unconfirmed destructive operations.

Future candidates include the SettingsList UI, richer conflict/rename workflows, multi-line/amend/signing commit flows, and advanced multi-hunk selection. They ship only when they preserve the current fail-closed and compatibility contracts.
