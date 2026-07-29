"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { auditCorpus } = require("../lib/audit");
const {
  buildTrainingBlockSamples,
  candidateFromRules,
  criticalLinesForOutput,
  deterministicPolicyGate,
  evolveBlockPolicy,
  finalizeBlockPolicy,
  isCriticalFactLine,
  loadPolicyRecords,
  promoteBlockPolicy,
  replayBlockPolicy,
  validatePolicyCandidate,
} = require("../lib/block-policy");
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

  const bundledRules = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "rules", "default-rules.json"), "utf8")
  );
  const bootstrapPolicy = candidateFromRules(bundledRules, "bootstrap_policy");
  {
    const validation = validatePolicyCandidate(bootstrapPolicy);
    assert.strictEqual(validation.valid, true, validation.errors.join("; "));
    const normalizedModelPolicy = {
      ...bootstrapPolicy,
      signals: bootstrapPolicy.signals.map((signal) => {
        if (signal.kind) return { ...signal, pattern: "(?im)", flags: "im" };
        if (signal.id === "traceback_exception") {
          return { ...signal, pattern: `(?im)${signal.pattern}`, flags: "im" };
        }
        return signal;
      }),
    };
    assert.strictEqual(
      validatePolicyCandidate(normalizedModelPolicy).valid,
      true,
      "research normalization may remove schema placeholders and move inline flags, without changing policy"
    );
    const unsafe = {
      ...bootstrapPolicy,
      signals: bootstrapPolicy.signals.map((signal) =>
        signal.id === "opaque_encoded" ? { ...signal, tier: "aggressive" } : signal
      ),
    };
    assert.strictEqual(validatePolicyCandidate(unsafe).valid, false);
    assert.strictEqual(isCriticalFactLine("  [--watchdog-timeout WATCHDOG_TIMEOUT]"), false);
    assert.strictEqual(isCriticalFactLine("Command timed out after 30 seconds"), true);
    assert.strictEqual(isCriticalFactLine("TimeoutError: request failed"), true);
    assert.deepStrictEqual(
      criticalLinesForOutput([
        "> echoed heredoc source",
        "ordinary output",
        "> assert value == 2",
        "E   AssertionError: expected 2",
      ]),
      ["> assert value == 2", "E   AssertionError: expected 2"],
      "shell continuation prompts are not failure context unless adjacent to an actual failure"
    );
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
    const policyCorpus = path.join(importRoot, "policy-corpus.jsonl");
    writeJsonl(policyCorpus, [
      {
        id: "read-only",
        source: "fixture",
        session_id: "one",
        split: "validation",
        command: "git diff | sed -n '1,80p'",
        stdout: "diff detail ".repeat(100),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "general",
        source: "fixture",
        session_id: "two",
        split: "validation",
        command: "python build.py",
        stdout: Array.from({ length: 200 }, (_, index) =>
          `Downloading artifact ${index} ${index % 100}%|████| ${index}/200 [1MB/s]`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "general-test",
        source: "fixture",
        session_id: "three",
        split: "test",
        command: "python build.py",
        stdout: Array.from({ length: 220 }, (_, index) =>
          `Downloading test artifact ${index} ${index % 100}%|████| ${index}/220 [1MB/s]`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
    ]);
    const records = await loadPolicyRecords(policyCorpus, {
      split: "validation",
      limit: 10,
      minOutputChars: 20,
      rulesPath: path.join(repoRoot, "rules", "default-rules.json"),
    });
    assert.deepStrictEqual(records.map((record) => record.id), ["general"]);
    const blocks = buildTrainingBlockSamples(records, { limit: 4 });
    assert(blocks.length > 0);
    assert(blocks.every((block) => typeof block.sample_class === "string"));
    const balancedBlocks = buildTrainingBlockSamples([
      {
        id: "a-progress",
        source: "alpha",
        command: "custom build",
        stdout: Array.from(
          { length: 30 },
          (_, index) => `Downloading alpha-${index} ${index}%|====| ${index}/30 [1MB/s]`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "a-ordinary",
        source: "alpha",
        command: "custom build",
        stdout: Array.from(
          { length: 30 },
          (_, index) => `compiled alpha module ${index} successfully`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "b-progress",
        source: "beta",
        command: "custom build",
        stdout: Array.from(
          { length: 30 },
          (_, index) => `Downloading beta-${index} ${index}%|====| ${index}/30 [1MB/s]`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
      {
        id: "b-ordinary",
        source: "beta",
        command: "custom build",
        stdout: Array.from(
          { length: 30 },
          (_, index) => `compiled beta module ${index} successfully`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
    ], { limit: 4, seed: "balanced" });
    assert.deepStrictEqual(
      new Set(balancedBlocks.map((block) => block.source)),
      new Set(["alpha", "beta"])
    );
    assert.deepStrictEqual(
      new Set(balancedBlocks.map((block) => block.sample_class)),
      new Set(["ordinary", "progress"])
    );
    const replay = await replayBlockPolicy({
      repoRoot,
      corpusPath: policyCorpus,
      candidate: bootstrapPolicy,
      split: "validation",
      limit: 10,
      repetitions: 2,
      minOutputChars: 20,
      baselineCommit: "7830b17",
      maxExamples: 1,
    });
    assert.strictEqual(replay.repeats.length, 2);
    assert(replay.repeats.every((entry) => entry.eligible_records === 1));
    const gate = deterministicPolicyGate(replay);
    assert.strictEqual(gate.candidate_valid, true);
    assert.strictEqual(gate.critical_fact_retention_100pct, true);
    assert.strictEqual(gate.protected_block_retention_100pct, true);

    const validationGate = {
      candidate_valid: true,
      held_out_records_present: true,
      critical_fact_retention_100pct: true,
      protected_block_retention_100pct: true,
      no_model_visible_diagnostics: true,
      every_repeat_incremental_reduction_5pct: true,
      held_out_ai_pass_99pct: true,
    };
    const validationState = {
      configuration: {
        generator_model: "gpt-5.6-luna",
        generator_effort: "max",
        judge_model: "gpt-5.6-sol",
        judge_effort: "high",
        baseline_commit: "7830b17",
      },
      evaluated: {
        candidate: bootstrapPolicy,
        replay,
        judge: { approved: true, pass_rate: 1, complaints: [] },
        gate: validationGate,
        accepted: true,
      },
    };
    const finalState = await finalizeBlockPolicy(validationState, {
      repoRoot,
      corpusPath: policyCorpus,
      limit: 10,
      repetitions: 2,
      minOutputChars: 20,
      baselineCommit: "7830b17",
    });
    assert.strictEqual(finalState.status, "accepted");
    assert.strictEqual(finalState.accepted[0].test_gate.critical_fact_retention_100pct, true);
    assert.deepStrictEqual(finalState.accepted[0].test_complaints, []);

    const rulesInput = path.join(importRoot, "block-policy-rules.json");
    const rulesOutput = path.join(importRoot, "block-policy-promoted.json");
    const finalStatePath = path.join(importRoot, "block-policy-final.json");
    fs.copyFileSync(path.join(repoRoot, "rules", "default-rules.json"), rulesInput);
    fs.writeFileSync(finalStatePath, `${JSON.stringify(finalState)}\n`, "utf8");
    const promotedPolicy = promoteBlockPolicy(finalStatePath, rulesInput, rulesOutput);
    assert.strictEqual(promotedPolicy.promoted, bootstrapPolicy.policy_id);
    const promotedRules = JSON.parse(fs.readFileSync(rulesOutput, "utf8"));
    assert.strictEqual(promotedRules.block_policy.provenance.status, "accepted");
    assert.strictEqual(promotedRules.block_policy.provenance.generator_model, "gpt-5.6-luna");
    assert.strictEqual(promotedRules.block_policy.rationale, undefined);

    const unsafeStatePath = path.join(importRoot, "block-policy-no-test.json");
    fs.writeFileSync(unsafeStatePath, `${JSON.stringify({
      accepted: [{ candidate: bootstrapPolicy, gate: validationGate }],
    })}\n`, "utf8");
    assert.throws(
      () => promoteBlockPolicy(unsafeStatePath, rulesInput, rulesOutput),
      /test gate/,
      "validation and judge approval alone must never authorize production promotion"
    );
  }

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

    const policyDryState = await evolveBlockPolicy({
      repoRoot,
      corpusPath: dryCorpus,
      outPath: path.join(importRoot, "dry-policy-state.json"),
      dryRun: true,
      minOutputChars: 20,
    });
    assert.strictEqual(policyDryState.status, "planned");
    assert.strictEqual(policyDryState.kind, "block-policy-evolution");
    assert.strictEqual(policyDryState.configuration.generator_effort, "max");
    assert.strictEqual(policyDryState.configuration.judge_effort, "high");
    assert.strictEqual(policyDryState.configuration.full_trajectories_uploaded, false);
    assert.match(policyDryState.configuration.remote_block_sample_sha256, /^[a-f0-9]{64}$/);

    const priorPolicyStatePath = path.join(importRoot, "prior-policy-state.json");
    fs.writeFileSync(priorPolicyStatePath, `${JSON.stringify({
      ...policyDryState,
      status: "no-policy-passed",
      configuration: {
        ...policyDryState.configuration,
        max_rounds: 1,
      },
      rounds: [{ round: 1, generated: 1, evaluated: [] }],
      frozen: [{
        policy_id: "rejected_policy",
        candidate: { policy_id: "rejected_policy" },
        complaints: ["Failed gate: held_out_ai_pass_99pct"],
      }],
    }, null, 2)}\n`, "utf8");
    const resumedPolicyState = await evolveBlockPolicy({
      repoRoot,
      corpusPath: dryCorpus,
      outPath: path.join(importRoot, "resumed-policy-state.json"),
      resumeStatePath: priorPolicyStatePath,
      rounds: 2,
      dryRun: true,
      minOutputChars: 20,
    });
    assert.strictEqual(resumedPolicyState.status, "planned");
    assert.strictEqual(resumedPolicyState.rounds.length, 1);
    assert.strictEqual(resumedPolicyState.frozen.length, 1);
    assert.strictEqual(resumedPolicyState.configuration.max_rounds, 2);
    assert.strictEqual(resumedPolicyState.configuration.repetitions, 3);
    assert.strictEqual(resumedPolicyState.resumed_from, priorPolicyStatePath);
    await assert.rejects(
      () => evolveBlockPolicy({
        repoRoot,
        corpusPath: dryCorpus,
        outPath: path.join(importRoot, "mismatched-policy-state.json"),
        resumeStatePath: priorPolicyStatePath,
        rounds: 2,
        dryRun: true,
        minOutputChars: 20,
        seed: "different-seed",
      }),
      /Resume configuration mismatch for seed/
    );
  }

  console.log("research tests passed");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
