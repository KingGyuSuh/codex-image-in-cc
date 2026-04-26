---
description: Edit an image through Codex CLI's built-in imagegen skill
argument-hint: '<input-path> <natural-language edit request>'
allowed-tools: Bash(node:*)
---

# Edit Codex Image

The first whitespace-separated token in the arguments is the input image path; the rest is the edit prompt. Quote the path if it contains spaces (e.g. `"my photo.png" make it red`).

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" edit "$ARGUMENTS"
```

Output rules:
- Show the command stdout to the user verbatim — Codex prints one `SAVED: <absolute path>` line per saved image.
- If the exit code is non-zero, show stderr and stop. Common failures: missing input image, missing edit prompt.
- Do not run any additional image edits unless the user explicitly asks for another attempt.
