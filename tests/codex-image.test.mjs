import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEditInstruction,
  buildGenerateInstruction,
  compareSemver,
  detectHeadlessMode,
  parseGenerateArguments,
  resolveCodex,
  splitFirstToken,
  timestampForFile
} from "../scripts/codex-image.mjs";

const EXEC_HELP = [
  "Run Codex non-interactively",
  "",
  "  -i, --image <FILE>...",
  "          Optional image(s) to attach to the initial prompt",
  "",
  "  -s, --sandbox <SANDBOX_MODE>",
  "          [possible values: read-only, workspace-write, danger-full-access]"
].join("\n");

// clap's rejection of an unknown flag: exit code 2, six-line usage blurb, no option list.
const FULL_AUTO_REJECTED = {
  available: true,
  status: 2,
  stdout: "",
  stderr: "error: unexpected argument '--full-auto' found\n\nUsage: codex exec [OPTIONS] [PROMPT]",
  error: null
};

function fakeRunner(responses) {
  const calls = [];
  const run = (command, args) => {
    calls.push(args);
    return responses(args);
  };
  return { run, calls };
}

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

test("detectHeadlessMode keeps --full-auto where the installed Codex still accepts it", () => {
  const { run, calls } = fakeRunner(() => ({
    available: true,
    status: 0,
    stdout: EXEC_HELP,
    stderr: "",
    error: null
  }));
  const mode = detectHeadlessMode("/tmp", run);
  assert.equal(mode.ok, true);
  assert.deepEqual(mode.args, ["--full-auto"]);
  assert.equal(mode.label, "--full-auto");
  assert.equal(calls.length, 1, "must not probe the fallback once --full-auto is accepted");
});

test("detectHeadlessMode falls back to -s workspace-write when --full-auto is rejected", () => {
  const { run, calls } = fakeRunner((args) =>
    args.includes("--full-auto")
      ? FULL_AUTO_REJECTED
      : { available: true, status: 0, stdout: EXEC_HELP, stderr: "", error: null }
  );
  const mode = detectHeadlessMode("/tmp", run);
  assert.equal(mode.ok, true);
  assert.deepEqual(mode.args, ["-s", "workspace-write"]);
  assert.deepEqual(calls[1], ["exec", "-s", "workspace-write", "--help"]);
});

test("detectHeadlessMode surfaces --image support from the help call that succeeded", () => {
  const { run } = fakeRunner((args) =>
    args.includes("--full-auto")
      ? FULL_AUTO_REJECTED
      : { available: true, status: 0, stdout: EXEC_HELP, stderr: "", error: null }
  );
  // Regression: the old probe grepped the rejected --full-auto output, which has no
  // option list, and reported "--image not found" on a CLI that does support it.
  assert.match(detectHeadlessMode("/tmp", run).helpText, /-i, --image <FILE>/);
});

test("detectHeadlessMode reports failure when no candidate is accepted", () => {
  const { run, calls } = fakeRunner(() => FULL_AUTO_REJECTED);
  const mode = detectHeadlessMode("/tmp", run);
  assert.equal(mode.ok, false);
  assert.equal(mode.args, null);
  assert.equal(calls.length, 2);
  assert.match(mode.detail, /unexpected argument/);
});

test("detectHeadlessMode stops probing when the Codex binary is missing", () => {
  const { run, calls } = fakeRunner(() => ({
    available: false,
    status: null,
    stdout: "",
    stderr: "",
    error: new Error("spawn codex ENOENT")
  }));
  const mode = detectHeadlessMode("/tmp", run);
  assert.equal(mode.ok, false);
  assert.equal(calls.length, 1);
  assert.match(mode.detail, /not found/);
});
