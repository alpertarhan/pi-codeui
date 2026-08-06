# @pi-codeui/core

A Git-aware, keyboard-first terminal UI extension for [Pi Coding Agent](https://pi.dev). The current M0 release is a type-safe package scaffold; it does not yet render the Git UI.

## Requirements

- Node.js 22.19.0 or newer
- Pi Coding Agent 0.84.x

## Installation

The package is not published yet. After the first release, installation will be:

```sh
pi install npm:@pi-codeui/core
```

For now, clone the repository, install development dependencies, and load the source directly:

```sh
npm install
npm run dev
```

`npm run dev` runs `pi -e ./src/index.ts`. After editing the extension, enter `/reload` in Pi to reload the extension and resources without restarting Pi.

## Current M0 scope

M0 registers `/codeui-doctor` and intentionally starts no timers, watchers, or processes. The command reports that the scaffold loaded when Pi is running in TUI mode. It produces no UI in print, JSON, or RPC modes.

## Planned UI

Later milestones add a compact changed-files widget, a responsive Git diff explorer, optional minimal Vim editing, and external Neovim integration. Configuration, Git parsing, overlays, and Vim behavior are not part of M0.

## Customization split

`codeui.settings.json` will own layout, density, glyphs, Git behavior, and feature flags. Native Pi themes will own colors. Font family, font size, font features, and ligatures remain the responsibility of the host terminal (for example Ghostty, Kitty, WezTerm, or iTerm2).

## Commands

```sh
npm run check  # strict TypeScript check; no output emitted
npm test       # exercise command registration and mode guards
npm run dev    # launch Pi with the local extension
```

Inside Pi:

```text
/codeui-doctor
/reload
```

See [`PRODUCT_PLAN.md`](./PRODUCT_PLAN.md) for the complete roadmap.

## License

MIT
