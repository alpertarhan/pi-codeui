# Security Policy

## Supported versions

Security fixes are provided for the latest published pi-codeui release. Users should upgrade to the newest version before reporting an issue that may already be resolved.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Report a vulnerability** flow in the repository Security tab. Include:

- affected pi-codeui, Pi, and Node.js versions;
- impact and realistic attack scenario;
- minimal reproduction steps or proof of concept;
- whether secrets, filesystem contents, Git state, or command execution are involved;
- any suggested mitigation.

Remove unrelated secrets and personal data. The maintainer will aim to acknowledge a complete report within seven days, assess severity, and coordinate a fix and disclosure. Response times may vary for a volunteer-maintained project.

## Security-sensitive areas

Reports are especially useful for:

- command or argument injection;
- unsafe path handling or writes outside the intended workspace;
- Git mutations that bypass confirmation or fail-closed guards;
- leakage of prompts, files, credentials, tokens, or session data;
- trust-boundary bypasses in project settings;
- unsafe interaction with other Pi extensions or terminal control sequences.

General bugs and feature requests belong in [GitHub Issues](https://github.com/alpertarhan/pi-codeui/issues).
