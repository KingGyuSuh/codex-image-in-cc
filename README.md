# codex-image-in-cc

[![Test](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml/badge.svg)](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/KingGyuSuh/codex-image-in-cc.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)

Claude Code plugin that exposes Codex CLI's built-in `imagegen` skill as `/codex-image:*` user-invoked plugin skills.

The plugin does not implement image generation itself. Each plugin skill dispatches to `codex exec --full-auto` and lets Codex's `imagegen` skill drive the built-in `image_gen` tool, save the final artifact, and print a `SAVED: <path>` line for each output.

## Requirements

- Claude Code with plugin support.
- `@openai/codex` CLI v0.124.0 or later.
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
/codex-image:generate "5 logo variations of a brass compass on white, save under images/logos/"
/codex-image:edit input.png "Replace the background with a clean white studio backdrop, save to edited.png"
```

The full slash-command argument string is passed verbatim to Codex's `imagegen` skill. Express output paths, sizes, quality, count, transparency, etc. as natural language inside the prompt — `imagegen` interprets them. Defaults: when no path is specified, files land under `./codex-images/<UTC-timestamp>-<n>.png`.

For `/codex-image:edit`, the first whitespace-separated token is the input image path. Quote it if the path contains spaces (e.g. `/codex-image:edit "my photo.png" tint blue`).

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
