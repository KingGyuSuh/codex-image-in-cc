---
description: Generate one or more images, optionally with reference images, through Codex CLI's built-in imagegen skill
argument-hint: '[--ref <reference-image> ...] <natural-language image request>'
allowed-tools: Bash(node:*)
---

# Generate Codex Image

Leading `--ref <path>`, `--reference <path>`, or `--image <path>` arguments are reference images for generation, not edit targets. Repeat the flag for multiple references (max 5); quote paths with spaces.

This command runs a full Codex agent turn and typically takes 1–3 minutes (longer for multiple images). Run it with a 10-minute Bash timeout (600000 ms) so the turn is not killed mid-generation.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" generate "$ARGUMENTS"
```

Output rules:
- Show the command stdout to the user verbatim — Codex prints one `SAVED: <absolute path>` line per saved image.
- If the exit code is non-zero, show stderr and stop.
- Do not run any additional image generation unless the user explicitly asks for another attempt.
