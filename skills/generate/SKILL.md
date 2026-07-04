---
description: Generate one or more images through Codex CLI's built-in imagegen skill
argument-hint: '[--image <path>]... <natural-language image request>'
allowed-tools: Bash(node:*)
---

# Generate Codex Image

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" generate "$ARGUMENTS"
```

Reference images (optional):
- Pass `--image <path>` before the prompt to attach a reference image. The flag is repeatable — use it once per reference.
- Both `--image <path>` and `--image=<path>` forms are accepted. Paths are resolved against the current working directory; missing files abort the run.
- Referenced images are treated as **style / composition / subject references** (generate mode), not edit targets. To modify a specific image, use `/codex-image:edit` instead.

Output rules:
- Show the command stdout to the user verbatim — Codex prints one `SAVED: <absolute path>` line per saved image.
- If the exit code is non-zero, show stderr and stop.
- Do not run any additional image generation unless the user explicitly asks for another attempt.
