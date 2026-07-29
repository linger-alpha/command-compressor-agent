"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compressObservation } = require("../src/compression/compressor");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cca-${name}-`));
}

function observe(stdout, command = "python3 train.py") {
  return {
    command,
    stdout,
    stderr: "",
    exitCode: 0,
    agent: "test",
    toolName: "Bash",
  };
}

function progressOutput(lines) {
  return Array.from({ length: lines }, (_, index) => {
    const pct = String(Math.min(99, index % 100)).padStart(2, "0");
    return `${pct}%|████████████████████| ${index + 1}/${lines} [00:01<00:00, 42.00it/s] loss=${(1 / (index + 1)).toFixed(4)}`;
  }).join("\n");
}

function compress(stdout, strength) {
  return compressObservation(observe(stdout), {
    strength,
    rawDir: tempDir(strength),
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
}

{
  const shortProgress = progressOutput(40);
  const result = compress(shortProgress, "default");
  assert.strictEqual(result.changed, true, "compressible blocks should not be exempted by a global token threshold");
  assert(result.ruleIds.includes("importance_aggressive_compress"));
}

{
  const mediumProgress = progressOutput(90);
  const high = compress(mediumProgress, "high");
  const def = compress(mediumProgress, "default");
  assert.strictEqual(high.changed, true);
  assert.strictEqual(def.changed, true);
  assert.strictEqual(
    high.plan.plannedTokens,
    def.plan.plannedTokens,
    "legacy strength settings must not override block-level policy"
  );
}

{
  const shortProgress = progressOutput(40);
  const result = compress(shortProgress, "xhigh");
  assert.strictEqual(result.changed, true, "xhigh should have no length exemption");
}

{
  const genericLong = Array.from({ length: 900 }, (_, index) => `semantic row ${index}: value=${index}`).join("\n");
  const result = compress(genericLong, "low");
  assert.strictEqual(result.changed, false, "high-uniqueness structured rows should be preserved as semantic data");
  assert(result.plan.blocks.some((entry) =>
    entry.reasons.some((reason) => reason.id === "dense_semantic")
  ));
}

{
  const visual = [
    "=== Piece shape analysis (binary silhouette) ===",
    "d8:",
    ...Array.from({ length: 16 }, () => "  .....######....."),
    "f5:",
    ...Array.from({ length: 16 }, () => "  ..###..###......"),
  ].join("\n");
  const result = compressObservation(observe(visual, "python3 analyze_chess_board.py"), {
    strength: "xhigh",
    rawDir: tempDir("visual"),
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
  assert.strictEqual(result.changed, false, "visual diagnostic blocks should be preserved");
  assert(result.plan.blocks.some((entry) => entry.tier === "preserve"));
}

{
  const failedVisual = [
    "Traceback (most recent call last):",
    "RuntimeError: could not classify board image",
    "=== contour grid debug ===",
    ...Array.from({ length: 12 }, () => "  ..###..###......"),
  ].join("\n");
  const result = compressObservation({
    ...observe(failedVisual, "python3 detect_contours.py chess_board.png"),
    exitCode: 1,
  }, {
    strength: "xhigh",
    rawDir: tempDir("failed-visual"),
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
  assert.strictEqual(result.changed, false, "failed visual diagnostics should remain lossless at block level");
  assert(result.plan.blocks.some((entry) => entry.tier === "preserve"));
}

{
  const readOnly = compressObservation(observe(progressOutput(120), "cat build.log"), {
    strength: "xhigh",
    rawDir: tempDir("read-only"),
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
  assert.strictEqual(readOnly.changed, false);
  assert.deepStrictEqual(readOnly.ruleIds, ["read_only_passthrough"]);

  const rtk = compressObservation(observe(progressOutput(120), "rtk python3 train.py"), {
    strength: "xhigh",
    rawDir: tempDir("rtk"),
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
  assert.strictEqual(rtk.changed, false);
  assert.deepStrictEqual(rtk.ruleIds, ["rtk_passthrough"]);
}

{
  const dir = tempDir("raw-fallback");
  const rawPath = path.join(dir, "20260620T000000Z-abc123.log");
  const result = compressObservation(observe(progressOutput(120), `python3 - <<'PY'\nprint(open("${rawPath}").read())\nPY`), {
    strength: "xhigh",
    rawDir: dir,
    rulesPath: path.resolve(__dirname, "..", "rules", "default-rules.json"),
  });
  assert.strictEqual(result.changed, false, "commands that read the configured rawDir should passthrough");
  assert.deepStrictEqual(result.ruleIds, ["raw_fallback_read_passthrough"]);
}

console.log("compressor tests passed");
