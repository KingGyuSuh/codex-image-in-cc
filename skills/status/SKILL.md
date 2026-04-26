---
description: Report Codex CLI prerequisites and login status for image generation
argument-hint: ''
allowed-tools: Bash(node:*)
---

# Codex Image Status

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" status "$ARGUMENTS"
```

Output rules:
- Present the status output to the user.
- If status reports that Codex is not installed, tell the user to install it with `npm install -g @openai/codex`.
- If status reports that Codex is not authenticated, tell the user to run `codex login`.
- If status reports the imagegen skill is missing, tell the user to update Codex CLI (`npm install -g @openai/codex@latest`).
