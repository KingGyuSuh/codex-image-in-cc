# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-17

### Added

- Image generation now selects a stronger **orchestrator model and reasoning effort** when the account has one. The wrapper probes `codex debug models` and passes `-m` / `-c model_reasoning_effort` for the first available rung of a preference ladder (`gpt-5.6-luna` high → `gpt-5.6-terra` medium → `gpt-5.6-sol` high → `gpt-5.6-sol` low). Accounts without those models (e.g. ChatGPT Free) or an offline probe transparently fall back to the Codex config default, so generation never regresses. Override with `CODEX_IMAGE_MODEL` + `CODEX_IMAGE_EFFORT` (both required, or the wrapper errors). `/codex-image:status` now reports the resolved orchestrator.

### Changed

- `generate` and `edit` now spawn `codex exec --sandbox workspace-write` instead of the deprecated `--full-auto`. Codex CLI 0.144.5 warns that `--full-auto` is deprecated and has dropped it from `codex exec --help`; both spellings resolve to the same `workspace-write` sandbox with `approval: never`, so behavior is unchanged and the warning is gone. `/codex-image:status` checks the new flag accordingly.
- `status --json`: the `fullAuto` field is renamed to `headlessExec` to match the flag it now verifies.
- `generate` / `edit` SKILL.md now tell the invoking model to run the command with a 10-minute Bash timeout (600000 ms): an image turn typically takes 1–3 minutes, and the default 2-minute Bash timeout can kill it mid-generation (observed live — the skill reported "in progress" and produced no file).

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
