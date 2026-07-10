---
description: Generate one or more images, optionally with reference images, through Codex CLI's built-in imagegen skill
argument-hint: '[--ref <reference-image> ...] <natural-language image request>'
allowed-tools: Bash(node:*)
---

# Generate Codex Image

Leading `--ref <path>`, `--reference <path>`, or `--image <path>` arguments are reference images for generation, not edit targets. Repeat the flag for multiple references (max 5); quote paths with spaces.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" generate "$ARGUMENTS"
```

Output rules:
- Show the command stdout to the user verbatim — Codex prints one `SAVED: <absolute path>` line per saved image.
- If the exit code is non-zero, show stderr and stop.
- Do not run any additional image generation unless the user explicitly asks for another attempt.
