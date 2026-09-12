#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MIN_NODE_VERSION = "18.18.0";
const MIN_CODEX_VERSION = "0.142.0";
// Contract cap of the Codex built-in image tool: at most 5 reference images per
// request (schema-enforced via `referenced_image_paths` since codex 0.144).
const MAX_REFERENCE_IMAGES = 5;

// Base headless exec invocation shared by generate and edit.
//
// `--full-auto` was the documented headless spelling through Codex CLI 0.14x. 0.144.5
// deprecated it ("use --sandbox workspace-write instead") and 0.151.0 removed it from
// `codex exec` outright (`error: unexpected argument '--full-auto' found`, exit 2),
// which broke every dispatch (#5). `--sandbox workspace-write` is the same sandbox
// policy `--full-auto` implied and is accepted by every release this plugin supports
// (verified 0.144.5 and 0.154.0 here, 0.151.0 in #5), so no per-process flag probe is
// needed.
//
// The explicit `-c approval_policy="never"` is load-bearing: bare `--sandbox
// workspace-write` drops the headless approval-never default when the user's config
// sets `approvals_reviewer = "auto_review"` (codex-rs build_exec_config rebuilds with
// approval_policy: None; verified on 0.144.5 and 0.154.0 — the header flips to
// `approval: on-request`), which would route imagegen's mkdir/cp/sips through the
// reviewer. `--full-auto` preserved approval-never implicitly; this keeps that
// contract. `--approve-for-me` (0.153+) is NOT a substitute: it selects the same
// sandbox but resolves to `approval: on-request` behind the automatic reviewer.
const CODEX_EXEC_BASE_ARGS = [
  "exec",
  "--sandbox",
  "workspace-write",
  "-c",
  'approval_policy="never"',
  "--skip-git-repo-check"
];

// On Windows, `spawn("codex", ...)` misses the npm `codex.cmd` shim (ENOENT) and
// Node 20+ refuses to spawn `.cmd` directly without a shell (EINVAL, post
// CVE-2024-27980 hardening). Shelling out would re-expose user prompts to cmd.exe
// parsing, so resolve the shim to its codex.js entry and run it with node.exe.
function resolveCodex() {
  if (process.platform !== "win32") {
    return { command: "codex", prefix: [] };
  }
  const whereResult = spawnSync("where.exe", ["codex.cmd"], {
    encoding: "utf8",
    windowsHide: true
  });
  const cmdPath = String(whereResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (cmdPath) {
    const jsPath = path.join(path.dirname(cmdPath), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(jsPath)) {
      return { command: process.execPath, prefix: [jsPath] };
    }
  }
  return { command: "codex.cmd", prefix: [] };
}

const CODEX = resolveCodex();

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

// clap rejects a flag with a multi-line usage blurb; keep a status row to its first line.
function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
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

  const codexVersion = runSync(CODEX.command, [...CODEX.prefix, "--version"], { cwd });
  const codexVersionText = (codexVersion.stdout || codexVersion.stderr).trim();
  const codexVersionCompare = compareSemver(codexVersionText, MIN_CODEX_VERSION);
  const codexOk = codexVersion.available && codexVersion.status === 0 && codexVersionCompare !== null && codexVersionCompare >= 0;

  const loginStatus = codexOk ? runSync(CODEX.command, [...CODEX.prefix, "login", "status"], { cwd }) : null;
  const loginText = loginStatus ? (loginStatus.stdout || loginStatus.stderr).trim() : "Codex unavailable";
  const loginOk = Boolean(loginStatus?.status === 0 && /logged in/i.test(loginText));

  // Headless-mode probe: `--help` exits non-zero on an unknown flag or value without
  // starting an agent turn, so this verifies the sandbox flag the wrapper dispatches with.
  const headlessExecStatus = codexOk
    ? runSync(CODEX.command, [...CODEX.prefix, "exec", "--sandbox", "workspace-write", "--help"], { cwd })
    : null;
  const headlessExecOk = Boolean(headlessExecStatus?.status === 0);

  // Probed independently of the headless flag: a rejected flag makes clap print a short
  // usage error with no option list, which used to report `--image` as missing whenever
  // the headless probe failed (#5).
  const execHelp = codexOk ? runSync(CODEX.command, [...CODEX.prefix, "exec", "--help"], { cwd }) : null;
  const execHelpText = `${execHelp?.stdout ?? ""}\n${execHelp?.stderr ?? ""}`;
  const imageAttachmentOk = Boolean(execHelp?.status === 0 && /(^|\s)(-i,\s*)?--image(\s|=|<|$)/.test(execHelpText));

  const imagegenSkillPath = findImagegenSkill();
  const imagegenOk = Boolean(imagegenSkillPath);

  const ready = nodeOk && codexOk && loginOk && headlessExecOk && imageAttachmentOk && imagegenOk;
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
  if (codexOk && !headlessExecOk) {
    nextSteps.push("This plugin depends on `codex exec --sandbox workspace-write`; check `codex exec --help` for the current sandbox flag.");
  }
  if (codexOk && !imageAttachmentOk) {
    nextSteps.push("This plugin depends on `codex exec --image` for edit and reference-image input. Upgrade Codex CLI.");
  }
  if (!imagegenOk) {
    nextSteps.push("The Codex imagegen skill was not found under CODEX_HOME. Reinstall or update Codex CLI.");
  }

  const headlessExec = {
    ok: headlessExecOk,
    detail: headlessExecOk
      ? "`codex exec --sandbox workspace-write` accepted"
      : firstLine(headlessExecStatus?.stderr || headlessExecStatus?.stdout || "not checked")
  };

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
    headlessExec,
    // Deprecated alias for `status --json` consumers written against 0.2.0.
    fullAuto: headlessExec,
    imageAttachment: {
      ok: imageAttachmentOk,
      detail: imageAttachmentOk
        ? "`codex exec --image` accepted"
        : "not found in `codex exec --help`"
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
  lines.push(statusLine(report.headlessExec.ok, "Headless exec", report.headlessExec.detail));
  lines.push(statusLine(report.imageAttachment.ok, "Image attachment", report.imageAttachment.detail));
  lines.push(statusLine(report.imagegenSkill.ok, "imagegen skill", report.imagegenSkill.path ?? "not found"));
  lines.push("");
  lines.push("Usage:");
  lines.push('  /codex-image:generate "A watercolor moonlit library, save to images/library.png at 1024x1024"');
  lines.push('  /codex-image:generate --ref style.png --ref subject.png "A poster using those references, save to images/poster.png"');
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

const REFERENCE_IMAGE_FLAGS = new Set(["--ref", "--reference", "--image"]);

function parseGenerateArguments(raw) {
  let rest = String(raw ?? "").trim();
  const referenceImages = [];

  while (rest) {
    const first = splitFirstToken(rest);
    const token = first.input;
    if (!token) {
      break;
    }

    if (token === "--") {
      rest = first.prompt ?? "";
      break;
    }

    if (REFERENCE_IMAGE_FLAGS.has(token)) {
      const next = splitFirstToken(first.prompt ?? "");
      if (!next.input || next.input.startsWith("--")) {
        throw new Error(`Missing value for ${token}.`);
      }
      referenceImages.push(next.input);
      rest = next.prompt ?? "";
      continue;
    }

    const equalsMatch = token.match(/^(--ref|--reference|--image)=(.+)$/);
    if (equalsMatch) {
      referenceImages.push(equalsMatch[2]);
      rest = first.prompt ?? "";
      continue;
    }

    break;
  }

  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `Too many reference images (${referenceImages.length}). The built-in image generation tool accepts at most ${MAX_REFERENCE_IMAGES} per request — pass the ${MAX_REFERENCE_IMAGES} most relevant.`
    );
  }

  return {
    referenceImages,
    prompt: rest.trim()
  };
}

function resolveExistingImagePaths(inputs, cwd, label) {
  return inputs.map((input) => {
    const resolved = path.resolve(cwd, input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${label} image not found: ${resolved}`);
    }
    return resolved;
  });
}

function formatReferenceImages(referenceImagePaths) {
  if (referenceImagePaths.length === 0) {
    return "";
  }
  const lines = referenceImagePaths.map((imagePath, index) => `${index + 1}. ${imagePath}`);
  return `\nReference images for generation (also attached to this turn via codex exec --image):\n${lines.join("\n")}\n\nThese are generation references, not edit targets. If your built-in image generation tool accepts local image paths (codex 0.144+, referenced_image_paths), pass the absolute paths above so the reference pixels condition the output directly; otherwise use the attachments as visual context for style, identity, composition, mood, or subject guidance according to the user's prompt. Do not modify or overwrite the referenced files.\n`;
}

const GENERATE_INSTRUCTION_PREFIX = `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-<n>.png (n=1,2,... per image).

For each saved image, print exactly one line:
SAVED: <absolute path>
`;

function buildGenerateInstruction(prompt, referenceImagePaths) {
  return `${GENERATE_INSTRUCTION_PREFIX}${formatReferenceImages(referenceImagePaths)}
User request:

${prompt}`;
}

function buildEditInstruction(inputPath, prompt) {
  return `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

The edit target image (also attached to this turn via codex exec --image):
${inputPath}

If your built-in image generation tool accepts local image paths (codex 0.144+, referenced_image_paths), pass the absolute path above as the edit reference. Preserve unrelated parts unless the user request says otherwise.

If the user did not specify an output path, save under ./codex-images/<UTC-timestamp>-edit-<n>.png (n=1,2,... per image).

For each saved image, print exactly one line:
SAVED: <absolute path>

User edit request:

${prompt}`;
}

function spawnCodex(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX.command, [...CODEX.prefix, ...args], {
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
  const raw = (argv.join(" ") || "").trim();
  let parsed;
  try {
    parsed = parseGenerateArguments(raw);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { prompt, referenceImages } = parsed;
  if (!prompt) {
    console.error("Usage: /codex-image:generate [--ref <reference-image> ...] <natural-language image request>");
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  let referenceImagePaths;
  try {
    referenceImagePaths = resolveExistingImagePaths(referenceImages, cwd, "Reference");
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const codexArgs = [...CODEX_EXEC_BASE_ARGS];
  for (const imagePath of referenceImagePaths) {
    codexArgs.push("--image", imagePath);
  }
  codexArgs.push("-C", cwd, "--", buildGenerateInstruction(prompt, referenceImagePaths));
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
  let inputPath;
  try {
    inputPath = resolveExistingImagePaths([input], cwd, "Input")[0];
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const codexArgs = [
    ...CODEX_EXEC_BASE_ARGS,
    "--image",
    inputPath,
    "-C",
    cwd,
    "--",
    buildEditInstruction(inputPath, prompt)
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
    "  status [--json] [--cwd <dir>]                Report Codex CLI prerequisites and image support",
    "  generate [--ref <path> ...] <request>         Dispatch a generate request to Codex's imagegen skill",
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
  CODEX_EXEC_BASE_ARGS,
  buildEditInstruction,
  buildGenerateInstruction,
  buildStatusReport,
  resolveCodex,
  compareSemver,
  parseSemver,
  parseGenerateArguments,
  renderStatusReport,
  splitFirstToken,
  timestampForFile
};
