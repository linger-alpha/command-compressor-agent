#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { auditCorpus } = require("./lib/audit");
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
