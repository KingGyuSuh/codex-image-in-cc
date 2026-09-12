import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_EXEC_BASE_ARGS,
  buildEditInstruction,
  buildGenerateInstruction,
  compareSemver,
  parseGenerateArguments,
  parseModelCatalog,
  selectOrchestratorFromLadder,
  resolveImageOrchestrator,
  orchestratorArgs,
  resolveCodex,
  splitFirstToken,
  timestampForFile
} from "../scripts/codex-image.mjs";

// A trimmed-down `codex debug models` catalog: luna caps at max (no ultra), terra and
// sol carry high, and codex-auto-review is hidden (visibility != "list").
const SAMPLE_CATALOG_JSON = JSON.stringify({
  models: [
    {
      slug: "gpt-5.6-sol",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "xhigh" },
        { effort: "max" },
        { effort: "ultra" }
      ]
    },
    {
      slug: "gpt-5.6-terra",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }]
    },
    {
      slug: "gpt-5.6-luna",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
        { effort: "max" }
      ]
    },
    {
      slug: "codex-auto-review",
      visibility: "hide",
      supported_reasoning_levels: [{ effort: "medium" }]
    }
  ]
});

test("compareSemver handles prefixed command output", () => {
  assert.equal(compareSemver("codex-cli 0.124.0", "0.124.0"), 0);
  assert.equal(compareSemver("v20.10.0", "18.18.0"), 1);
  assert.equal(compareSemver("0.123.9", "0.124.0"), -1);
});

test("timestampForFile is filesystem-safe", () => {
  assert.equal(timestampForFile(new Date("2026-04-24T13:04:05Z")), "20260424-130405Z");
});

test("splitFirstToken splits unquoted path from prompt", () => {
  assert.deepEqual(splitFirstToken("photo.png make it red"), {
    input: "photo.png",
    prompt: "make it red"
  });
});

test("splitFirstToken supports double-quoted path with spaces", () => {
  assert.deepEqual(splitFirstToken('"my photo.png" tint blue'), {
    input: "my photo.png",
    prompt: "tint blue"
  });
});

test("splitFirstToken supports single-quoted path with spaces", () => {
  assert.deepEqual(splitFirstToken("'a b.png' brighten"), {
    input: "a b.png",
    prompt: "brighten"
  });
});

test("splitFirstToken returns nulls for empty input", () => {
  assert.deepEqual(splitFirstToken(""), { input: null, prompt: null });
  assert.deepEqual(splitFirstToken("   "), { input: null, prompt: null });
});

test("splitFirstToken returns input only when prompt is missing", () => {
  assert.deepEqual(splitFirstToken("only-path.png"), {
    input: "only-path.png",
    prompt: ""
  });
});

test("parseGenerateArguments returns prompt with no references", () => {
  assert.deepEqual(parseGenerateArguments("draw a red kite"), {
    referenceImages: [],
    prompt: "draw a red kite"
  });
});

test("parseGenerateArguments supports repeated reference flags", () => {
  assert.deepEqual(parseGenerateArguments('--ref style.png --reference "subject photo.png" draw a poster'), {
    referenceImages: ["style.png", "subject photo.png"],
    prompt: "draw a poster"
  });
});

test("parseGenerateArguments supports --image alias and equals form", () => {
  assert.deepEqual(parseGenerateArguments("--image=style.png --ref pose.png draw a scene"), {
    referenceImages: ["style.png", "pose.png"],
    prompt: "draw a scene"
  });
});

test("parseGenerateArguments supports delimiter before flag-like prompt text", () => {
  assert.deepEqual(parseGenerateArguments("-- --ref should appear as literal prompt text"), {
    referenceImages: [],
    prompt: "--ref should appear as literal prompt text"
  });
});

test("parseGenerateArguments rejects missing reference path", () => {
  assert.throws(() => parseGenerateArguments("--ref"), /Missing value for --ref/);
  assert.throws(() => parseGenerateArguments("--reference --ref style.png draw"), /Missing value for --reference/);
});

test("parseGenerateArguments rejects more than five reference images", () => {
  const flags = Array.from({ length: 6 }, (_, index) => `--ref r${index}.png`).join(" ");
  assert.throws(() => parseGenerateArguments(`${flags} draw a poster`), /at most 5/);
});

test("buildGenerateInstruction lists absolute reference paths for the codex turn", () => {
  const instruction = buildGenerateInstruction("draw a poster", ["/abs/style.png", "/abs/subject photo.png"]);
  assert.match(instruction, /1\. \/abs\/style\.png/);
  assert.match(instruction, /2\. \/abs\/subject photo\.png/);
  assert.match(instruction, /referenced_image_paths/);
  assert.match(instruction, /SAVED: <absolute path>/);
  assert.match(instruction, /draw a poster/);
});

test("buildGenerateInstruction omits the reference block without references", () => {
  const instruction = buildGenerateInstruction("draw a poster", []);
  assert.doesNotMatch(instruction, /Reference images for generation/);
  assert.match(instruction, /draw a poster/);
});

test("buildEditInstruction names the edit target's absolute path", () => {
  const instruction = buildEditInstruction("/abs/my photo.png", "tint it blue");
  assert.match(instruction, /\/abs\/my photo\.png/);
  assert.match(instruction, /referenced_image_paths/);
  assert.match(instruction, /SAVED: <absolute path>/);
  assert.match(instruction, /tint it blue/);
});

test("resolveCodex uses the bare codex command outside Windows", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(resolveCodex(), { command: "codex", prefix: [] });
});

test("parseModelCatalog keeps only visibility=list models and their efforts", () => {
  const catalog = parseModelCatalog(SAMPLE_CATALOG_JSON);
  assert.equal(catalog.size, 3);
  assert.ok(catalog.has("gpt-5.6-luna"));
  assert.ok(catalog.get("gpt-5.6-luna").has("high"));
  assert.ok(!catalog.get("gpt-5.6-luna").has("ultra"));
  assert.ok(catalog.get("gpt-5.6-sol").has("ultra"));
  assert.ok(!catalog.has("codex-auto-review"));
});

test("parseModelCatalog tolerates a leading banner before the JSON object", () => {
  const catalog = parseModelCatalog(`noise line\n${SAMPLE_CATALOG_JSON}`);
  assert.ok(catalog.has("gpt-5.6-terra"));
});

test("parseModelCatalog returns an empty map on unusable input", () => {
  assert.equal(parseModelCatalog("").size, 0);
  assert.equal(parseModelCatalog("not json").size, 0);
  assert.equal(parseModelCatalog('{"models":"nope"}').size, 0);
});

test("selectOrchestratorFromLadder picks the top available rung (luna high)", () => {
  const catalog = parseModelCatalog(SAMPLE_CATALOG_JSON);
  assert.deepEqual(selectOrchestratorFromLadder(catalog), {
    model: "gpt-5.6-luna",
    effort: "high"
  });
});

test("selectOrchestratorFromLadder falls to terra medium when luna is absent", () => {
  const catalog = new Map([
    ["gpt-5.6-terra", new Set(["low", "medium", "high"])],
    ["gpt-5.6-sol", new Set(["low", "high"])]
  ]);
  assert.deepEqual(selectOrchestratorFromLadder(catalog), {
    model: "gpt-5.6-terra",
    effort: "medium"
  });
});

test("selectOrchestratorFromLadder skips a rung whose effort is unsupported", () => {
  // luna present but without "high" -> skip luna high, land on terra medium.
  const catalog = new Map([
    ["gpt-5.6-luna", new Set(["low", "medium"])],
    ["gpt-5.6-terra", new Set(["low", "medium", "high"])]
  ]);
  assert.deepEqual(selectOrchestratorFromLadder(catalog), {
    model: "gpt-5.6-terra",
    effort: "medium"
  });
});

test("selectOrchestratorFromLadder returns null with no catalog or no match", () => {
  assert.equal(selectOrchestratorFromLadder(null), null);
  assert.equal(selectOrchestratorFromLadder(new Map()), null);
  assert.equal(selectOrchestratorFromLadder(new Map([["gpt-9.9", new Set(["high"])]])), null);
});

test("resolveImageOrchestrator uses the ladder when no env override is set", () => {
  const catalog = parseModelCatalog(SAMPLE_CATALOG_JSON);
  assert.deepEqual(resolveImageOrchestrator({ catalog }), {
    model: "gpt-5.6-luna",
    effort: "high",
    source: "ladder"
  });
});

test("resolveImageOrchestrator returns null when the ladder finds nothing", () => {
  assert.equal(resolveImageOrchestrator({ catalog: new Map() }), null);
  assert.equal(resolveImageOrchestrator({ catalog: null }), null);
});

test("resolveImageOrchestrator honors an explicit env override and lowercases effort", () => {
  assert.deepEqual(
    resolveImageOrchestrator({ envModel: "gpt-5.6-terra", envEffort: "High", catalog: new Map() }),
    { model: "gpt-5.6-terra", effort: "high", source: "env" }
  );
});

test("resolveImageOrchestrator requires both override vars together", () => {
  assert.throws(
    () => resolveImageOrchestrator({ envModel: "gpt-5.6-terra" }),
    /must be set together/
  );
  assert.throws(() => resolveImageOrchestrator({ envEffort: "high" }), /must be set together/);
});

test("resolveImageOrchestrator rejects an invalid override effort", () => {
  assert.throws(
    () => resolveImageOrchestrator({ envModel: "gpt-5.6-terra", envEffort: "turbo" }),
    /Invalid CODEX_IMAGE_EFFORT/
  );
});

test("isOrchestratorRejection matches the live 0.144.5 rejection shape", async () => {
  const { isOrchestratorRejection } = await import("../scripts/codex-image.mjs");
  // Captured verbatim from codex-cli 0.144.5 with a bogus -m slug.
  assert.equal(
    isOrchestratorRejection(
      `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'totally-bogus-model-xyz' model is not supported when using Codex with a ChatGPT account."}}`
    ),
    true
  );
});

test("isOrchestratorRejection matches other known model/effort rejection shapes", async () => {
  const { isOrchestratorRejection } = await import("../scripts/codex-image.mjs");
  assert.equal(isOrchestratorRejection("ERROR: model gpt-5.6-luna is not available for this account"), true);
  assert.equal(isOrchestratorRejection("ERROR: Unknown model: gpt-5.6-luna"), true);
  assert.equal(isOrchestratorRejection('ERROR: {"code":"model_not_found"}'), true);
  assert.equal(isOrchestratorRejection("ERROR: The model 'gpt-5.6-luna' does not exist"), true);
  assert.equal(isOrchestratorRejection("ERROR: unsupported reasoning effort: high"), true);
  assert.equal(isOrchestratorRejection("ERROR: invalid value for model_reasoning_effort"), true);
});

test("isOrchestratorRejection reads codex's ERROR record, including multi-line JSON and ANSI-styled lines", async () => {
  const { isOrchestratorRejection } = await import("../scripts/codex-image.mjs");
  // Pretty-printed rejection from a custom provider: the message is on a continuation line.
  assert.equal(
    isOrchestratorRejection(
      'ERROR: {\n  "type": "error",\n  "status": 400,\n  "error": {\n    "message": "The \'gpt-5.6-luna\' model is not supported here."\n  }\n}'
    ),
    true
  );
  // FORCE_COLOR styling on the ERROR prefix.
  assert.equal(
    isOrchestratorRejection("\u001b[31mERROR:\u001b[0m Unknown model: gpt-5.6-luna"),
    true
  );
  // Text before the first ERROR line is not classified.
  assert.equal(isOrchestratorRejection("Unknown model: gpt-5.6-luna"), false);
  assert.equal(
    isOrchestratorRejection("model not supported here\n succeeded in 0ms:\nERROR: stream disconnected before completion"),
    false
  );
});

test("codexOwnStderr cuts the echoed instruction off, even when the tail starts inside it", async () => {
  const { codexOwnStderr } = await import("../scripts/codex-image.mjs");
  const instruction = "Use the imagegen skill.\n\nUser request:\n\ncodex\nexec\nA wordmark reading Unknown Model";
  const full = `OpenAI Codex v0.154.0\n--------\nuser\n${instruction}\nERROR: boom\n`;
  assert.equal(codexOwnStderr(full, instruction), "\nERROR: boom\n");
  const truncated = `request:\n\ncodex\nexec\nA wordmark reading Unknown Model\nERROR: boom\n`;
  assert.equal(codexOwnStderr(truncated, instruction), "ERROR: boom\n");
  assert.equal(codexOwnStderr("ERROR: boom\n", instruction), "ERROR: boom\n");
});

test("shouldRetryWithoutOrchestrator fires only for a startup rejection in codex's own output", async () => {
  const { shouldRetryWithoutOrchestrator, turnHadStarted } = await import("../scripts/codex-image.mjs");
  const rejection =
    `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.6-luna' model is not supported when using Codex with a ChatGPT account."}}`;
  const instruction = "Use the imagegen skill.\n\nUser request:\n\nA tiny grey circle";
  const header = `OpenAI Codex v0.154.0\n--------\nmodel: gpt-5.6-luna\n--------\nuser\n${instruction}\n`;
  // Startup rejection right after the echo: retry.
  assert.equal(shouldRetryWithoutOrchestrator(`${header}${rejection}\n`, instruction), true);
  // A prompt containing standalone "codex" / "exec" lines and rejection-like words
  // is echoed before the real error; it must not suppress (or cause) the retry.
  const trickyInstruction = "Use the imagegen skill.\n\nUser request:\n\ncodex\nexec\nA poster titled Unknown Model";
  const trickyHeader = `OpenAI Codex v0.154.0\n--------\nuser\n${trickyInstruction}\n`;
  assert.equal(shouldRetryWithoutOrchestrator(`${trickyHeader}${rejection}\n`, trickyInstruction), true);
  assert.equal(
    shouldRetryWithoutOrchestrator(`${trickyHeader}ERROR: stream disconnected before completion\n`, trickyInstruction),
    false
  );
  // Same rejection text after the turn produced a tool call: the image tool may
  // already have been billed, so no retry.
  const started = `${header}codex\nUsing the imagegen skill.\nexec\n/bin/zsh -lc 'sed -n 1,40p SKILL.md'\n succeeded in 0ms:\n...\n${rejection}\n`;
  assert.equal(turnHadStarted(started), true);
  assert.equal(shouldRetryWithoutOrchestrator(started, instruction), false);
  // Unrelated failure at startup: no retry.
  assert.equal(shouldRetryWithoutOrchestrator(`${header}ERROR: you've hit your usage limit\n`, instruction), false);
});

test("isOrchestratorRejection ignores unrelated failures", async () => {
  const { isOrchestratorRejection } = await import("../scripts/codex-image.mjs");
  assert.equal(isOrchestratorRejection("you've hit your usage limit"), false);
  assert.equal(isOrchestratorRejection("stream disconnected before completion"), false);
  assert.equal(isOrchestratorRejection("401 Unauthorized: please run codex login"), false);
  assert.equal(isOrchestratorRejection(""), false);
  assert.equal(isOrchestratorRejection(null), false);
});

test("base exec args use the documented sandbox flag and pin approval-never", () => {
  // `--full-auto` was removed from `codex exec` in Codex CLI 0.151.0 (#5); the
  // explicit approval override keeps the approval-never contract under auto_review.
  assert.deepEqual(CODEX_EXEC_BASE_ARGS, [
    "exec",
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check"
  ]);
  assert.ok(!CODEX_EXEC_BASE_ARGS.includes("--full-auto"));
});

test("orchestratorArgs builds -m/-c with a TOML-quoted effort, or [] when null", () => {
  assert.deepEqual(orchestratorArgs({ model: "gpt-5.6-luna", effort: "high" }), [
    "-m",
    "gpt-5.6-luna",
    "-c",
    'model_reasoning_effort="high"'
  ]);
  assert.deepEqual(orchestratorArgs(null), []);
});
