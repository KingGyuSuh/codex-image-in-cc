#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MIN_NODE_VERSION = "18.18.0";
const MIN_CODEX_VERSION = "0.124.0";

function parseSemver(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
}

function compareSemver(a, b) {
  const left = Array.isArray(a) ? a : parseSemver(a);
  const right = Array.isArray(b) ? b : parseSemver(b);
  if (!left || !right) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }
  return 0;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "").replace("T", "-");
}

function parseStatusOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--cwd" || token.startsWith("--cwd=")) {
      const eq = token.indexOf("=");
      const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --cwd.");
      }
      options.cwd = value;
      if (eq === -1) {
        index += 1;
      }
      continue;
    }
    if (token === "--help" || token === "-h" || token === "help") {
      options.help = true;
      continue;
    }
  }
  return options;
}

function resolveCwd(options) {
  return path.resolve(process.cwd(), options.cwd ?? ".");
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    input: options.input,
    stdio: "pipe",
    windowsHide: true
  });

  return {
    available: !(result.error && result.error.code === "ENOENT"),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function statusLine(ok, label, detail) {
  return `${ok ? "OK" : "FAIL"} ${label}: ${detail}`;
}

function findImagegenSkill() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const candidate = path.join(codexHome, "skills", ".system", "imagegen", "SKILL.md");
  return fs.existsSync(candidate) ? candidate : null;
}

function buildStatusReport(options = {}) {
  const cwd = resolveCwd(options);
  const nodeVersion = process.versions.node;
  const nodeVersionCompare = compareSemver(nodeVersion, MIN_NODE_VERSION);
  const nodeOk = nodeVersionCompare !== null && nodeVersionCompare >= 0;

  const codexVersion = runSync("codex", ["--version"], { cwd });
  const codexVersionText = (codexVersion.stdout || codexVersion.stderr).trim();
  const codexVersionCompare = compareSemver(codexVersionText, MIN_CODEX_VERSION);
  const codexOk = codexVersion.available && codexVersion.status === 0 && codexVersionCompare !== null && codexVersionCompare >= 0;

  const loginStatus = codexOk ? runSync("codex", ["login", "status"], { cwd }) : null;
  const loginText = loginStatus ? (loginStatus.stdout || loginStatus.stderr).trim() : "Codex unavailable";
  const loginOk = Boolean(loginStatus?.status === 0 && /logged in/i.test(loginText));

  const fullAutoStatus = codexOk ? runSync("codex", ["exec", "--full-auto", "--help"], { cwd }) : null;
  const fullAutoOk = Boolean(fullAutoStatus?.status === 0);

  const imagegenSkillPath = findImagegenSkill();
  const imagegenOk = Boolean(imagegenSkillPath);

  const ready = nodeOk && codexOk && loginOk && fullAutoOk && imagegenOk;
  const nextSteps = [];
  if (!nodeOk) {
    nextSteps.push(`Install Node.js ${MIN_NODE_VERSION} or newer.`);
  }
  if (!codexVersion.available) {
    nextSteps.push("Install Codex CLI with `npm install -g @openai/codex`.");
  } else if (!codexOk) {
    nextSteps.push(`Upgrade Codex CLI to ${MIN_CODEX_VERSION} or newer with \`npm install -g @openai/codex\`.`);
  }
  if (codexOk && !loginOk) {
    nextSteps.push("Run `codex login`.");
  }
  if (codexOk && !fullAutoOk) {
    nextSteps.push("This plugin depends on `codex exec --full-auto`; verify the installed Codex CLI still supports that documented alias.");
  }
  if (!imagegenOk) {
    nextSteps.push("The Codex imagegen skill was not found under CODEX_HOME. Reinstall or update Codex CLI.");
  }

  return {
    ready,
    cwd,
    node: { ok: nodeOk, version: nodeVersion, minimum: MIN_NODE_VERSION },
    codex: {
      ok: codexOk,
      available: codexVersion.available,
      version: codexVersionText || codexVersion.error?.message || "not found",
      minimum: MIN_CODEX_VERSION
    },
    login: { ok: loginOk, detail: loginText || "not logged in" },
    fullAuto: {
      ok: fullAutoOk,
      detail: fullAutoOk
        ? "`codex exec --full-auto` accepted"
        : (fullAutoStatus?.stderr || fullAutoStatus?.stdout || "not checked").trim()
    },
    imagegenSkill: { ok: imagegenOk, path: imagegenSkillPath },
    nextSteps
  };
}

function renderStatusReport(report) {
  const lines = ["Codex Image status", "", `Ready: ${report.ready ? "yes" : "no"}`, ""];
  lines.push(statusLine(report.node.ok, "Node", `v${report.node.version} (minimum ${report.node.minimum})`));
  lines.push(statusLine(report.codex.ok, "Codex", `${report.codex.version} (minimum ${report.codex.minimum})`));
  lines.push(statusLine(report.login.ok, "Codex login", report.login.detail));
  lines.push(statusLine(report.fullAuto.ok, "Headless exec", report.fullAuto.detail));
  lines.push(statusLine(report.imagegenSkill.ok, "imagegen skill", report.imagegenSkill.path ?? "not found"));
  lines.push("");
  lines.push("Usage:");
  lines.push('  /codex-image:generate "A watercolor moonlit library, save to images/library.png at 1024x1024"');
  lines.push('  /codex-image:edit input.png "Replace the background with a clean white studio backdrop"');
  lines.push("");
  lines.push("Cost note: image generation runs a Codex agent turn and uses the Codex built-in image generation tool.");

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

function splitFirstToken(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { input: null, prompt: null };
  }
  const quoted = text.match(/^(['"])((?:\\.|(?!\1).)+)\1(?:\s+([\s\S]+))?$/);
  if (quoted) {
    return { input: quoted[2], prompt: (quoted[3] ?? "").trim() };
  }
  const unquoted = text.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (unquoted) {
    return { input: unquoted[1], prompt: (unquoted[2] ?? "").trim() };
  }
  return { input: null, prompt: null };
}

const GENERATE_INSTRUCTION_PREFIX = `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-<n>.png (n=1,2,... per image).

For each saved image, print exactly one line:
SAVED: <absolute path>

User request:

`;

const EDIT_INSTRUCTION_PREFIX = `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

The image attached via --image is the edit target. Preserve unrelated parts unless the user request says otherwise.

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-edit-<n>.png (n=1,2,... per image).

For each saved image, print exactly one line:
SAVED: <absolute path>

User edit request:

`;

function spawnCodex(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status: status ?? (signal ? 1 : 0) });
    });
  });
}

async function handleGenerate(argv) {
  const prompt = (argv.join(" ") || "").trim();
  if (!prompt) {
    console.error("Usage: /codex-image:generate <natural-language image request>");
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const codexArgs = [
    "exec",
    "--full-auto",
    "--skip-git-repo-check",
    "-C",
    cwd,
    "--",
    GENERATE_INSTRUCTION_PREFIX + prompt
  ];
  const result = await spawnCodex(codexArgs, cwd);
  if (result.status !== 0) {
    process.exitCode = result.status;
  }
}

async function handleEdit(argv) {
  const raw = argv.join(" ").trim();
  const { input, prompt } = splitFirstToken(raw);
  if (!input || !prompt) {
    console.error("Usage: /codex-image:edit <input-path> <edit instructions>");
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const inputPath = path.resolve(cwd, input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input image not found: ${inputPath}`);
    process.exitCode = 1;
    return;
  }
  const codexArgs = [
    "exec",
    "--full-auto",
    "--skip-git-repo-check",
    "--image",
    inputPath,
    "-C",
    cwd,
    "--",
    EDIT_INSTRUCTION_PREFIX + prompt
  ];
  const result = await spawnCodex(codexArgs, cwd);
  if (result.status !== 0) {
    process.exitCode = result.status;
  }
}

function handleStatus(argv) {
  const options = parseStatusOptions(argv);
  if (options.help) {
    console.log("Usage: /codex-image:status");
    return;
  }
  const report = buildStatusReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderStatusReport(report));
  }
  if (!report.ready) {
    process.exitCode = 1;
  }
}

function usage() {
  return [
    "Usage: node scripts/codex-image.mjs <command> [args]",
    "",
    "Commands:",
    "  status [--json] [--cwd <dir>]                Report Codex CLI prerequisites and login state",
    "  generate <natural-language image request>    Dispatch a generate request to Codex's imagegen skill",
    "  edit <input-path> <edit instructions>        Dispatch an edit request to Codex's imagegen skill (codex exec --image)",
    "",
    "Each command is also exposed as a Claude Code plugin skill:",
    "  /codex-image:status",
    "  /codex-image:generate <...>",
    "  /codex-image:edit <input-path> <...>"
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  // `setup` kept as backwards-compatible alias for the renamed `status` command.
  if (command === "status" || command === "setup") {
    handleStatus(rest);
    return;
  }

  if (command === "generate") {
    await handleGenerate(rest);
    return;
  }

  if (command === "edit") {
    await handleEdit(rest);
    return;
  }

  throw new Error(`Unknown command "${command}".\n${usage()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

export {
  buildStatusReport,
  compareSemver,
  parseSemver,
  renderStatusReport,
  splitFirstToken,
  timestampForFile
};
