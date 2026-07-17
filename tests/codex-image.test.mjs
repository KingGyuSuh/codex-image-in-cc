import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("orchestratorArgs builds -m/-c with a TOML-quoted effort, or [] when null", () => {
  assert.deepEqual(orchestratorArgs({ model: "gpt-5.6-luna", effort: "high" }), [
    "-m",
    "gpt-5.6-luna",
    "-c",
    'model_reasoning_effort="high"'
  ]);
  assert.deepEqual(orchestratorArgs(null), []);
});
