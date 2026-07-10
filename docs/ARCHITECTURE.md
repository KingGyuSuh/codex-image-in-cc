# Architecture

## Overview

`codex-image-in-cc` is a thin dispatcher. The user invokes a Claude Code slash command (`/codex-image:generate`, `/codex-image:edit`, `/codex-image:status`); the SKILL.md runs `node scripts/codex-image.mjs <subcommand> "$ARGUMENTS"`; the Node script does minimal arg handling and spawns `codex exec`; Codex's bundled `imagegen` skill drives the native `image_gen` tool and saves the artifact.

The Node script is intentionally minimal. It does NOT parse `--out` / `--size` / `--quality` flags, validate sizes, JSON-encode prompts, or otherwise interpret the user's request. It only: splits leading reference-image paths off `generate`, splits the input path off `edit`, builds a minimal instruction prefix, and execs `codex` with the right args. All image-generation intelligence lives in Codex's `imagegen` skill.

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
 │             │                   │                 │ ④ split ref/input│              │
 │             │                   │                 │   image paths    │              │
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
codex exec --full-auto --skip-git-repo-check [--image <abs-reference>...] -C <cwd> -- "<minimal instruction>

User request:

<remaining user request>"
```

for `generate`, and:

```
codex exec --full-auto --skip-git-repo-check --image <abs-input> -C <cwd> -- "<minimal instruction>

User edit request:

<raw edit request>"
```

for `edit`, both with `stdio.in = "ignore"` (equivalent to `< /dev/null`).

The minimal instruction (about 6 lines, in `scripts/codex-image.mjs`):

```
Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback.

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-<n>.png.

For each saved image, print exactly one line:
SAVED: <absolute path>

User request:

<...>
```

When `generate` receives leading `--ref <path>`, `--reference <path>`, or `--image <path>` arguments, the script strips those reference paths from the prompt, validates that the files exist, attaches each path with `codex exec --image`, and adds a short note that lists each reference's absolute path and tells the child Codex turn to treat them as generation references rather than edit targets. For `edit`, the instruction likewise names the edit target's absolute path. Listing the absolute paths in the instruction text matters on Codex CLI 0.144+ — see "Reference image attachment semantics" below.

For `/codex-image:status`, the Node script does a multi-call diagnostic that is awkward in pure Bash:

- `codex --version` — semver compare against `0.142.0`
- `codex login status` — parse "Logged in" line
- `codex exec --full-auto --help` — verify the documented headless mode is still accepted and `--image` attachment support exists
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

### Generate reference image parsing

`/codex-image:generate` accepts only a small leading flag grammar before the natural-language prompt:

- `--ref <path>`
- `--reference <path>`
- `--image <path>`

The flags are repeatable up to 5 references — the built-in image tool caps reference inputs at 5 (schema-enforced since Codex CLI 0.144), and the wrapper rejects more before spawning Codex rather than letting references be silently dropped. Quoted paths with spaces are handled by `splitFirstToken`, matching the edit path parser. The script strips only these leading flags, resolves each path against the current working directory, rejects missing files before spawning Codex, and passes each valid file as `codex exec --image <abs-path>`.

This keeps reference images mechanical while preserving the "natural language owns output control" rule: sizes, counts, quality, output paths, transparency, and creative direction still live inside the remaining prompt and are interpreted by `imagegen`.

### `--full-auto` is sufficient

Local validation on Codex CLI 0.142.0 showed the documented `--full-auto` mode runs the `imagegen` flow, copies the selected output from `~/.codex/generated_images/...`, and resizes the final artifact. Do not use the undocumented `--yolo` unless a future Codex regression proves `--full-auto` insufficient.

### Git repository is optional

The Node script passes `--skip-git-repo-check` to `codex exec` because image generation should work in asset folders and scratch workspaces, not only git repositories.

### Output path is indirect

First-hop output lands in `~/.codex/generated_images/<session-id>/...`; the `imagegen` skill then copies it into the workspace per its save-path policy. The staging filename is version-dependent — `ig_<hash>.png` on the pre-0.144 built-in tool, `<call-id>.png` on the 0.144+ extension — and the model cannot choose the output location at the tool level, so this two-hop flow holds on every supported version. The Node script's instruction asks Codex to print one `SAVED: <absolute path>` line per saved image — users (and Claude) parse stdout to learn the final locations and never depend on the staging filename.

### Resolution is not guaranteed

The built-in `image_gen` tool may return a size larger than requested (observed: 1024×1024 request → 1254×1254 response). The `imagegen` skill itself handles resize via `sips` or Pillow. Do not assume exact pixel dimensions straight out of the raw tool call.

### Edit input path parsing

`/codex-image:edit` splits `$ARGUMENTS` via a regex in `scripts/codex-image.mjs`'s `splitFirstToken`:

- Quoted first token (`"my photo.png" tint blue` or `'a b.png' brighten`) — quotes stripped, path may contain spaces.
- Unquoted first token (`photo.png make it red`) — first whitespace-separated word.

The Node check `fs.existsSync(inputPath)` rejects bad paths early with a clear message before spawning `codex`.

### Reference image attachment semantics

For generate, `--image` is an attachment mechanism, not a request to edit those files. The instruction prefix labels attached images as references, lists their absolute paths, and tells Codex to use them for style, identity, composition, mood, or subject guidance according to the user's prompt.

The conditioning mechanism changed in Codex CLI 0.144.0: image generation moved to an extension-backed tool (`image_gen.imagegen`) whose image inputs are local absolute paths the Codex-side model passes itself (`referenced_image_paths`, max 5, also used for edit targets). Attached turn images are no longer implicitly fed to the image tool. The wrapper therefore lists each reference's (and the edit target's) absolute path in the instruction text so the model can pass them to the tool, while keeping the `codex exec --image` attachments so the model can see the pixels for prompt-writing and validation — and so the 0.142–0.143 built-in tool path keeps working. The wrapper itself never calls the image tool and never passes `referenced_image_paths`; the Codex-side `imagegen` skill owns that decision.

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
- **Contract changes propagate here first.** If Codex CLI changes the headless invocation contract (`< /dev/null`, `--full-auto`, `--skip-git-repo-check`, `--image`, the `image_gen.imagegen` extension tool and its `referenced_image_paths` input, `~/.codex/generated_images/` path, `imagegen` skill id, `codex login status`), update `scripts/codex-image.mjs` and the **Load-bearing edge cases** section above in the same PR.
- **Scope is image generation.** A new Codex built-in tool (`web_search`, `browser`) deserves a separate plugin.

## Relationship to openai/codex-plugin-cc

Orthogonal and complementary.

| Plugin | Namespace | Scope |
|---|---|---|
| `openai/codex-plugin-cc` | `/codex:` | Code review, task delegation, background job lifecycle |
| `codex-image-in-cc` (this repo) | `/codex-image:` | Image generation via built-in `image_gen` |

There is no code dependency between the two. Users typically install both. If upstream decides to absorb image generation into the official plugin, this repo can be frozen or deprecated, but until then the independent release cadence is a feature, not a redundancy.
