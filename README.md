# codex-image-in-cc

[![Test](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml/badge.svg)](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/KingGyuSuh/codex-image-in-cc.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)

Claude Code plugin that exposes Codex CLI's built-in `imagegen` skill as `/codex-image:*` user-invoked plugin skills.

The plugin does not implement image generation itself. Each plugin skill dispatches to `codex exec --sandbox workspace-write` and lets Codex's `imagegen` skill drive the built-in `image_gen` tool, use attached reference/edit images, save the final artifact, and print a `SAVED: <path>` line for each output.

## Requirements

- Claude Code with plugin support.
- `@openai/codex` CLI v0.142.0 or later (v0.144+ recommended — it moves image generation to the extension-backed tool the instruction prefixes are written for).
- An active `codex login` session.
- Node.js 18.18 or later.

`OPENAI_API_KEY` is not required for the default built-in path. Codex can use either a ChatGPT login or API-key login.

## Install

### From GitHub (recommended)

```bash
claude plugin marketplace add KingGyuSuh/codex-image-in-cc
claude plugin install codex-image@codex-image-in-cc
```

### From a local clone

```bash
git clone https://github.com/KingGyuSuh/codex-image-in-cc.git
cd codex-image-in-cc
claude plugin marketplace add "$PWD"
claude plugin install codex-image@codex-image-in-cc
```

Then restart Claude Code if needed. Default install scope is `user`; pass `--scope project` or `--scope local` to limit installation.

## Plugin Skills

```bash
/codex-image:status
/codex-image:generate "A watercolor moonlit library, save to images/library.png at 1024x1024"
/codex-image:generate --ref style.png --ref "character ref.png" "A 9:16 scene using those references, save to images/scene.png"
/codex-image:generate "5 logo variations of a brass compass on white, save under images/logos/"
/codex-image:edit input.png "Replace the background with a clean white studio backdrop, save to edited.png"
```

Apart from leading reference-image flags on `generate` and the input-path split on `edit`, the natural-language prompt is passed through to Codex's `imagegen` skill. Express output paths, sizes, quality, count, transparency, etc. as natural language inside the prompt — `imagegen` interprets them. Defaults: when no path is specified, files land under `./codex-images/<UTC-timestamp>-<n>.png`.

For `/codex-image:generate`, leading `--ref <path>`, `--reference <path>`, or `--image <path>` arguments are attached to the Codex turn via `codex exec --image` and treated as generation references, not edit targets. Repeat the flag for multiple references (at most 5 — the built-in image tool's reference cap). Quote paths with spaces. Use `--` before the prompt if the prompt itself starts with a flag-like token.

For `/codex-image:edit`, the first whitespace-separated token is the input image path. Quote it if the path contains spaces (e.g. `/codex-image:edit "my photo.png" tint blue`).

## Image model

Image generation runs as a Codex agent turn (the "orchestrator") that calls the built-in image tool. The plugin picks a stronger orchestrator model/effort when your account has one, without breaking accounts that don't: it reads your live model catalog via `codex debug models` and selects the first available rung of a preference ladder —

`gpt-5.6-luna` high → `gpt-5.6-terra` medium → `gpt-5.6-sol` high → `gpt-5.6-sol` low

If none of those are available to your account (for example on ChatGPT Free), or the probe fails, the plugin passes no model flag and Codex uses its own configured default — image generation still works. `/codex-image:status` shows which orchestrator was resolved.

To force a specific model and effort, set **both** environment variables (setting only one is an error):

```bash
export CODEX_IMAGE_MODEL=gpt-5.6-terra
export CODEX_IMAGE_EFFORT=high   # none|minimal|low|medium|high|xhigh|max|ultra
```

## Development

```bash
npm test
npm run validate:plugin
npm run status
claude --plugin-dir .
```

After editing plugin skills during a `claude --plugin-dir .` session, run `/reload-plugins`.

Image generation consumes a Codex agent turn plus the built-in image generation tool usage.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for scope, dev setup, and PR conventions, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the call flow and load-bearing edge cases. Security issues — see [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE).
