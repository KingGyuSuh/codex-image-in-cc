# Security Policy

## Supported versions

Only the latest published version of `codex-image-in-cc` is supported. Apply updates promptly.

## Reporting a vulnerability

Please report security issues **privately** via GitHub's [private security advisory](https://github.com/KingGyuSuh/codex-image-in-cc/security/advisories/new) on this repository.

If GitHub Security Advisories is unavailable, contact the maintainer listed in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) with a subject line starting with `[security]`.

Do **not** open a public issue for security reports.

You can expect:

- Acknowledgement within 7 days.
- A fix or mitigation plan within 30 days for confirmed issues.
- Credit in the release notes if you wish.

## Threat model

This plugin is a thin Bash dispatcher to the `codex exec` CLI. The intended deployment is a single user invoking the plugin in their own Claude Code session against their own Codex installation.

- **Authentication** is handled by Codex CLI's own session storage under `~/.codex/`. This plugin does not read, store, or transmit auth tokens. `OPENAI_API_KEY` is not used for the default built-in path.
- **Bash injection from `$ARGUMENTS`** is mitigated by capturing user input through a **quoted heredoc** (`<<'CODEX_IMAGE_ARGS'`) before interpolating into a double-quoted argv. User input reaches `codex` as literal text — `$(...)`, backticks, and parameter expansions inside the user prompt are not re-evaluated by Bash.
- **Edit input paths** are passed via `codex exec --image "$INPUT"` (double-quoted). Paths with whitespace are explicitly rejected by `skills/edit/SKILL.md`; document the symlink workaround instead of expanding the parser.
- **Filesystem writes** happen on the Codex side (the `imagegen` skill saves under `./codex-images/` or a user-specified path). This plugin does not write outside the `codex` child process.

If you find a way to bypass any of the above, please report it via the channel above.
