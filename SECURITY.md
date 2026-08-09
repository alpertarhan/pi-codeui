# Security Policy

## Supported versions

Security fixes are provided for the latest published pi-codeui release. Users should upgrade before reporting an issue that may already be resolved.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Report a vulnerability** flow in the repository Security tab and include:

- affected pi-codeui, Pi, and Node.js versions;
- impact and realistic attack scenario;
- minimal reproduction or proof of concept;
- whether secrets, files, Git state, project trust, or command execution are involved;
- any suggested mitigation.

Remove unrelated secrets and personal data. The maintainer aims to acknowledge a complete report within seven days, assess severity, and coordinate remediation/disclosure; response times may vary for a volunteer-maintained project.

## Command execution boundaries

Git mutations and external-editor file navigation use direct argv execution with repository-relative path validation. File paths are not shell-interpolated.

**Confirmed Checks rerun is the one intentional shell boundary.** For a recognized Bash test/build/lint record, CodeUI stores the original complete command, working directory, and optional finite timeout in seconds. Pressing `r` in Checks always shows sanitized **full** values for confirmation. If approved, CodeUI directly executes `/bin/bash` when available (otherwise `bash`) with argv `[-c, rawCommand]`, the stored cwd, and timeout. It never executes a truncated or sanitized display string.

Approval therefore grants the stored command normal shell semantics, including expansions, pipelines, redirections, and command substitution. Review the entire command, cwd, and timeout before approving. Check records without a stored Bash command cannot be rerun.

## Destructive Git guard

Tracked-file discard is fail-closed and requires explicit confirmation. It is unavailable for untracked, renamed, or conflicted files and is blocked while the agent is active. CodeUI checks the agent-active state both before opening confirmation and again after approval, preventing a discard if agent work starts while the dialog is open.

Stage/unstage, hunk actions, commits, and quickfix export also validate current repository state. Binary, truncated, untracked, renamed, conflicted, or whitespace-filtered hunk operations are rejected where a safe patch cannot be proven.

## Other security-sensitive areas

Reports are especially useful for:

- command or argument injection, including Checks rerun confirmation/execution mismatch;
- unsafe path handling or writes outside the intended repository;
- Git mutations that bypass confirmation, agent-active guards, or fail-closed checks;
- leakage of prompts, files, credentials, tokens, or session data;
- trust-boundary bypasses in project settings;
- unsafe extension interaction, theme ownership, or terminal control sequences.

General bugs and feature requests belong in [GitHub Issues](https://github.com/alpertarhan/pi-codeui/issues).
