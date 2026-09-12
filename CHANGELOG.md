# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-12

### Added

- Image generation now selects a stronger **orchestrator model and reasoning effort** when the account has one. The wrapper probes `codex debug models` (bounded by a 15s timeout — a stalled probe counts as an unavailable catalog) and passes `-m` / `-c model_reasoning_effort` for the first available rung of a preference ladder (`gpt-5.6-luna` high → `gpt-5.6-terra` medium → `gpt-5.6-sol` high → `gpt-5.6-sol` low). Accounts without those models (e.g. ChatGPT Free) or an offline probe transparently fall back to the Codex config default, so generation never regresses. If the backend rejects a ladder-selected model at turn start (e.g. a custom `model_provider` that does not serve official slugs the catalog still lists), the wrapper retries once without model flags — the rejection happens before any image tokens are spent. Only codex's `ERROR:` stderr lines are classified, and no retry happens once the turn has produced an agent message or tool call, so an echoed prompt or tool output that mentions "unknown model" cannot turn an unrelated failure into a second billed turn. Override with `CODEX_IMAGE_MODEL` + `CODEX_IMAGE_EFFORT` (both required, or the wrapper errors); a forced pair never falls back. `/codex-image:status` now reports the resolved orchestrator.

## [0.2.1] - 2026-09-12

### Fixed

- Every `generate` / `edit` dispatch failed on Codex CLI 0.151.0+ with `error: unexpected argument '--full-auto' found` (exit 2), and `/codex-image:status` reported `Ready: no`: that release removed `--full-auto` from `codex exec` (0.144.5 had already deprecated it). The wrapper now spawns `codex exec --sandbox workspace-write -c approval_policy="never"` — the same workspace-write sandbox `--full-auto` implied, accepted by every supported release (0.142 through 0.154). The explicit `approval_policy` override preserves the old approval-never contract for configs with `approvals_reviewer = "auto_review"`, where bare `--sandbox workspace-write` flips headless runs to `approval: on-request` (verified on 0.144.5 and 0.154.0). `--approve-for-me` (0.153+) was not adopted: it resolves to `approval: on-request` behind the automatic reviewer, not `never`. Fixes [#5](https://github.com/KingGyuSuh/codex-image-in-cc/issues/5); supersedes [#6](https://github.com/KingGyuSuh/codex-image-in-cc/pull/6) and [#7](https://github.com/KingGyuSuh/codex-image-in-cc/pull/7) — thanks @mhpsy and @CarolineAntunes for the report, diagnosis, and fixes.
- `/codex-image:status` no longer reports a spurious `FAIL Image attachment` when the headless probe fails. The `--image` check read the output of the rejected `codex exec --full-auto --help` call — a clap usage error with no option list — so any headless breakage also sent users to an irrelevant "upgrade Codex CLI" next step. It now runs its own `codex exec --help`, and a rejected headless flag is reported on one line instead of the full usage blurb. (Diagnosed independently in [#6](https://github.com/KingGyuSuh/codex-image-in-cc/pull/6) and [#7](https://github.com/KingGyuSuh/codex-image-in-cc/pull/7).)
- `generate` / `edit` SKILL.md now tell the invoking model to run the command with a 10-minute Bash timeout (600000 ms): an image turn typically takes 1–3 minutes, and the default 2-minute Bash timeout can kill it mid-generation (observed live — the skill reported "in progress" and produced no file).

### Changed

- `status --json`: the `fullAuto` field is renamed to `headlessExec` to match the flag it now verifies; `fullAuto` is kept as a deprecated alias pointing at the same object.
- `package.json` and `.claude-plugin/marketplace.json` now carry the plugin version (they had been left at 0.1.0 by the 0.2.0 release, and `claude plugin validate` warned about the mismatch).

## [0.2.0] - 2026-07-10

### Added

- `/codex-image:generate` now accepts leading `--ref <path>`, `--reference <path>`, or `--image <path>` arguments and attaches them to the Codex turn as generation reference images (max 5, matching the built-in image tool's reference cap). Supersedes [#3](https://github.com/KingGyuSuh/codex-image-in-cc/pull/3) — thanks @pingguoge001-coder for the initial PR.
- `/codex-image:edit` now also names the edit target's absolute path inside the instruction text.

### Changed

- Instruction prefixes updated for the Codex CLI 0.144 image-generation extension (`image_gen.imagegen`): reference and edit-target absolute paths are listed in the instruction so the Codex-side model can pass them via `referenced_image_paths`; `codex exec --image` attachments are kept for model visibility and 0.142–0.143 compatibility.
- Minimum Codex CLI version is now v0.142.0 for current `imagegen` reference-image support; v0.144+ is recommended.
- `/codex-image:status` now checks `codex exec --image` attachment support.
- Docs: staging filenames under `~/.codex/generated_images/` are documented as version-dependent (`ig_<hash>.png` pre-0.144, `<call-id>.png` on the 0.144+ extension); only the `SAVED:` stdout contract is load-bearing.

### Fixed

- Windows: `codex` is now spawned via `node.exe` and the resolved `codex.js` entry point, fixing `spawnSync codex ENOENT` / `codex.cmd EINVAL` (Node 20+ `.cmd` hardening) without falling back to `shell: true`. Supersedes [#2](https://github.com/KingGyuSuh/codex-image-in-cc/pull/2) — thanks @pingguoge001-coder for the diagnosis, fix, and Windows 11 validation.

## [0.1.0] - 2026-04-26

### Added

- `/codex-image:generate` — generate one or more images via Codex CLI's built-in `imagegen` skill. The full slash-command argument string is passed verbatim to Codex; output paths, sizes, quality, count, transparency, etc. are expressed in natural language and interpreted by the `imagegen` skill.
- `/codex-image:edit` — edit an existing image. The first whitespace-separated token is the input path (quoted paths with spaces are supported, e.g. `"my photo.png" tint blue`); the rest is the edit prompt. Input is attached via `codex exec --image`.
- `/codex-image:status` — diagnostic for Node, Codex CLI version, login state, headless `--full-auto` support, and `imagegen` skill availability. Backed by `scripts/codex-image.mjs`.
- Apache-2.0 license.

### Notes

- Authentication flows through `codex login`. `OPENAI_API_KEY` is not required for the default built-in `image_gen` path.
- All three skills are 1-line `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" <subcommand> "$ARGUMENTS"` invocations. The Node wrapper does only arg splitting (for edit) and codex spawning with a ~6-line minimal instruction prefix. Image-generation intelligence lives entirely in Codex's bundled `imagegen` skill.
- SKILL.md bash is intentionally kept to a single-line script invocation. Putting parsing logic (`awk '...$1...'`, heredocs with substitutions) directly in SKILL.md is unsafe because the model does not always execute SKILL.md bash verbatim — see the `SKILL.md bash is not executed verbatim` entry in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for call flow and load-bearing edge cases.
