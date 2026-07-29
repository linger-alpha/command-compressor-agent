#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { auditCorpus } = require("./lib/audit");
const {
  candidateFromRules,
  deterministicPolicyGate,
  evolveBlockPolicy,
  finalizeBlockPolicy,
  judgeBlockPolicies,
  promoteBlockPolicy,
  replayBlockPolicy,
} = require("./lib/block-policy");
const { importCorpus } = require("./lib/corpus");
const {
  DEFAULT_GENERATOR_EFFORT,
  DEFAULT_GENERATOR_MODEL,
  DEFAULT_JUDGE_EFFORT,
  DEFAULT_JUDGE_MODEL,
  evolveCorpus,
  isJudgeEligible,
  judgeReplays,
  loadMatchingCorpusRecords,
  promoteAccepted,
} = require("./lib/evolve");
const { evaluateAgainstLegacy } = require("./lib/replay");

const REPO_ROOT = path.resolve(__dirname, "..");

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const flags = parseFlags(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "import") {
    const codexSources = values(flags, "codex-source").map(parseSource);
    const publicSources = values(flags, "public-source").map(parseSource);
    if (!codexSources.length && !publicSources.length) {
      throw new Error("Provide at least one --codex-source label=path or --public-source label=path");
    }
    const summary = await importCorpus({
      codexSources,
      publicSources,
      outPath: flags.out || path.join(REPO_ROOT, "research", "artifacts", "corpus.jsonl"),
      maxOutputChars: flags["max-output-chars"],
      maxCommandChars: flags["max-command-chars"],
      maxRecordsPerSession: flags["max-records-per-session"],
      seed: flags.seed,
    });
    print(summary);
    return 0;
  }
  if (command === "evolve") {
    if (!flags.corpus) throw new Error("--corpus is required");
    const state = await evolveCorpus({
      repoRoot: REPO_ROOT,
      corpusPath: flags.corpus,
      outPath: flags.out || path.join(REPO_ROOT, "research", "artifacts", "evolution.json"),
      rounds: flags.rounds,
      generatorModel: flags["generator-model"] || DEFAULT_GENERATOR_MODEL,
      generatorEffort: flags["generator-effort"] || DEFAULT_GENERATOR_EFFORT,
      judgeModel: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
      judgeEffort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
      generatorSamples: flags["generator-samples"],
      validationSamples: flags["validation-samples"],
      maxSampleChars: flags["max-sample-chars"],
      maxPromptChars: flags["max-prompt-chars"],
      minOutputChars: flags["min-output-chars"],
      baselineCommit: flags["baseline-commit"],
      codexBin: flags["codex-bin"],
      timeoutMs: flags["timeout-ms"],
      seed: flags.seed,
      dryRun: Boolean(flags["dry-run"]),
    });
    print(state);
    return 0;
  }
  if (command === "policy-evolve") {
    if (!flags.corpus) throw new Error("--corpus is required");
    const state = await evolveBlockPolicy({
      repoRoot: REPO_ROOT,
      corpusPath: flags.corpus,
      outPath: flags.out || path.join(REPO_ROOT, "research", "artifacts", "block-policy-evolution.json"),
      rounds: flags.rounds,
      generatorModel: flags["generator-model"] || DEFAULT_GENERATOR_MODEL,
      generatorEffort: flags["generator-effort"] || DEFAULT_GENERATOR_EFFORT,
      judgeModel: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
      judgeEffort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
      generatorSamples: flags["generator-samples"],
      trainingRecords: flags["training-records"],
      validationSamples: flags["validation-samples"],
      repetitions: flags.repetitions,
      maxSampleChars: flags["max-sample-chars"],
      maxPromptChars: flags["max-prompt-chars"],
      minOutputChars: flags["min-output-chars"],
      baselineCommit: flags["baseline-commit"],
      codexBin: flags["codex-bin"],
      timeoutMs: flags["timeout-ms"],
      seed: flags.seed,
      resumeStatePath: flags.resume,
      dryRun: Boolean(flags["dry-run"]),
    });
    print(state);
    return 0;
  }
  if (command === "policy-replay") {
    if (!flags.corpus || !flags.candidate) throw new Error("--corpus and --candidate are required");
    const candidate = loadPolicyCandidate(flags.candidate, flags["policy-id"]);
    const replay = await replayBlockPolicy({
      repoRoot: REPO_ROOT,
      corpusPath: flags.corpus,
      candidate,
      split: flags.split || "validation",
      limit: flags.limit || flags["validation-samples"],
      repetitions: flags.repetitions,
      minOutputChars: flags["min-output-chars"],
      baselineCommit: flags["baseline-commit"] || "7830b17",
      seed: flags.seed,
      maxExamples: flags["max-examples"],
    });
    print(replay);
    return 0;
  }
  if (command === "policy-judge") {
    if (!flags.corpus || !flags.candidate) throw new Error("--corpus and --candidate are required");
    const candidate = loadPolicyCandidate(flags.candidate, flags["policy-id"]);
    const candidateSource = JSON.parse(fs.readFileSync(flags.candidate, "utf8"));
    const replay = await replayBlockPolicy({
      repoRoot: REPO_ROOT,
      corpusPath: flags.corpus,
      candidate,
      split: flags.split || "validation",
      limit: flags.limit || flags["validation-samples"],
      repetitions: flags.repetitions,
      minOutputChars: flags["min-output-chars"],
      baselineCommit: flags["baseline-commit"] || "7830b17",
      seed: flags.seed,
      maxExamples: flags["max-examples"] || 3,
    });
    const verdicts = judgeBlockPolicies([{ candidate, replay }], {
      codexBin: flags["codex-bin"],
      cwd: REPO_ROOT,
      judgeModel: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
      judgeEffort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
      maxPromptChars: flags["max-prompt-chars"],
      timeoutMs: flags["timeout-ms"],
    });
    const judge = verdicts.find((entry) => entry.policy_id === candidate.policy_id) || {};
    const gate = {
      ...deterministicPolicyGate(replay),
      held_out_ai_pass_99pct: judge.approved === true && Number(judge.pass_rate) >= 0.99,
    };
    const evaluated = {
      candidate,
      replay,
      judge,
      gate,
      accepted: Object.values(gate).every(Boolean),
    };
    const state = {
      schema_version: 1,
      kind: "block-policy-evaluation",
      status: evaluated.accepted ? "validation-accepted" : "validation-rejected",
      configuration: {
        generator_model: flags["generator-model"] ||
          (candidateSource.configuration && candidateSource.configuration.generator_model) ||
          "pre-generated-candidate",
        generator_effort: flags["generator-effort"] ||
          (candidateSource.configuration && candidateSource.configuration.generator_effort) ||
          "recorded-in-candidate-source",
        judge_model: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
        judge_effort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
        baseline_commit: flags["baseline-commit"] || "7830b17",
      },
      evaluated,
      validation_accepted: evaluated.accepted ? [evaluated] : [],
      accepted: [],
    };
    if (flags.out) fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    print(state);
    return evaluated.accepted ? 0 : 2;
  }
  if (command === "policy-finalize") {
    if (!flags.corpus || !flags.state) throw new Error("--corpus and --state are required");
    const sourceState = JSON.parse(fs.readFileSync(flags.state, "utf8"));
    const state = await finalizeBlockPolicy(sourceState, {
      repoRoot: REPO_ROOT,
      corpusPath: flags.corpus,
      policyId: flags["policy-id"],
      limit: flags.limit || 300,
      repetitions: flags.repetitions || 3,
      minOutputChars: flags["min-output-chars"],
      baselineCommit: flags["baseline-commit"] || "7830b17",
      seed: flags.seed,
      maxExamples: flags["max-examples"] || 3,
    });
    if (flags.out) fs.writeFileSync(path.resolve(flags.out), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    print(state);
    return state.status === "accepted" ? 0 : 2;
  }
  if (command === "policy-promote") {
    if (!flags.state) throw new Error("--state is required");
    const rulesPath = path.resolve(flags.rules || path.join(REPO_ROOT, "rules", "default-rules.json"));
    const outPath = path.resolve(flags.out || rulesPath);
    print(promoteBlockPolicy(path.resolve(flags.state), rulesPath, outPath, {
      ...(flags["generator-model"] ? { generator_model: flags["generator-model"] } : {}),
      ...(flags["generator-effort"] ? { generator_effort: flags["generator-effort"] } : {}),
      ...(flags["judge-model"] ? { judge_model: flags["judge-model"] } : {}),
      ...(flags["judge-effort"] ? { judge_effort: flags["judge-effort"] } : {}),
    }));
    return 0;
  }
  if (command === "audit") {
    if (!flags.corpus) throw new Error("--corpus is required");
    const result = await auditCorpus(path.resolve(flags.corpus), {
      maxFieldChars: flags["max-output-chars"],
      maxCommandChars: flags["max-command-chars"],
    });
    print(result);
    return result.ok ? 0 : 2;
  }
  if (command === "replay") {
    if (!flags.corpus || !flags.candidate) throw new Error("--corpus and --candidate are required");
    const candidateFile = JSON.parse(fs.readFileSync(flags.candidate, "utf8"));
    const candidate = candidateFile.candidate || candidateFile;
    const records = await loadMatchingCorpusRecords(
      flags.corpus,
      flags.split || "validation",
      candidate,
      Number(flags.limit || 40)
    );
    print(evaluateAgainstLegacy(records, candidate, {
      repoRoot: REPO_ROOT,
      baselineCommit: flags["baseline-commit"] || "7830b17",
    }));
    return 0;
  }
  if (command === "judge") {
    if (!flags.corpus || !flags.candidate) throw new Error("--corpus and --candidate are required");
    const candidateFile = JSON.parse(fs.readFileSync(flags.candidate, "utf8"));
    const candidate = candidateFile.candidate || candidateFile;
    const records = await loadMatchingCorpusRecords(
      flags.corpus,
      flags.split || "validation",
      candidate,
      Number(flags.limit || 40)
    );
    const metrics = evaluateAgainstLegacy(records, candidate, {
      repoRoot: REPO_ROOT,
      baselineCommit: flags["baseline-commit"] || "7830b17",
    });
    if (!isJudgeEligible(metrics)) {
      print({ status: "deterministic-gate-rejected", candidate: candidate.rule_id, metrics });
      return 2;
    }
    const verdicts = judgeReplays([{ candidate, metrics }], {
      cwd: REPO_ROOT,
      codexBin: flags["codex-bin"],
      judgeModel: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
      judgeEffort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
      maxPromptChars: flags["max-prompt-chars"],
      timeoutMs: flags["timeout-ms"],
    });
    print({
      status: "judged",
      model: flags["judge-model"] || DEFAULT_JUDGE_MODEL,
      effort: flags["judge-effort"] || DEFAULT_JUDGE_EFFORT,
      candidate: candidate.rule_id,
      metrics,
      verdicts,
    });
    return 0;
  }
  if (command === "promote") {
    if (!flags.state) throw new Error("--state is required");
    const rulesPath = path.resolve(flags.rules || path.join(REPO_ROOT, "rules", "default-rules.json"));
    const outPath = path.resolve(flags.out || rulesPath);
    print(promoteAccepted(path.resolve(flags.state), rulesPath, outPath));
    return 0;
  }
  throw new Error(`Unknown research command: ${command}`);
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      flags[key] = values(flags, key).concat(value);
    } else {
      flags[key] = value;
    }
  }
  return flags;
}

function values(flags, key) {
  if (!Object.prototype.hasOwnProperty.call(flags, key)) return [];
  return Array.isArray(flags[key]) ? flags[key] : [flags[key]];
}

function parseSource(value) {
  const text = String(value);
  const separator = text.indexOf("=");
  if (separator <= 0 || separator === text.length - 1) {
    throw new Error(`Expected source in label=path form: ${text}`);
  }
  return {
    label: text.slice(0, separator),
    path: text.slice(separator + 1),
  };
}

function loadPolicyCandidate(pathname, policyId) {
  const input = JSON.parse(fs.readFileSync(pathname, "utf8"));
  if (input.block_policy || input.importance) {
    const fallbackId = path.basename(pathname, path.extname(pathname))
      .replace(/[^a-z0-9_-]+/gi, "_")
      .toLowerCase();
    return candidateFromRules(input, fallbackId);
  }
  const candidates = [];
  if (input.candidate) candidates.push(input.candidate);
  if (input.policy_id && input.signals) candidates.push(input);
  for (const entry of input.accepted || []) if (entry.candidate) candidates.push(entry.candidate);
  for (const round of input.rounds || []) {
    for (const entry of round.evaluated || []) if (entry.candidate) candidates.push(entry.candidate);
  }
  for (const entry of input.frozen || []) if (entry.candidate) candidates.push(entry.candidate);
  const unique = Array.from(new Map(candidates.map((candidate) => [candidate.policy_id, candidate])).values());
  if (policyId) {
    const selected = unique.find((candidate) => candidate.policy_id === policyId);
    if (!selected) throw new Error(`Policy ${policyId} was not found in ${pathname}`);
    return selected;
  }
  if (unique.length !== 1) {
    throw new Error(`Candidate file contains ${unique.length} policies; select one with --policy-id`);
  }
  return unique[0];
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write([
    "CCA offline research tools (not included in the npm package)",
    "",
    "Usage:",
    "  node research/cli.js import --codex-source rtx=/path --public-source terminaltraj=/path --out corpus.jsonl",
    "  node research/cli.js audit --corpus corpus.jsonl",
    "  node research/cli.js evolve --corpus corpus.jsonl [--generator-effort max] [--judge-effort high]",
    "  node research/cli.js policy-evolve --corpus corpus.jsonl [--repetitions 3] [--resume prior-state.json] [--dry-run]",
    "  node research/cli.js policy-replay --corpus corpus.jsonl --candidate rules/default-rules.json [--repetitions 3]",
    "  node research/cli.js policy-judge --corpus corpus.jsonl --candidate evolution.json --policy-id id [--judge-effort high]",
    "  node research/cli.js policy-finalize --corpus corpus.jsonl --state judged.json --policy-id id [--repetitions 3]",
    "  node research/cli.js policy-promote --state block-policy-evolution.json [--rules rules/default-rules.json]",
    "  node research/cli.js replay --corpus corpus.jsonl --candidate candidate.json",
    "  node research/cli.js judge --corpus corpus.jsonl --candidate candidate.json [--judge-effort high]",
    "  node research/cli.js promote --state evolution.json [--rules rules/default-rules.json]",
    "",
  ].join("\n"));
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`cca research: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  main,
  parseFlags,
  parseSource,
};
