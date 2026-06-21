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
  assert.strictEqual(result.changed, false, "default should exempt sub-2k token outputs");
  assert.deepStrictEqual(result.ruleIds, ["strength_threshold_passthrough"]);
}

{
  const mediumProgress = progressOutput(90);
  const high = compress(mediumProgress, "high");
  const def = compress(mediumProgress, "default");
  assert.strictEqual(high.changed, true, "high should compress above 1k tokens");
  assert.strictEqual(def.changed, false, "default should still exempt below 2k tokens");
}

{
  const shortProgress = progressOutput(40);
  const result = compress(shortProgress, "xhigh");
  assert.strictEqual(result.changed, true, "xhigh should have no length exemption");
}

{
  const genericLong = Array.from({ length: 900 }, (_, index) => `semantic row ${index}: value=${index}`).join("\n");
  const result = compress(genericLong, "low");
  assert.strictEqual(result.changed, false, "low should not head/tail generic long output");
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
  assert.strictEqual(result.changed, false, "visual diagnostic output should passthrough even at xhigh");
  assert.deepStrictEqual(result.ruleIds, ["visual_diagnostic_passthrough"]);
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
  assert.strictEqual(result.changed, false, "failed visual diagnostics should passthrough before critical compression");
  assert.deepStrictEqual(result.ruleIds, ["visual_diagnostic_passthrough"]);
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
