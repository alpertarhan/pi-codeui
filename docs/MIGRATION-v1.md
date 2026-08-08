# Migrating to pi-codeui v1

## Package identity

The pre-1.0 development package was named `@pi-codeui/core`. It was never published to npm. The canonical v1 package is `pi-codeui`:

```sh
pi remove npm:@pi-codeui/core  # only if an old npm source is present
pi install npm:pi-codeui
```

Local-path installs remain valid and can be updated during development with:

```sh
pi update /absolute/path/to/pi-codeui
```

The canonical Git source is:

```sh
pi install git:github.com/alpertarhan/pi-codeui@v1.0.0
```

## Configuration and state

No settings migration is required from 0.13.x:

- Global settings remain at `~/.pi/agent/codeui.settings.json`.
- Trusted project settings remain at `<repo>/.pi/codeui.settings.json`.
- Repository workspace state remains at `~/.pi/agent/codeui.workspace-state.json`.
- Existing theme, glyph, editor, Git, panel-width, tab, scope, and dock preferences are retained.

The schema URL changes only because of the package rename:

```json
{
  "$schema": "https://unpkg.com/pi-codeui/schemas/codeui.settings.schema.json"
}
```

## User-visible terminology

The right rail is now called `WORKSPACE`, because it includes Changes, Activity, Checks, Search, and extension widgets. `/codeui` and `Ctrl+Shift+G` focus this rail.

`TURN` is the active branch's user-turn ordinal, not a token count. Token and context metrics remain separately labeled in the footer.

Pressing `q`, `Escape`, or clicking the left prompt returns keyboard focus without rebuilding or resetting the rail.

## Compatibility boundary

v1 supports Pi Coding Agent 0.84.x. Fullscreen split mode uses a bounded Pi 0.84 adapter; regular TUI and unknown internal layout shapes fail closed to safe fallback behavior. See [COMPATIBILITY.md](./COMPATIBILITY.md) for the validated extension matrix and widget-density notes.

After installation, run:

```text
/reload
/codeui-doctor
```
