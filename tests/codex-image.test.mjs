import assert from "node:assert/strict";
import test from "node:test";

import { compareSemver, splitFirstToken, timestampForFile } from "../scripts/codex-image.mjs";

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
