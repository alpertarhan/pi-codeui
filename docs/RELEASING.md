# Release checklist

This project uses semantic versioning from v1 onward. Release commits and tags must come from a clean `main` branch after CI passes.

## Release candidate

1. Confirm repository and npm identity:

   ```sh
   git remote get-url origin
   npm whoami
   npm view pi-codeui version
   ```

2. Run the complete local gate:

   ```sh
   npm ci
   npm run verify
   npm run dev -- --list-models
   npm pack --dry-run --json
   git diff --check
   ```

3. Set the candidate version without creating npm's automatic tag:

   ```sh
   npm version 1.0.0-rc.1 --no-git-tag-version
   ```

4. Re-run the complete gate, inspect `CHANGELOG.md`, commit, then tag:

   ```sh
   git add package.json package-lock.json CHANGELOG.md
   git commit -m "chore: prepare 1.0.0-rc.1"
   git tag -s v1.0.0-rc.1 -m "pi-codeui 1.0.0-rc.1"
   git push origin main --follow-tags
   ```

5. Create a GitHub prerelease from the tag. Attach the `.tgz` produced by `npm pack` for inspection. Do not publish to npm until the candidate has passed a clean install smoke test.

## Stable v1

1. Confirm the RC has no open release blockers and CI is green.
2. Change `Unreleased` in `CHANGELOG.md` to `1.0.0` with the release date.
3. Run `npm version 1.0.0 --no-git-tag-version` and the complete gate again.
4. Inspect package identity and contents:

   ```sh
   npm pack --dry-run --json
   npm publish --dry-run
   ```

5. Commit, create signed tag `v1.0.0`, and push it.
6. Publish from an authenticated npm account:

   ```sh
   npm publish --access public
   ```

7. Verify installation in an isolated Pi agent directory:

   ```sh
   tmp="$(mktemp -d)"
   PI_CODING_AGENT_DIR="$tmp" pi install npm:pi-codeui@1.0.0
   PI_CODING_AGENT_DIR="$tmp" pi -e npm:pi-codeui@1.0.0 --list-models
   rm -rf "$tmp"
   ```

8. Publish GitHub release notes, verify the gallery image, and follow the rollback section if any smoke check fails.

## Rollback

- GitHub: mark the release as withdrawn and document the blocker; do not move an existing tag.
- npm: use `npm deprecate pi-codeui@<version> "reason; use <safe-version>"`. Do not unpublish except for secrets or legal/security incidents.
- Code: fix forward with a new patch or RC version.
