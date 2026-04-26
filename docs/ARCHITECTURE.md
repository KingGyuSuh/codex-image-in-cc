# Architecture

## Overview

`codex-image-in-cc` is a thin dispatcher. The user invokes a Claude Code slash command (`/codex-image:generate`, `/codex-image:edit`, `/codex-image:status`); the SKILL.md runs `node scripts/codex-image.mjs <subcommand> "$ARGUMENTS"`; the Node script does minimal arg handling and spawns `codex exec`; Codex's bundled `imagegen` skill drives the native `image_gen` tool and saves the artifact.

The Node script is intentionally minimal. It does NOT parse `--out` / `--size` / `--quality` flags, validate sizes, JSON-encode prompts, or otherwise interpret the user's request. It only: splits the input path off the prompt (for edit), builds a minimal instruction prefix, and execs `codex` with the right args. All image-generation intelligence lives in Codex's `imagegen` skill.

## Repository layout

```
codex-image-in-cc/
├── .claude-plugin/
│   ├── plugin.json              # Claude Code plugin manifest
│   └── marketplace.json         # local/GitHub marketplace manifest
├── skills/                       # user-invoked Claude Code plugin skills
│   ├── generate/SKILL.md        # 1-line: node script generate "$ARGUMENTS"
│   ├── edit/SKILL.md            # 1-line: node script edit "$ARGUMENTS"
│   └── status/SKILL.md          # 1-line: node script status "$ARGUMENTS"
├── scripts/
│   └── codex-image.mjs           # status diagnostic + generate/edit dispatcher
├── tests/
│   └── codex-image.test.mjs      # unit tests for pure functions
├── docs/
│   └── ARCHITECTURE.md           # this file
├── .github/                      # issue and PR templates
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── LICENSE                       # Apache-2.0
├── README.md
└── package.json
```

## Call flow

```
User      Claude Code      Bash (SKILL.md)     Node script        Codex CLI       image_gen
 │             │                   │                 │                  │              │
 │ /codex-image:generate "..."     │                 │                  │              │
 ├────────────►│                   │                 │                  │              │
 │             │ ① match SKILL.md  │                 │                  │              │
 │             │ ② run 1-line bash │                 │                  │              │
 │             ├──────────────────►│                 │                  │              │
 │             │                   │ ③ node script   │                  │              │
 │             │                   │   generate "$A" │                  │              │
 │             │                   ├────────────────►│                  │              │
 │             │                   │                 │ ④ split path     │              │
 │             │                   │                 │   (edit only)    │              │
 │             │                   │                 │ ⑤ build args +   │              │
 │             │                   │                 │   instruction    │              │
 │             │                   │                 │ ⑥ spawn codex    │              │
 │             │                   │                 │   stdio.in=ignore│              │
 │             │                   │                 ├─────────────────►│              │
 │             │                   │                 │                  │ ⑦ imagegen   │
 │             │                   │                 │                  ├─────────────►│
 │             │                   │                 │                  │◄─────────────┤
 │             │                   │                 │                  │ ⑧ save +     │
 │             │                   │                 │                  │   "SAVED:"   │
 │             │                   │                 │ ⑨ stdout/stderr  │              │
 │             │                   │                 │   pass-through   │              │
 │             │                   │                 │◄─────────────────┤              │
 │             │                   │ ⑩ stdout passes through            │              │
 │             │                   │◄────────────────┤                  │              │
 │             │ ⑪ show stdout     │                 │                  │              │
 │◄────────────┤                   │                 │                  │              │
```

The actual `codex` invocation:

```
codex exec --full-auto --skip-git-repo-check [--image <abs-input>] -C <cwd> -- "<minimal instruction>

User request:

<raw user request>"
```

with `stdio.in = "ignore"` (equivalent to `< /dev/null`).

The minimal instruction (about 6 lines, in `scripts/codex-image.mjs`):

```
Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback.

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-<n>.png.

For each saved image, print exactly one line:
SAVED: <absolute path>

User request:

<...>
```

For `/codex-image:status`, the Node script does a multi-call diagnostic that is awkward in pure Bash:

- `codex --version` — semver compare against `0.124.0`
- `codex login status` — parse "Logged in" line
- `codex exec --full-auto --help` — verify the documented headless mode is still accepted
- File check on `~/.codex/skills/.system/imagegen/SKILL.md`

## Load-bearing edge cases

Contracts the plugin depends on. Each lives directly in `scripts/codex-image.mjs` — keep them aligned with this section in the same PR.

### SKILL.md bash is NOT executed verbatim

When a slash command runs, Claude Code passes the SKILL.md template (with `$ARGUMENTS` substituted) to the model, and the model decides what bash to actually run. Empirically the model:

- Pre-evaluates `$(...)` command substitutions in its head and inlines the results.
- May treat literal `$1` / `$N` inside single-quoted strings as bash positionals to substitute.
- Sometimes typos `==` to `=` when paraphrasing.

This means **SKILL.md bash must not contain in-bash parsing logic**. Any `awk '...$1...'`, `cut`, `${RAW%% *}` etc. inside the SKILL.md script is at risk of model-side rewriting. The mitigation is to keep SKILL.md to a single-line invocation of a Node script and do all parsing inside Node (which the model does not see or rewrite).

This is the reason `scripts/codex-image.mjs` exists for `generate` / `edit` even though the plugin's spirit is "stay thin".

### stdin trap

`codex exec` must be invoked with stdin redirected to `/dev/null` (or `stdio: "ignore"` in Node) in non-TTY contexts. Without it, it treats piped stdin as an appendable `<stdin>` block and hangs waiting for EOF. This is not obvious from `codex exec --help`. The Node script uses `stdio: ["ignore", "inherit", "inherit"]` for this reason.

### Quoted-arg passing through Bash → Node → Codex

The SKILL.md bash is `node ... <subcommand> "$ARGUMENTS"`. Claude Code substitutes `$ARGUMENTS` into the bash text before bash parses it. The double quotes around `"$ARGUMENTS"` ensure bash treats the substituted text as one positional argument to Node, even if it contains spaces or shell metacharacters. Node receives it as a single string in `process.argv`. Codex receives the prompt as a single argv element from Node's `spawn` call (no shell re-interpretation).

`$(...)`, backticks, and `$X` in the user's prompt therefore reach Codex as literal text.

### `--full-auto` is sufficient

Local validation on Codex CLI 0.124.0 showed the documented `--full-auto` mode runs the `imagegen` flow, copies the selected output from `~/.codex/generated_images/...`, and resizes the final artifact. Do not use the undocumented `--yolo` unless a future Codex regression proves `--full-auto` insufficient.

### Git repository is optional

The Node script passes `--skip-git-repo-check` to `codex exec` because image generation should work in asset folders and scratch workspaces, not only git repositories.

### Output path is indirect

First-hop output lands in `~/.codex/generated_images/<session-uuid>/ig_*.png`; the `imagegen` skill then copies it into the workspace per its save-path policy. The Node script's instruction asks Codex to print one `SAVED: <absolute path>` line per saved image — users (and Claude) parse stdout to learn the final locations.

### Resolution is not guaranteed

The built-in `image_gen` tool may return a size larger than requested (observed: 1024×1024 request → 1254×1254 response). The `imagegen` skill itself handles resize via `sips` or Pillow. Do not assume exact pixel dimensions straight out of the raw tool call.

### Edit input path parsing

`/codex-image:edit` splits `$ARGUMENTS` via a regex in `scripts/codex-image.mjs`'s `splitFirstToken`:

- Quoted first token (`"my photo.png" tint blue` or `'a b.png' brighten`) — quotes stripped, path may contain spaces.
- Unquoted first token (`photo.png make it red`) — first whitespace-separated word.

The Node check `fs.existsSync(inputPath)` rejects bad paths early with a clear message before spawning `codex`.

### Token accounting

Agent tokens count against the user's Codex usage limits; a typical single-image `quality=low` turn is around 30k agent tokens on top of the image-generation cost itself. Do not hide this from users.

## Why so thin?

An earlier iteration of `scripts/codex-image.mjs` was 600 lines that:

- Parsed `--out` / `--size` / `--quality` / `--force` / `--dry-run` flags.
- Built a 27-line "control fields are authoritative" English instruction with JSON-encoded prompt, redundant guards, and prose preambles.
- Validated PNG dimensions and pretty-printed metadata.

Two problems pushed the simplification:

1. **Flattening user intent.** A single `--out` flag couldn't represent multi-image requests ("5 logo variations") that `imagegen` handles natively.
2. **Distrusting the receiver.** Codex CLI is itself an LLM agent harness. The wrapper's prose lectures duplicated guards already present inside `imagegen`.

A second iteration tried to remove the Node wrapper entirely for `generate` / `edit` and put a Bash heredoc directly in SKILL.md. That broke on the "SKILL.md bash is not verbatim" edge case above — the model rewrote the bash, sometimes incorrectly.

The current architecture is the synthesis: a thin Node wrapper does only the things that NEED a deterministic environment (arg split, codex spawn, exit-code propagation) with a minimal ~6-line instruction prefix. Everything else — prompt augmentation, transparency, validation, save-path policy, multi-image handling, resize — stays in Codex's `imagegen` skill.

## Maintenance discipline

- **Stay thin.** The Node wrapper does arg splitting and codex spawning. Nothing else. Image-generation intelligence lives in `imagegen`.
- **No in-bash parsing in SKILL.md.** Single-line `node script <cmd> "$ARGUMENTS"` only. Anything more complex must live in the Node script.
- **Contract changes propagate here first.** If Codex CLI changes the headless invocation contract (`< /dev/null`, `--full-auto`, `--skip-git-repo-check`, `--image`, `~/.codex/generated_images/` path, `imagegen` skill id, `image_gen` tool name, `codex login status`), update `scripts/codex-image.mjs` and the **Load-bearing edge cases** section above in the same PR.
- **Scope is image generation.** A new Codex built-in tool (`web_search`, `browser`) deserves a separate plugin.

## Relationship to openai/codex-plugin-cc

Orthogonal and complementary.

| Plugin | Namespace | Scope |
|---|---|---|
| `openai/codex-plugin-cc` | `/codex:` | Code review, task delegation, background job lifecycle |
| `codex-image-in-cc` (this repo) | `/codex-image:` | Image generation via built-in `image_gen` |

There is no code dependency between the two. Users typically install both. If upstream decides to absorb image generation into the official plugin, this repo can be frozen or deprecated, but until then the independent release cadence is a feature, not a redundancy.
