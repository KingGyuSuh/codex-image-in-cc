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

// Image generation is driven by an agent turn (the "orchestrator") that calls the
// built-in image_gen tool; a stronger orchestrator interprets the prompt, conditions
// references, and holds the requested aspect more reliably. Rather than hardcode one
// model — which would break accounts that cannot access it (e.g. ChatGPT Free) — the
// wrapper queries the account's live model catalog via `codex debug models` and picks
// the FIRST ladder rung whose model is listed and whose effort that model supports.
// If the catalog is unavailable or no rung matches, no model/effort is forced and
// codex falls back to its own config default (the pre-ladder behavior), so this never
// regresses generation.
const CODEX_IMAGE_ORCHESTRATOR_LADDER = [
  { model: "gpt-5.6-luna", effort: "high" },
  { model: "gpt-5.6-terra", effort: "medium" },
  { model: "gpt-5.6-sol", effort: "high" },
  { model: "gpt-5.6-sol", effort: "low" }
];

// Reasoning efforts codex accepts, used only to validate an explicit env override.
const CODEX_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

// Explicit override: set BOTH to force a specific orchestrator, bypassing the ladder
// and the catalog probe (the user is asserting the model is available to them).
const ORCHESTRATOR_MODEL_ENV = "CODEX_IMAGE_MODEL";
const ORCHESTRATOR_EFFORT_ENV = "CODEX_IMAGE_EFFORT";

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
    maxBuffer: options.maxBuffer,
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

// ---------------------------------------------------------------------------
// Image orchestrator selection (model + reasoning effort)
// ---------------------------------------------------------------------------

// Parse `codex debug models` JSON into slug -> Set(supported efforts), keeping only
// account-selectable models (visibility "list"). Best-effort: returns an empty Map on
// any shape it does not recognize so callers fall back to the codex default.
function parseModelCatalog(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return new Map();
  }
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // `codex debug models` prints a single JSON object; if anything ever wraps it,
    // fall back to the outermost object rather than giving up on selection.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  const models = parsed && Array.isArray(parsed.models) ? parsed.models : null;
  const catalog = new Map();
  if (!models) {
    return catalog;
  }
  for (const model of models) {
    if (!model || typeof model.slug !== "string" || model.visibility !== "list") {
      continue;
    }
    const efforts = new Set();
    if (Array.isArray(model.supported_reasoning_levels)) {
      for (const level of model.supported_reasoning_levels) {
        if (level && typeof level.effort === "string") {
          efforts.add(level.effort);
        }
      }
    }
    catalog.set(model.slug, efforts);
  }
  return catalog;
}

// Query the account's live model catalog. Best-effort and side-effect free: any
// failure (codex missing, not logged in, offline) returns null and the caller uses
// the codex config default rather than failing the generate/edit.
function loadModelCatalog(cwd) {
  const result = runSync(CODEX.command, [...CODEX.prefix, "debug", "models"], {
    cwd,
    maxBuffer: 32 * 1024 * 1024
  });
  if (!result.available || result.status !== 0) {
    return null;
  }
  return parseModelCatalog(result.stdout);
}

// Walk the ladder top-to-bottom; return the first rung whose model is in the catalog
// and whose effort that model supports. null if the catalog is missing or no rung fits.
function selectOrchestratorFromLadder(catalog, ladder = CODEX_IMAGE_ORCHESTRATOR_LADDER) {
  if (!catalog) {
    return null;
  }
  for (const rung of ladder) {
    const efforts = catalog.get(rung.model);
    if (efforts && efforts.has(rung.effort)) {
      return { model: rung.model, effort: rung.effort };
    }
  }
  return null;
}

// Resolve the orchestrator from an explicit env override or the ladder+catalog.
// Pure: the catalog is passed in, so this is unit-testable without spawning codex.
// - Both env vars set   -> use them (effort validated), source "env".
// - Exactly one env set -> throw (an override must be explicit on both axes).
// - Neither env set     -> first available ladder rung, source "ladder"; null if none.
function resolveImageOrchestrator({ envModel, envEffort, catalog } = {}) {
  const model = typeof envModel === "string" ? envModel.trim() : "";
  const effort = typeof envEffort === "string" ? envEffort.trim().toLowerCase() : "";
  if (Boolean(model) !== Boolean(effort)) {
    throw new Error(
      `${ORCHESTRATOR_MODEL_ENV} and ${ORCHESTRATOR_EFFORT_ENV} must be set together so the image orchestrator override is explicit.`
    );
  }
  if (model && effort) {
    if (!CODEX_REASONING_EFFORTS.has(effort)) {
      throw new Error(
        `Invalid ${ORCHESTRATOR_EFFORT_ENV}=${effort}; expected one of ${[...CODEX_REASONING_EFFORTS].join("|")}.`
      );
    }
    return { model, effort, source: "env" };
  }
  const picked = selectOrchestratorFromLadder(catalog);
  return picked ? { ...picked, source: "ladder" } : null;
}

// Impure wrapper: read env, probe the catalog only when no env override is present
// (the override bypasses the probe), and resolve. Throws only on an inconsistent env
// override; a catalog failure degrades to the codex default (null).
function resolveOrchestrator(cwd) {
  const envModel = process.env[ORCHESTRATOR_MODEL_ENV];
  const envEffort = process.env[ORCHESTRATOR_EFFORT_ENV];
  const hasEnv = Boolean(envModel?.trim()) || Boolean(envEffort?.trim());
  const catalog = hasEnv ? null : loadModelCatalog(cwd);
  return resolveImageOrchestrator({ envModel, envEffort, catalog });
}

// codex exec flags for a resolved orchestrator ([] when null => codex config default).
// The `-c` value is TOML: JSON.stringify quotes the effort so codex parses a string.
function orchestratorArgs(orchestrator) {
  if (!orchestrator) {
    return [];
  }
  return [
    "-m",
    orchestrator.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(orchestrator.effort)}`
  ];
}

// Human-readable orchestrator line for `status`. Never throws: an inconsistent env
// override is surfaced as a not-ok row so status can flag it instead of crashing.
function describeOrchestrator(cwd) {
  try {
    const orchestrator = resolveOrchestrator(cwd);
    if (!orchestrator) {
      return {
        ok: true,
        detail:
          "codex config default (no ladder model available for this account; generation still works)"
      };
    }
    return {
      ok: true,
      detail: `${orchestrator.model} (effort ${orchestrator.effort}) [${orchestrator.source}]`
    };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
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

  const headlessExecStatus = codexOk
    ? runSync(CODEX.command, [...CODEX.prefix, "exec", "--sandbox", "workspace-write", "--help"], { cwd })
    : null;
  const headlessExecOk = Boolean(headlessExecStatus?.status === 0);
  const execHelpText = `${headlessExecStatus?.stdout ?? ""}\n${headlessExecStatus?.stderr ?? ""}`;
  const imageAttachmentOk = Boolean(headlessExecOk && /(^|\s)(-i,\s*)?--image(\s|=|<|$)/.test(execHelpText));

  const imagegenSkillPath = findImagegenSkill();
  const imagegenOk = Boolean(imagegenSkillPath);

  const orchestrator = codexOk
    ? describeOrchestrator(cwd)
    : { ok: true, detail: "not checked (codex unavailable)" };

  const ready =
    nodeOk && codexOk && loginOk && headlessExecOk && imageAttachmentOk && imagegenOk && orchestrator.ok;
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
    nextSteps.push("This plugin depends on `codex exec --sandbox workspace-write`; verify the installed Codex CLI still supports that documented mode.");
  }
  if (codexOk && headlessExecOk && !imageAttachmentOk) {
    nextSteps.push("This plugin depends on `codex exec --image` for edit and reference-image input. Upgrade Codex CLI.");
  }
  if (!imagegenOk) {
    nextSteps.push("The Codex imagegen skill was not found under CODEX_HOME. Reinstall or update Codex CLI.");
  }
  if (codexOk && !orchestrator.ok) {
    nextSteps.push(`Fix the image orchestrator override: ${orchestrator.detail}`);
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
    headlessExec: {
      ok: headlessExecOk,
      detail: headlessExecOk
        ? "`codex exec --sandbox workspace-write` accepted"
        : (headlessExecStatus?.stderr || headlessExecStatus?.stdout || "not checked").trim()
    },
    imageAttachment: {
      ok: imageAttachmentOk,
      detail: imageAttachmentOk
        ? "`codex exec --image` accepted"
        : "not found in `codex exec --help`"
    },
    imagegenSkill: { ok: imagegenOk, path: imagegenSkillPath },
    orchestrator,
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
  lines.push(statusLine(report.orchestrator.ok, "Image orchestrator", report.orchestrator.detail));
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
  let orchestrator;
  try {
    orchestrator = resolveOrchestrator(cwd);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (orchestrator) {
    console.error(
      `codex image orchestrator: ${orchestrator.model} (effort ${orchestrator.effort}) [${orchestrator.source}]`
    );
  }
  const codexArgs = [
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    ...orchestratorArgs(orchestrator)
  ];
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
  let orchestrator;
  try {
    orchestrator = resolveOrchestrator(cwd);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (orchestrator) {
    console.error(
      `codex image orchestrator: ${orchestrator.model} (effort ${orchestrator.effort}) [${orchestrator.source}]`
    );
  }
  const codexArgs = [
    "exec",
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    ...orchestratorArgs(orchestrator),
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
  buildEditInstruction,
  buildGenerateInstruction,
  buildStatusReport,
  resolveCodex,
  compareSemver,
  parseSemver,
  parseGenerateArguments,
  parseModelCatalog,
  selectOrchestratorFromLadder,
  resolveImageOrchestrator,
  orchestratorArgs,
  CODEX_IMAGE_ORCHESTRATOR_LADDER,
  renderStatusReport,
  splitFirstToken,
  timestampForFile
};
