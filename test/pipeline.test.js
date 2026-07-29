"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compressObservation } = require("../src/compression/compressor");
const { planCompression } = require("../src/compression/planner");
const { loadRuleSet } = require("../src/compression/rules");
const { scoreBlock, scoreBlocks } = require("../src/compression/scorer");
const { splitBlocks } = require("../src/compression/splitter");

const rulesPath = path.resolve(__dirname, "..", "rules", "default-rules.json");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cca-pipeline-${name}-`));
}

function block(lines, startLine = 1) {
  return {
    startLine,
    endLine: startLine + lines.length - 1,
    lines,
    separator: false,
    kind: "text",
  };
}

{
  const lines = [
    "2026-07-29 10:00:00 INFO first",
    "2026-07-29 10:01:00 INFO second",
    "2026-07-29 11:00:00 INFO new hour",
    "2026-07-29 11:00:01 ERROR changed level",
    "",
    "Traceback (most recent call last):",
    '  File "task.py", line 3, in <module>',
    "    run()",
    "ValueError: broken",
    "next section",
    "  indented detail",
    "progress item 1",
    "progress item 2",
    "progress item 3",
    "done",
  ];
  const blocks = splitBlocks(lines);
  assert.deepStrictEqual(blocks.map((entry) => entry.startLine), [1, 3, 4, 5, 6, 10, 11, 12, 15]);
  assert.strictEqual(blocks[4].kind, "traceback");
  assert.deepStrictEqual(blocks[4].lines, lines.slice(5, 9), "traceback must stay in one block");
  assert.deepStrictEqual(blocks[7].lines, lines.slice(11, 14), "normalized repeated run must stay together");
}

{
  const scored = scoreBlock(block([
    "Traceback (most recent call last):",
    '  File "task.py", line 42',
    "RuntimeError: ERROR FAILED warning Exception",
  ]));
  assert.strictEqual(scored.score, 100, "importance score must clamp at 100");
  assert.deepStrictEqual(
    scored.reasons.map((reason) => reason.id),
    ["exception_traceback", "error_fatal_failed", "file_line", "warning"]
  );

  const noise = scoreBlock(block([
    "Downloading wheel 1 10%|██",
    "Downloading wheel 2 20%|████",
    "Downloading wheel 3 30%|██████",
  ]));
  assert.strictEqual(noise.score, -50);
  assert.deepStrictEqual(noise.reasons.map((reason) => reason.id), ["progress_download", "duplicate"]);
}

{
  const highLines = Array.from({ length: 4000 }, (_, index) => `Traceback context ${index}`);
  const scored = scoreBlocks([block(highLines)]);
  const planned = planCompression(scored, {
    rawTokens: 1000,
    strength: "xhigh",
    config: {},
    rules: [],
  });
  assert.strictEqual(planned.targetTokens, 800, "minimum soft budget should be 800 tokens");
  assert.strictEqual(planned.blocks[0].tier, "high");
  assert.strictEqual(planned.blocks[0].mode, "lossless");
  assert(planned.body.includes(highLines[0]));
  assert(planned.body.includes(highLines[highLines.length - 1]));
  assert.strictEqual(planned.budgetExceeded, true, "high-importance content may exceed the soft budget");

  for (const [strength, expected] of Object.entries({
    low: 7500,
    default: 5000,
    high: 3500,
    xhigh: 2500,
  })) {
    const emptyPlan = planCompression([], {
      rawTokens: 10000,
      strength,
      config: {},
      rules: [],
    });
    assert.strictEqual(emptyPlan.targetTokens, expected);
  }
}

{
  const mediumBlock = block(["warning: check configuration", ...Array.from({ length: 120 }, (_, index) => `detail ${index}`)]);
  const lowBlock = block(Array.from({ length: 120 }, (_, index) => `Downloading part ${index} ${index}%|██`), 122);
  const planned = planCompression([
    { block: mediumBlock, score: 10, reasons: [{ id: "warning", score: 10 }] },
    { block: lowBlock, score: -50, reasons: [{ id: "progress_download", score: -20 }, { id: "duplicate", score: -30 }] },
  ], {
    rawTokens: 10000,
    strength: "default",
    config: {},
    rules: [],
  });
  assert.strictEqual(planned.blocks[0].tier, "medium");
  assert(planned.blocks[0].mode.startsWith("light"));
  assert.strictEqual(planned.blocks[1].tier, "low");
  assert(["strong", "minimal"].includes(planned.blocks[1].mode));
}

{
  const customDir = tempDir("v1");
  const customPath = path.join(customDir, "rules.json");
  const v1 = {
    version: 1,
    whitelist: ["^custom$"],
    strong_rules: [{
      rule_id: "custom_rule",
      enabled: true,
      priority: 1,
      output_regex: "noise",
      strip_patterns: ["^noise$"],
    }],
    weak_rules: [],
  };
  fs.writeFileSync(customPath, `${JSON.stringify(v1, null, 2)}\n`, "utf8");
  const before = fs.readFileSync(customPath, "utf8");
  const loaded = loadRuleSet(customPath);
  assert.strictEqual(loaded.version, 1);
  assert.strictEqual(loaded.strongRules[0].rule_id, "custom_rule");
  assert(Array.isArray(loaded.importance.signals), "v1 rules should receive bundled v2 scoring defaults");
  assert(loaded.planner.budget_ratios.xhigh > 0);
  assert.strictEqual(fs.readFileSync(customPath, "utf8"), before, "compatibility fallback must not overwrite user rules");
}

{
  const progress = Array.from(
    { length: 320 },
    (_, index) => `\u001b[32mDownloading package ${index} ${index % 100}%|████| ${index}/320 [1.0MB/s]\u001b[0m`
  );
  const traceback = [
    "",
    "Traceback (most recent call last):",
    '  File "/Users/example/task.py", line 9, in <module>',
    "    raise ValueError('重要错误')",
    "ValueError: 重要错误 token=sk-abcdefghijklmnopqrstuvwxyz123456",
  ];
  const result = compressObservation({
    command: "python task.py",
    stdout: progress.concat(traceback).join("\n"),
    stderr: "",
    exitCode: 1,
    agent: "test",
    toolName: "Bash",
  }, {
    strength: "xhigh",
    rawDir: tempDir("mixed"),
    rulesPath,
  });
  assert.strictEqual(result.changed, true);
  assert(result.text.includes("Traceback (most recent call last):"));
  assert(result.text.includes("ValueError: 重要错误 token=[REDACTED]"));
  assert(!result.text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert(result.text.includes("importance=high"));
  assert(!result.text.includes("\u001b["), "ANSI sequences must be removed");
}

{
  const dense = [
    "ERROR: catalog is incomplete",
    ...Array.from({ length: 100 }, (_, index) => `${index + 1}: semantic item ${index}`),
  ].join("\n");
  const result = compressObservation({
    command: "python catalog.py",
    stdout: dense,
    stderr: "",
    exitCode: 1,
    agent: "test",
    toolName: "Bash",
  }, {
    strength: "xhigh",
    rawDir: tempDir("dense"),
    rulesPath,
  });
  assert.strictEqual(result.changed, false);
  assert.deepStrictEqual(result.ruleIds, ["semantic_list_passthrough"]);
}

{
  let seed = 20260729;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 100; sample += 1) {
    const lines = Array.from({ length: 1 + (random() % 80) }, () => {
      const choices = ["INFO", "warning", "ERROR", "下载", "\u001b[31mred\u001b[0m", "", "  nested"];
      return `${choices[random() % choices.length]} ${random()}`;
    });
    const blocks = splitBlocks(lines);
    const scored = scoreBlocks(blocks);
    const plan = planCompression(scored, {
      rawTokens: Math.max(1, lines.join("\n").length / 4),
      strength: "xhigh",
      config: {},
      rules: [],
    });
    assert(Array.isArray(plan.blocks));
    assert.strictEqual(typeof plan.body, "string");
  }
}

{
  const large = Array.from({ length: 50000 }, (_, index) => `INFO worker=${index % 8} item ${index}`).join("\n");
  const started = Date.now();
  const blocks = splitBlocks(large);
  const elapsed = Date.now() - started;
  assert(blocks.length > 0);
  assert(elapsed < 5000, `50k-line split should remain linear-time in practice (elapsed=${elapsed}ms)`);
}

console.log("pipeline tests passed");
