---
description: Generate one or more images through Codex CLI's built-in imagegen skill
argument-hint: '<natural-language image request>'
allowed-tools: Bash(node:*)
---

# Generate Codex Image

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" generate "$ARGUMENTS"
```

Output rules:
- Show the command stdout to the user verbatim — Codex prints one `SAVED: <absolute path>` line per saved image.
- If the exit code is non-zero, show stderr and stop.
- Do not run any additional image generation unless the user explicitly asks for another attempt.
