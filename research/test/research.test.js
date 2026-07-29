"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { auditCorpus } = require("../lib/audit");
const { assignSplits, importCorpus } = require("../lib/corpus");
const {
  DEFAULT_GENERATOR_EFFORT,
  DEFAULT_GENERATOR_MODEL,
  DEFAULT_JUDGE_EFFORT,
  DEFAULT_JUDGE_MODEL,
  evolveCorpus,
  isJudgeEligible,
  loadMatchingCorpusRecords,
  promoteAccepted,
} = require("../lib/evolve");
const { buildCodexArgs } = require("../lib/model");
const {
  aggregateReplay,
  evaluateAgainstLegacy,
  regexSafety,
  validateCandidate,
} = require("../lib/replay");
const { redactText } = require("../lib/redaction");

const repoRoot = path.resolve(__dirname, "..", "..");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cca-research-${name}-`));
}

function writeJsonl(pathname, items) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
}

(async () => {
  {
    const redacted = redactText([
      "email user@example.com",
      "home /Users/alice/project",
      "linux /home/bob/repo",
      "host 192.168.1.4",
      "ssh alice@internal.example",
      "url https://name:password@private.example/path",
      "token=sk-abcdefghijklmnopqrstuvwxyz123456",
    ].join("\n"));
    assert(!redacted.includes("user@example.com"));
    assert(!redacted.includes("/Users/alice"));
    assert(!redacted.includes("/home/bob"));
    assert(!redacted.includes("192.168.1.4"));
    assert(!redacted.includes("alice@internal.example"));
    assert(!redacted.includes("name:password"));
    assert(!redacted.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  }

  {
    const descriptors = Array.from({ length: 20 }, (_, index) => ({
      source: "rtx",
      sessionKey: `rtx:${index}`,
    }));
    const splits = assignSplits(descriptors, "20260729");
    const counts = { train: 0, validation: 0, test: 0 };
    for (const split of splits.values()) counts[split] += 1;
    assert.deepStrictEqual(counts, { train: 14, validation: 3, test: 3 });
  }

  const importRoot = tempDir("import");
  const h800Dir = path.join(importRoot, "h800 ");
  const rollout = path.join(h800Dir, "03", "01", "rollout.jsonl");
  writeJsonl(rollout, [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: "python /Users/alice/task.py" }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call-1",
        stdout: "token=sk-abcdefghijklmnopqrstuvwxyz123456 user@example.com /home/alice/repo 10.0.0.8 " + "x".repeat(300),
        stderr: "warning",
        exit_code: 1,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "write_stdin",
        call_id: "call-ignored",
        arguments: JSON.stringify({ chars: "x" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "Bash",
        call_id: "call-2",
        arguments: JSON.stringify({ command: "printf done" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-2",
        output: JSON.stringify({ stdout: "done", stderr: "", exit_code: 0 }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "unpaired",
        stdout: "must not import",
        exit_code: 0,
      },
    },
  ]);
  const publicPath = path.join(importRoot, "terminaltraj.jsonl");
  writeJsonl(publicPath, Array.from({ length: 40 }, (_, index) => ({
    command: `make task-${index}`,
    stdout: `Downloading item ${index} ${index}%`,
    stderr: "",
    exit_code: 0,
    agent: "terminaltraj",
  })));
  const corpusPath = path.join(importRoot, "corpus.jsonl");
  const summary = await importCorpus({
    codexSources: [{ label: "h800", path: h800Dir }],
    publicSources: [{ label: "terminaltraj", path: publicPath }],
    outPath: corpusPath,
    maxOutputChars: 180,
    maxRecordsPerSession: 100,
  });
  assert.strictEqual(summary.records, 42);
  assert.strictEqual(summary.skippedUnpaired, 1);
  const corpusText = fs.readFileSync(corpusPath, "utf8");
  assert(!corpusText.includes("sk-abcdefghijklmnopqrstuvwxyz123456"));
  assert(!corpusText.includes("user@example.com"));
  assert(!corpusText.includes("/Users/alice"));
  assert(!corpusText.includes("10.0.0.8"));
  assert(!corpusText.includes("must not import"));
  assert(!corpusText.includes(h800Dir), "local source paths must not enter the corpus");
  assert(corpusText.includes("research sample truncated"));
  const audit = await auditCorpus(corpusPath, {
    maxFieldChars: 180,
    maxCommandChars: 2000,
  });
  assert.strictEqual(audit.ok, true);

  {
    const args = buildCodexArgs({
      model: DEFAULT_GENERATOR_MODEL,
      effort: DEFAULT_GENERATOR_EFFORT,
      schemaPath: path.join(repoRoot, "research", "schemas", "candidates.schema.json"),
      outputPath: path.join(importRoot, "out.json"),
    });
    assert(args.includes("--ephemeral"));
    assert(args.includes("--ignore-user-config"));
    assert(args.includes("--ignore-rules"));
    assert(args.includes("read-only"));
    assert(args.includes("gpt-5.6-luna"));
    assert(args.includes('model_reasoning_effort="max"'));
    assert.strictEqual(DEFAULT_JUDGE_MODEL, "gpt-5.6-sol");
    assert.strictEqual(DEFAULT_JUDGE_EFFORT, "high");
  }

  const candidate = {
    rule_id: "research_download_noise",
    category: "weak",
    rationale: "fixture",
    trigger_regex: "\\bpython\\b",
    output_regex: "\\bDownloading\\b",
    keep_patterns: ["\\bERROR\\b"],
    strip_patterns: ["^Downloading.*$"],
    keep_first_n: 4,
    keep_last_n: 8,
    max_lines: 40,
    priority: 20,
    confidence: 0.8,
  };
  assert.strictEqual(validateCandidate(candidate).valid, true);
  assert.strictEqual(regexSafety("(.*)+").safe, false);
  assert.strictEqual(isJudgeEligible({
    valid: true,
    applicable_records: 1,
    critical_fact_retention: 1,
    incremental_token_reduction: 0.05,
  }), true);
  assert.strictEqual(isJudgeEligible({
    valid: true,
    applicable_records: 1,
    critical_fact_retention: 1,
    incremental_token_reduction: 0.049,
  }), false);
  const matchingCorpus = path.join(importRoot, "matching-corpus.jsonl");
  writeJsonl(matchingCorpus, [
    {
      id: "validation-non-match",
      source: "fixture",
      split: "validation",
      command: "echo quiet",
      stdout: "quiet",
      stderr: "",
      exit_code: 0,
    },
    {
      id: "validation-match",
      source: "fixture",
      split: "validation",
      command: "make package",
      stdout: "Downloading package 50%",
      stderr: "",
      exit_code: 0,
    },
  ]);
  const matching = await loadMatchingCorpusRecords(matchingCorpus, "validation", {
    ...candidate,
    trigger_regex: "\\bmake\\b",
  }, 5);
  assert.deepStrictEqual(
    matching.map((record) => record.id),
    ["validation-match"],
    "candidate-aware validation should scan beyond non-matching held-out records"
  );

  {
    const progress = Array.from(
      { length: 300 },
      (_, index) => `Downloading artifact ${index} ${index % 100}%|████| ${index}/300 [1MB/s]`
    ).join("\n");
    const metrics = evaluateAgainstLegacy([{
      id: "fixture",
      command: "python fetch.py",
      stdout: progress,
      stderr: "",
      exit_code: 0,
    }], candidate, { repoRoot, baselineCommit: "7830b17", maxExamples: 1 });
    assert.strictEqual(metrics.valid, true);
    assert.strictEqual(metrics.applicable_records, 1);
    assert.strictEqual(metrics.critical_fact_retention, 1);
    assert.strictEqual(metrics.examples.length, 1);
  }

  {
    const accepted = aggregateReplay([{
      candidate,
      metrics: {
        valid: true,
        applicable_records: 5,
        critical_fact_retention: 1,
        incremental_token_reduction: 0.06,
      },
    }], [{
      rule_id: candidate.rule_id,
      approved: true,
      pass_rate: 0.99,
      complaints: [],
    }]);
    assert.strictEqual(accepted[0].accepted, true);
    const statePath = path.join(importRoot, "accepted.json");
    const inputRules = path.join(importRoot, "rules.json");
    const promotedRules = path.join(importRoot, "promoted.json");
    fs.writeFileSync(statePath, `${JSON.stringify({ accepted: [{
      candidate,
      gate: accepted[0].gate,
    }] })}\n`, "utf8");
    fs.copyFileSync(path.join(repoRoot, "rules", "default-rules.json"), inputRules);
    const result = promoteAccepted(statePath, inputRules, promotedRules);
    assert.strictEqual(result.promoted, 1);
    const promoted = JSON.parse(fs.readFileSync(promotedRules, "utf8"));
    const rule = promoted.weak_rules.find((entry) => entry.rule_id === candidate.rule_id);
    assert(rule);
    assert.strictEqual(rule.rationale, undefined, "model rationale must not enter runtime rules");
  }

  {
    const dryCorpus = path.join(importRoot, "dry-corpus.jsonl");
    writeJsonl(dryCorpus, [
      {
        id: "train",
        source: "fixture",
        split: "train",
        command: "custom-tool",
        stdout: "uncovered output ".repeat(200),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "validation",
        source: "fixture",
        split: "validation",
        command: "custom-tool",
        stdout: "held out output ".repeat(200),
        stderr: "",
        exit_code: 0,
      },
    ]);
    const dryState = await evolveCorpus({
      repoRoot,
      corpusPath: dryCorpus,
      outPath: path.join(importRoot, "dry-state.json"),
      dryRun: true,
    });
    assert.strictEqual(dryState.status, "planned");
    assert.strictEqual(dryState.configuration.generator_model, "gpt-5.6-luna");
    assert.strictEqual(dryState.configuration.generator_effort, "max");
    assert.strictEqual(dryState.configuration.judge_model, "gpt-5.6-sol");
    assert.strictEqual(dryState.configuration.judge_effort, "high");
    assert.strictEqual(dryState.configuration.full_trajectories_uploaded, false);
  }

  console.log("research tests passed");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
