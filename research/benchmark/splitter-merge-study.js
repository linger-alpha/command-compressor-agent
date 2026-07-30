#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { commandPassthroughReason } = require("../../src/compression/command-policy");
const { compressObservation } = require("../../src/compression/compressor");
const { outputLinesFromObservation } = require("../../src/compression/format");
const { loadRuleSet } = require("../../src/compression/rules");
const {
  isDenseSemanticBlock,
  isOpaqueEncodedBlock,
  isVisualStructureBlock,
} = require("../../src/compression/scorer");
const { splitBlocks } = require("../../src/compression/splitter");
const { estimateTokens } = require("../../src/compression/utils");
const {
  codexReplacementText,
  replacementIsWorthwhile,
} = require("../../src/takeover/presentation");
const { criticalLinesForOutput } = require("../lib/block-policy");
const {
  observationCorporaFromJobs,
} = require("./cli");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CANDIDATES = [
  {
    id: "disabled",
    merge: { enabled: false, max_separator_lines: 0, tiers: ["light"] },
  },
  {
    id: "light_gap0",
    merge: { enabled: true, max_separator_lines: 0, tiers: ["light"] },
  },
  {
    id: "light_gap1",
    merge: { enabled: true, max_separator_lines: 1, tiers: ["light"] },
  },
  {
    id: "light_gap2",
    merge: { enabled: true, max_separator_lines: 2, tiers: ["light"] },
  },
  {
    id: "light_gap4",
    merge: { enabled: true, max_separator_lines: 4, tiers: ["light"] },
  },
  {
    id: "low_gap1",
    merge: {
      enabled: true,
      max_separator_lines: 1,
      tiers: ["light", "aggressive"],
    },
  },
  {
    id: "low_gap2",
    merge: {
      enabled: true,
      max_separator_lines: 2,
      tiers: ["light", "aggressive"],
    },
  },
];

function buildStudy(options) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const manifest = readJson(path.resolve(options.planPath));
  const corpora = observationCorporaFromJobs(
    manifest,
    path.resolve(options.jobsDir)
  );
  const records = corpora.primary;
  const baseRulesPath = path.join(repoRoot, "rules", "default-rules.json");
  const baseRules = readJson(baseRulesPath);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cca-splitter-merge-study-"));
  try {
    const baselineRules = structuredClone(baseRules);
    baselineRules.planner = baselineRules.planner || {};
    baselineRules.planner.merge_adjacent_low_value = {
      enabled: false,
      max_separator_lines: 0,
      tiers: ["light"],
    };
    const baselineRulesPath = path.join(temporary, "baseline-rules.json");
    fs.writeFileSync(
      baselineRulesPath,
      `${JSON.stringify(baselineRules, null, 2)}\n`,
      "utf8"
    );
    const evaluations = CANDIDATES.map((candidate, index) => {
      const candidateRules = structuredClone(baseRules);
      candidateRules.planner = candidateRules.planner || {};
      candidateRules.planner.merge_adjacent_low_value = candidate.merge;
      const runKey = `c${String(index).padStart(2, "0")}`;
      const candidateRulesPath = path.join(temporary, `${runKey}.json`);
      fs.writeFileSync(
        candidateRulesPath,
        `${JSON.stringify(candidateRules, null, 2)}\n`,
        "utf8"
      );
      return {
        ...candidate,
        metrics: evaluateCandidate(
          records,
          baselineRulesPath,
          candidateRulesPath,
          temporary,
          runKey
        ),
      };
    });
    const selection = selectCandidate(evaluations);
    return {
      schema_version: 1,
      kind: "adjacent-low-value-block-merge-study",
      experiment_id: manifest.experiment_id,
      current_commit: manifest.current_commit,
      corpus: corpora.stats,
      split: {
        train: "repeat 1",
        validation: "repeat 2",
        test: "repeat 3; excluded from candidate ranking",
      },
      frozen_guards: [
        "command-policy read and raw_ref passthrough",
        "opaque/base64/hex preserve blocks",
        "dense-semantic preserve blocks",
        "visual preserve blocks",
      ],
      candidates: evaluations,
      selection,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function evaluateCandidate(
  records,
  baseRulesPath,
  candidateRulesPath,
  temporary,
  candidateId
) {
  const candidateRuleSet = loadRuleSet(candidateRulesPath);
  const buckets = new Map();
  for (const record of records) {
    const split = splitForRecord(record);
    const observation = observationFromRecord(record);
    const passthrough = commandPassthroughReason(
      observation.command,
      "",
      candidateRuleSet.commandPolicy
    );
    const baseline = compressObservation(observation, {
      strength: "xhigh",
      rawDir: path.join(temporary, "raw", candidateId, "base"),
      rulesPath: baseRulesPath,
    });
    const candidate = compressObservation(observation, {
      strength: "xhigh",
      rawDir: path.join(temporary, "raw", candidateId, "cand"),
      rulesPath: candidateRulesPath,
    });
    const facts = recordFacts(
      record,
      observation,
      baseline,
      candidate,
      candidateRuleSet,
      passthrough
    );
    addFacts(bucket(buckets, "all"), facts);
    addFacts(bucket(buckets, split), facts);
    if (!passthrough) {
      addFacts(bucket(buckets, "general"), facts);
      addFacts(bucket(buckets, `${split}_general`), facts);
    }
  }
  return Object.fromEntries(
    Array.from(buckets, ([name, value]) => [name, finalizeFacts(value)])
  );
}

function recordFacts(
  record,
  observation,
  baseline,
  candidate,
  ruleSet,
  passthrough
) {
  const baselineTokens = effectiveTokens(baseline);
  const candidateTokens = effectiveTokens(candidate);
  const baselineCodex = codexVisibleFacts(observation, baseline);
  const candidateCodex = codexVisibleFacts(observation, candidate);
  const originalLines = outputLinesFromObservation(observation);
  const criticalLines = criticalLinesForOutput(originalLines);
  const protectedBlocks = splitBlocks(originalLines, ruleSet.splitter)
    .filter((block) => !block.separator && isProtectedBlock(block, ruleSet.blockPolicy));
  const encodedBlocks = protectedBlocks.filter((block) =>
    isOpaqueEncodedBlock(block.lines, ruleSet.blockPolicy.opaque_encoded)
  );
  return {
    id: String(record.id || ""),
    source: String(record.source || "unknown"),
    baselineTokens,
    candidateTokens,
    baselineCodexTokens: baselineCodex.tokens,
    candidateCodexTokens: candidateCodex.tokens,
    baselineCodexChanged: baselineCodex.changed,
    candidateCodexChanged: candidateCodex.changed,
    baselineBlocks: planBlockCount(baseline),
    candidateBlocks: planBlockCount(candidate),
    merged: candidate.ruleIds.includes("adjacent_low_value_merge"),
    critical: criticalLines.length,
    criticalRetained: criticalLines.filter((line) => candidate.text.includes(line)).length,
    protected: protectedBlocks.length,
    protectedRetained: protectedBlocks.filter((block) =>
      candidate.text.includes(block.lines.join("\n"))
    ).length,
    encoded: encodedBlocks.length,
    encodedRetained: encodedBlocks.filter((block) =>
      candidate.text.includes(block.lines.join("\n"))
    ).length,
    passthrough: Boolean(passthrough),
    passthroughViolation: Boolean(passthrough && candidate.changed),
  };
}

function isProtectedBlock(block, blockPolicy) {
  return isOpaqueEncodedBlock(block.lines, blockPolicy.opaque_encoded) ||
    isDenseSemanticBlock(block.lines, blockPolicy.dense_semantic) ||
    isVisualStructureBlock(block.lines, blockPolicy.visual);
}

function emptyFacts() {
  return {
    records: 0,
    baselineTokens: 0,
    candidateTokens: 0,
    baselineCodexTokens: 0,
    candidateCodexTokens: 0,
    baselineCodexChangedRecords: 0,
    candidateCodexChangedRecords: 0,
    baselineBlocks: 0,
    candidateBlocks: 0,
    mergedRecords: 0,
    critical: 0,
    criticalRetained: 0,
    protected: 0,
    protectedRetained: 0,
    encoded: 0,
    encodedRetained: 0,
    passthroughRecords: 0,
    passthroughViolations: 0,
    source: {},
    savings: [],
  };
}

function addFacts(target, facts) {
  target.records += 1;
  target.baselineTokens += facts.baselineTokens;
  target.candidateTokens += facts.candidateTokens;
  target.baselineCodexTokens += facts.baselineCodexTokens;
  target.candidateCodexTokens += facts.candidateCodexTokens;
  target.baselineCodexChangedRecords += facts.baselineCodexChanged ? 1 : 0;
  target.candidateCodexChangedRecords += facts.candidateCodexChanged ? 1 : 0;
  target.baselineBlocks += facts.baselineBlocks;
  target.candidateBlocks += facts.candidateBlocks;
  target.mergedRecords += facts.merged ? 1 : 0;
  target.critical += facts.critical;
  target.criticalRetained += facts.criticalRetained;
  target.protected += facts.protected;
  target.protectedRetained += facts.protectedRetained;
  target.encoded += facts.encoded;
  target.encodedRetained += facts.encodedRetained;
  target.passthroughRecords += facts.passthrough ? 1 : 0;
  target.passthroughViolations += facts.passthroughViolation ? 1 : 0;
  const source = target.source[facts.source] || {
    records: 0,
    baseline_tokens_est: 0,
    candidate_tokens_est: 0,
  };
  source.records += 1;
  source.baseline_tokens_est += facts.baselineTokens;
  source.candidate_tokens_est += facts.candidateTokens;
  target.source[facts.source] = source;
  if (facts.candidateTokens < facts.baselineTokens) {
    target.savings.push({
      sample_id: facts.id,
      source: facts.source,
      saved_tokens_est: facts.baselineTokens - facts.candidateTokens,
    });
  }
}

function finalizeFacts(value) {
  const bySource = Object.fromEntries(
    Object.entries(value.source).map(([source, facts]) => [
      source,
      {
        ...facts,
        reduction_vs_current: reduction(
          facts.baseline_tokens_est,
          facts.candidate_tokens_est
        ),
      },
    ])
  );
  return {
    records: value.records,
    current_tokens_est: value.baselineTokens,
    candidate_tokens_est: value.candidateTokens,
    reduction_vs_current: reduction(
      value.baselineTokens,
      value.candidateTokens
    ),
    current_codex_visible_tokens_est: value.baselineCodexTokens,
    candidate_codex_visible_tokens_est: value.candidateCodexTokens,
    codex_visible_reduction_vs_current: reduction(
      value.baselineCodexTokens,
      value.candidateCodexTokens
    ),
    current_codex_visible_changed_records: value.baselineCodexChangedRecords,
    candidate_codex_visible_changed_records: value.candidateCodexChangedRecords,
    current_plan_blocks: value.baselineBlocks,
    candidate_plan_blocks: value.candidateBlocks,
    plan_block_reduction: reduction(
      value.baselineBlocks,
      value.candidateBlocks
    ),
    merged_records: value.mergedRecords,
    critical_lines: value.critical,
    critical_fact_retention: ratio(value.criticalRetained, value.critical),
    protected_blocks: value.protected,
    protected_block_retention: ratio(value.protectedRetained, value.protected),
    encoded_blocks: value.encoded,
    encoded_block_retention: ratio(value.encodedRetained, value.encoded),
    passthrough_records: value.passthroughRecords,
    passthrough_violations: value.passthroughViolations,
    by_source: bySource,
    top_savings: value.savings
      .sort((left, right) => right.saved_tokens_est - left.saved_tokens_est)
      .slice(0, 8),
  };
}

function selectCandidate(evaluations) {
  const ranked = evaluations
    .filter((entry) => entry.id !== "disabled")
    .map((entry) => ({
      id: entry.id,
      merge: entry.merge,
      train: entry.metrics.train_general,
      validation: entry.metrics.validation_general,
      eligible:
        safetyPassed(entry.metrics.train_general) &&
        safetyPassed(entry.metrics.validation_general) &&
        entry.metrics.validation_general.reduction_vs_current > 0,
    }))
    .filter((entry) => entry.eligible)
    .sort((left, right) =>
      right.validation.reduction_vs_current - left.validation.reduction_vs_current ||
      right.train.reduction_vs_current - left.train.reduction_vs_current ||
      left.merge.max_separator_lines - right.merge.max_separator_lines ||
      left.id.localeCompare(right.id)
    );
  const selected = ranked[0] || null;
  const full = selected
    ? evaluations.find((entry) => entry.id === selected.id)
    : null;
  return {
    ranking_basis:
      "highest validation reduction after exact train/validation critical, protected, encoded, and passthrough gates; test excluded",
    selected: selected && selected.id,
    selected_config: selected && selected.merge,
    eligible: ranked.map((entry) => entry.id),
    held_out_test: full ? full.metrics.test_general : null,
    accepted:
      Boolean(full) &&
      safetyPassed(full.metrics.test_general) &&
      full.metrics.test_general.reduction_vs_current >= 0,
  };
}

function safetyPassed(metrics) {
  return Boolean(metrics) &&
    metrics.critical_fact_retention === 1 &&
    metrics.protected_block_retention === 1 &&
    metrics.encoded_block_retention === 1 &&
    metrics.passthrough_violations === 0;
}

function splitForRecord(record) {
  if (Number(record.repeat) === 1) return "train";
  if (Number(record.repeat) === 2) return "validation";
  return "test";
}

function observationFromRecord(record) {
  return {
    command: String(record.command || ""),
    stdout: String(record.stdout || ""),
    stderr: String(record.stderr || ""),
    exitCode: record.exit_code == null ? null : Number(record.exit_code),
    agent: "research",
    toolName: "Bash",
  };
}

function effectiveTokens(result) {
  return result.changed ? result.compressedTokensEst : result.rawTokensEst;
}

function codexVisibleFacts(observation, result) {
  const originalOutput = [observation.stdout, observation.stderr]
    .filter(Boolean)
    .join("\n");
  const rawTokens = estimateTokens(originalOutput);
  if (!result.changed) return { tokens: rawTokens, changed: false };
  const replacementText = codexReplacementText(result);
  const replacementTokens = estimateTokens(replacementText);
  return replacementIsWorthwhile(observation, replacementText)
    ? { tokens: replacementTokens, changed: true }
    : { tokens: rawTokens, changed: false };
}

function planBlockCount(result) {
  return result.plan && Array.isArray(result.plan.blocks)
    ? result.plan.blocks.length
    : 0;
}

function bucket(buckets, name) {
  if (!buckets.has(name)) buckets.set(name, emptyFacts());
  return buckets.get(name);
}

function reduction(before, after) {
  return before ? (before - after) / before : 0;
}

function ratio(retained, total) {
  return total ? retained / total : 1;
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) continue;
    flags[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return flags;
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  if (!flags.plan || !flags["jobs-dir"]) {
    throw new Error("--plan and --jobs-dir are required");
  }
  const report = buildStudy({
    repoRoot: REPO_ROOT,
    planPath: flags.plan,
    jobsDir: flags["jobs-dir"],
  });
  if (flags.out) {
    const outPath = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `cca splitter merge study: ${error && error.message ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

module.exports = {
  CANDIDATES,
  buildStudy,
  codexVisibleFacts,
  selectCandidate,
  splitForRecord,
};
