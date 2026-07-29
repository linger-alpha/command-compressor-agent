"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { compressObservation } = require("../src/compression/compressor");
const { isReadOnlyCommand } = require("../src/compression/command-policy");
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
  const safeReads = [
    "git status; git diff | sed -n '1,80p'",
    "cd /tmp && rg -n 'needle' . | head -n 20",
    "if test -f package.json; then sed -n '1,40p' package.json; else printf 'missing\\n'; fi",
    "for file in a b; do printf '%s\\n' \"$file\"; sed -n '1,5p' \"$file\"; done",
  ];
  const mutations = [
    "cat package.json; rm package.json",
    "find . -name '*.tmp' -delete",
    "sed -i 's/a/b/' package.json",
    "rg needle . | tee matches.txt",
    "printf '%s' \"$(python mutate.py)\"",
    "printf 'generated output\\n'",
    "echo generated output",
    "python inspect.py",
  ];
  for (const command of safeReads) {
    assert.strictEqual(isReadOnlyCommand(command), true, `expected read-only: ${command}`);
  }
  for (const command of mutations) {
    assert.strictEqual(isReadOnlyCommand(command), false, `expected general/mutating: ${command}`);
  }
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
  assert.deepStrictEqual(blocks.map((entry) => entry.startLine), [1, 3, 4, 5, 6, 10, 12, 15]);
  assert.strictEqual(blocks[4].kind, "traceback");
  assert.deepStrictEqual(blocks[4].lines, lines.slice(5, 9), "traceback must stay in one block");
  assert.deepStrictEqual(blocks[6].lines, lines.slice(11, 14), "normalized repeated run must stay together");
}

{
  const source = [
    "def run():",
    "    try:",
    "        work()",
    "    except RuntimeError:",
    "        recover()",
    "return run()",
  ];
  const blocks = splitBlocks(source);
  assert.strictEqual(blocks.length, 1, "source indentation changes must not create micro-blocks");
}

{
  const scored = scoreBlock(block([
    "Traceback (most recent call last):",
    '  File "task.py", line 42',
    "RuntimeError: ERROR FAILED warning Exception",
  ]));
  assert.strictEqual(scored.tier, "preserve");
  assert.deepStrictEqual(
    scored.reasons.map((reason) => reason.id),
    ["traceback_exception", "error_failure", "file_line", "warning"]
  );

  const noise = scoreBlock(block([
    "Downloading wheel 1 10%|██",
    "Downloading wheel 2 20%|████",
    "Downloading wheel 3 30%|██████",
  ]));
  assert.strictEqual(noise.tier, "aggressive");
  assert.deepStrictEqual(noise.reasons.map((reason) => reason.id), ["progress_download"]);
}

{
  const highLines = Array.from({ length: 4000 }, (_, index) => `Traceback context ${index}`);
  const scored = scoreBlocks([block(highLines)]);
  const planned = planCompression(scored, {
    config: {},
    rules: [],
  });
  assert.strictEqual(planned.blocks[0].tier, "preserve");
  assert.strictEqual(planned.blocks[0].mode, "lossless");
  assert(planned.body.includes(highLines[0]));
  assert(planned.body.includes(highLines[highLines.length - 1]));
  assert(!planned.body.includes("[block "), "model-visible output must not contain block diagnostics");
  assert(!planned.body.includes("[compression plan]"), "model-visible output must not contain policy diagnostics");
}

{
  const separator = {
    startLine: 2,
    endLine: 2,
    lines: [""],
    separator: true,
    kind: "separator",
  };
  const planned = planCompression([
    { block: block(["first"]), tier: "light", reasons: [] },
    { block: separator, tier: "aggressive", reasons: [] },
    { block: block(["second"], 3), tier: "light", reasons: [] },
  ]);
  assert.strictEqual(planned.blocks.length, 2, "blank separators are layout, not compression units");
  assert(planned.body.includes("first\n\nsecond"));
}

{
  const mediumBlock = block(["warning: check configuration", ...Array.from({ length: 120 }, (_, index) => `detail ${index}`)]);
  const lowBlock = block(Array.from({ length: 120 }, (_, index) => `Downloading part ${index} ${index}%|██`), 122);
  const planned = planCompression([
    { block: mediumBlock, tier: "light", reasons: [{ id: "warning", tier: "light" }] },
    { block: lowBlock, tier: "aggressive", reasons: [{ id: "progress_download", tier: "aggressive" }, { id: "duplicate", tier: "aggressive" }] },
  ], {
    config: {},
    rules: [],
  });
  assert.strictEqual(planned.blocks[0].tier, "light");
  assert.strictEqual(planned.blocks[0].mode, "light");
  assert.strictEqual(planned.blocks[1].tier, "aggressive");
  assert.strictEqual(planned.blocks[1].mode, "aggressive");
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
  assert(Array.isArray(loaded.blockPolicy.signals), "v1 rules should receive bundled block-policy defaults");
  assert(loaded.planner.light.max_lines > 0);
  assert(loaded.commandPolicy.compatibility_patterns.includes("^custom$"));
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
  assert(!result.text.includes("importance="));
  assert(!result.text.includes("score="));
  assert(result.text.includes("raw_ref:"));
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
  assert(result.plan.blocks.some((entry) => entry.tier === "preserve"));
}

{
  const encoded = Array.from(
    { length: 8 },
    (_, index) => Buffer.from(`opaque-${index}-${"x".repeat(96)}`).toString("base64")
  ).join("\n");
  const result = compressObservation({
    command: "python emit_blob.py",
    stdout: encoded,
    stderr: "command failed",
    exitCode: 1,
    agent: "test",
    toolName: "Bash",
  }, {
    strength: "xhigh",
    rawDir: tempDir("encoded"),
    rulesPath,
  });
  assert.strictEqual(result.changed, false, "opaque encoded blocks must remain lossless");
  assert(result.plan.blocks.some((entry) =>
    entry.reasons.some((reason) => reason.id === "opaque_encoded")
  ));
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
