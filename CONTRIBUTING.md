# Contributing to pi-codeui

Thanks for helping improve pi-codeui. Bug reports, feature proposals, documentation fixes, tests, and focused pull requests are welcome.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before opening an issue

- Search [existing issues](https://github.com/alpertarhan/pi-codeui/issues) first.
- Use the bug or feature template when it fits; blank issues are also allowed.
- Remove secrets, private paths, repository contents, and tokens from logs or screenshots.
- Report security vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in a public issue.

A useful bug report includes:

- pi-codeui, Pi, Node.js, terminal, and operating-system versions;
- whether the workspace is a Git repository;
- minimal reproduction steps and expected/actual behavior;
- relevant sanitized output from `/codeui-doctor`;
- a screenshot or recording for visual/focus problems when possible.

Feature requests should start with the user problem. A proposed UI or API is helpful, but not required.

## Local setup

Requirements:

- Node.js 22.19.0 or newer
- Pi Coding Agent 0.84.x
- Git

```sh
git clone https://github.com/alpertarhan/pi-codeui.git
cd pi-codeui
npm ci
npm run verify
npm run dev
```

Useful commands:

```sh
npm run check          # TypeScript
npm test               # Full test suite
npm run verify         # TypeScript + tests
npm pack --dry-run     # Inspect release contents
npm run dev            # Load the local extension in Pi
```

## Pull requests

1. Fork the repository and create a focused branch from `main`.
2. Keep the change as small as the problem allows.
3. Reuse existing Pi/TUI APIs and project helpers before adding abstractions or dependencies.
4. Add or update the smallest test that would catch a regression.
5. Update user-facing documentation and `CHANGELOG.md` for visible behavior changes.
6. Run `npm run verify` and `npm pack --dry-run` before opening the PR.
7. Complete the pull-request template and link related issues.

Small fixes do not need a prior issue. For broad UX, architecture, dependency, persistence, or compatibility changes, open an issue first so the direction can be agreed before substantial work.

## Project expectations

pi-codeui is a terminal UI extension with a deliberately bounded compatibility surface. Contributions should preserve:

- Pi's conversation flow and public extension contracts where available;
- fail-closed behavior around Git mutations and internal layout compatibility;
- keyboard and mouse parity for primary actions;
- non-color status cues and width-safe rendering;
- non-Git and general-chat behavior;
- Node.js 22.19.0 and Pi 0.84.x compatibility.

For UI changes, test representative narrow/wide layouts and Unicode/ASCII glyph modes. Avoid terminal-specific assumptions unless they are documented and have a fallback.

## Review and licensing

Maintainers may ask for scope reductions, tests, documentation, or compatibility evidence. CI must pass before merge.

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](./LICENSE).
