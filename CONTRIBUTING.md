# Contributing to codex-image-in-cc

Thanks for considering a contribution. This document covers scope, dev setup, and PR conventions.

## Scope

This plugin is intentionally narrow: **image generation only**, dispatching to Codex CLI's bundled `imagegen` skill.

- Image-generation logic (prompt augmentation, transparency, size validation, save-path policy, multi-image, resize) belongs in Codex's `imagegen` skill, not here. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- If you want to expose another Codex built-in tool (`web_search`, `browser`, etc.), please open a **separate plugin** rather than widening this one. The narrow scope is what keeps the abstraction honest.
- For Codex-backed code review and general task delegation, see [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) — orthogonal and complementary.

## Dev setup

Requirements:

- Node.js 18.18+
- `@openai/codex` CLI v0.142.0+ (v0.144+ recommended) with an active `codex login` session
- Claude Code with plugin support

Local plugin dev loop:

```bash
git clone https://github.com/KingGyuSuh/codex-image-in-cc.git
cd codex-image-in-cc
npm test
npm run validate:plugin
npm run status

# In Claude Code:
claude --plugin-dir .
# After SKILL.md edits inside a session:
/reload-plugins
```

## Architecture

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before making non-trivial changes. It covers the call flow, the load-bearing edge cases (SKILL.md verbatim caveat, stdin trap, `--sandbox workspace-write`, `--skip-git-repo-check`, image orchestrator model ladder, `SAVED:` line contract, edit input-path parsing), and the design rationale for keeping the Node wrapper thin.

## PR conventions

- **For features, open an issue first.** Bug-fix PRs are welcome directly, but for new behavior (flags, skills, instruction changes) please open a feature-request issue and get a nod before writing code. The maintainer may be working on overlapping changes or tracking an upstream Codex CLI contract change that affects the design — a quick issue avoids parallel work being wasted on either side.
- Branch off `main`. Keep changes scoped — one PR per concern.
- Run `npm test` and `npm run validate:plugin` before submitting.
- If you change a SKILL.md heredoc or a `codex exec` invocation, update the matching **Load-bearing edge cases** entry in `docs/ARCHITECTURE.md` in the same PR.
- Update `CHANGELOG.md` under the `[Unreleased]` section.
- By contributing, you agree your work is licensed under Apache-2.0 (see [`LICENSE`](LICENSE)).

## Reporting bugs and requesting features

Use the issue templates in `.github/ISSUE_TEMPLATE/`:

- **Bug report** for unexpected behavior. Please include `/codex-image:status` output.
- **Feature request** for new capabilities (subject to the scope check).

Security issues — see [`SECURITY.md`](SECURITY.md). Do not file them as public issues.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
