# Pi extension compatibility

The validated extension matrix records the CodeUI v1.1.0 release-audit baseline; the ownership and control notes include the v1.2.0 additions. The listed versions are evidence, not a promise about future package releases.

## Ownership contract

CodeUI is the only extension in this matrix that owns Pi's global header, footer, editor component, fullscreen `layoutRoot`, focus, and raw input listener. Other extensions use distinct widget/status keys or `setWorkingMessage`.

Theme ownership is conditional. `appearance.theme: "inherit"` is the default and does not select or restore a theme. When an explicit theme such as bundled opt-in `codeui-midnight` is configured, CodeUI records the previous host theme and restores it only if CodeUI's selected theme is still active. A later user or extension theme change is therefore preserved.

With `explorer.dockWidgets: true`, CodeUI keeps its own dirty-Changes strip beside the prompt and moves other above/below-editor widgets into the `EXTENSIONS` section. Third-party docking is generic and preserves component instances; it does not fork, rewrite, or key-match external widgets. Set `explorer.dockWidgets: false` to keep Pi's native widget placement.

The Pi 0.84 split adapter is fail-closed. It detects the viewport through the `setLayoutRoot` capability CodeUI actually uses rather than importing optional pi-tui runtime type guards. Viewport constructors are accessed through a guarded namespace, while ANSI stripping, terminal width, truncation, wrapping, and Kitty printable decoding live in CodeUI's dependency-free compatibility layer. Duplicate/cross-install dependency trees therefore cannot crash because a host pi-tui omits newer helper or viewport exports.

- An unknown widget-dock shape remains untouched and is not extracted.
- A missing/ineligible fullscreen root falls back to the regular overlay flow.
- Restore only replaces a root that CodeUI still owns.
- If another extension replaces the root, CodeUI releases the old panel subscriptions, adopts the latest root on the next ensure, and restores that latest external root on dispose.

## Validated matrix

| Extension | Version | UI surface | Result |
|---|---:|---|---|
| `@aliou/pi-processes` | 0.10.4 | Above/below-editor process widgets | Compatible |
| `@zenobius/pi-worktrees` | 0.5.1 | Namespaced status | Compatible |
| `pi-markdown-preview` | 0.11.2 | Commands/tools | Compatible |
| `@juanibiapina/pi-tokyonight` | 1.1.0 | Themes only | Compatible |
| `@melihmucuk/pi-crew` | 1.0.28 | `crew-status` widget, `Ctrl+Shift+E` | Compatible |
| `@juicesharp/rpiv-ask-user-question` | 2.4.0 | Tool only | Compatible |
| `@juicesharp/rpiv-todo` | 2.4.0 | `rpiv-todos` widget, `Ctrl+Shift+T` | Compatible |
| `@juicesharp/rpiv-advisor` | 2.4.0 | Tool only | Compatible |
| `@juicesharp/rpiv-web-tools` | 2.4.0 | Tools only | Compatible |
| `@ersintarhan/pi-toolkit` | 0.8.1 | Namespaced statuses/tools | Compatible |
| `@dietrichgebert/ponytail` | 4.8.4 | Namespaced status/commands | Compatible |
| `pi-prompt-template-model` | 0.11.0 | Namespaced statuses/tools | Compatible |
| `pi-tracker` | 0.3.0 | Namespaced status | Compatible |
| `pi-working-vibe` | 0.1.2 | Sole `setWorkingMessage` owner | Compatible |
| `@narumitw/pi-plan-mode` | 0.17.2 | Persistent plan widget/status | Compatible; dock density may increase |
| `@ogulcancelik/pi-herdr` | 0.4.0 | Tools only | Compatible |
| `pi-smart-compact` | 8.0.6 | Transient progress widget/status | Compatible; dock density may increase |
| Local `herdr-agent-state.ts` | local | Socket events only; no Pi UI | Compatible |

CodeUI registers one public, display-only Markdown transformer for `You`/`Pi` labels. It does not register or override built-in tools, replace message components, or mutate stored messages. No configured extension currently registers another Markdown transformer.

No configured extension shares CodeUI's command names, `Ctrl+Shift+G` shortcut, `pi-codeui.changes` widget key, or `pi-codeui.*` status keys. No configured extension calls `setHeader`, `setFooter`, `setEditorComponent`, or `setLayoutRoot`.

Single-key controls are scoped to the focused CodeUI workspace. `t` applies only to Changes review scope; `r` reruns a stored check only in Checks and refreshes Git elsewhere; `[` / `]` / `0` / `z` are intercepted only while the fullscreen split rail is focused. Temporary `z` zoom is never persisted and resets when focus returns to Pi's prompt or the split is disposed.

The two density notes are visual, not correctness conflicts. Use `w` to collapse the `EXTENSIONS` section or disable `explorer.dockWidgets` when persistent and transient widgets are active together.

## Verification

```sh
npm run verify
npm run dev -- --list-models
```

The split compatibility tests cover:

- Generic third-party widget extraction while the CodeUI Changes strip and native status/editor components remain in place.
- Unknown layout shape fail-closed behavior.
- Optional native widget placement.
- External layout replacement/adoption and identity-safe restore.
- Theme inheritance, explicit selection, and identity-conditional restoration.
- Scoped fullscreen split resize/zoom controls.
- Releasing replaced panel subscriptions.
