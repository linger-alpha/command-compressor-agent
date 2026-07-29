"use strict";

const fs = require("fs");
const path = require("path");

const { commandPassthroughReason } = require("../../src/compression/command-policy");
const { loadRuleSet } = require("../../src/compression/rules");
const {
  candidateFromRules,
  evaluatePolicyAgainstLegacy,
} = require("../lib/block-policy");

function buildStaticReplayReport(options) {
  const repoRoot = path.resolve(options.repoRoot);
  const rulesPath = path.join(repoRoot, "rules", "default-rules.json");
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  const candidate = candidateFromRules(rules, "current_static_rules");
  const primary = Array.isArray(options.primaryRecords) ? options.primaryRecords : [];
  const union = Array.isArray(options.unionRecords) ? options.unionRecords : [];
  const primaryWithOutput = primary.filter(hasOutput);
  const ruleSet = loadRuleSet(rulesPath);
  const general = primary.filter((record) =>
    !commandPassthroughReason(record.command, "", ruleSet.commandPolicy)
  );
  const replayOptions = {
    repoRoot,
    baselineCommit: options.baselineCommit || "7830b17",
    maxExamples: 1,
  };
  const primaryMetrics = replayRecords(primary, candidate, replayOptions);
  const generalMetrics = replayRecords(general, candidate, replayOptions);
  const unionMetrics = replayRecords(union, candidate, replayOptions);
  const primaryByTrial = replayByField(primary, "trial_id", candidate, replayOptions);
  const generalByTrial = replayByField(general, "trial_id", candidate, replayOptions);
  const observedTasks = new Set(primary.map((record) => String(record.task || record.source || "")));
  const expectedTasks = Array.isArray(options.expectedTasks) ? options.expectedTasks : [];
  const checks = {
    primary_observations_present: primaryWithOutput.length > 0,
    all_selected_tasks_observed:
      expectedTasks.length > 0 && expectedTasks.every((task) => observedTasks.has(task)),
    critical_fact_coverage_present: primaryMetrics.critical_lines > 0,
    protected_block_coverage_present: primaryMetrics.protected_blocks > 0,
    current_critical_fact_retention_100pct:
      primaryMetrics.critical_lines > 0 && primaryMetrics.critical_fact_retention === 1,
    current_protected_block_retention_100pct:
      primaryMetrics.protected_blocks > 0 && primaryMetrics.protected_block_retention === 1,
    current_general_output_5pct_below_legacy:
      general.length > 0 && generalMetrics.current_vs_legacy_reduction >= 0.05,
  };
  return {
    schema_version: 1,
    experiment_id: options.experimentId || null,
    baseline_commit: replayOptions.baselineCommit,
    current_commit: options.currentCommit || null,
    selection: {
      primary: "all captured Tool Results from no-compression trials",
      general_commands:
        "primary records excluding RTK, fallback reads, and read-only command-policy passthroughs",
      union_diagnostic: "all captured Tool Results from every arm; diagnostic only",
    },
    corpus: options.corpusStats || {},
    primary_all_outputs: primaryMetrics,
    primary_all_outputs_by_trial: primaryByTrial,
    primary_general_commands: generalMetrics,
    primary_general_commands_by_trial: generalByTrial,
    all_arms_union_diagnostic: unionMetrics,
    static_checks: {
      passed: Object.values(checks).every(Boolean),
      checks,
    },
  };
}

function replayByField(records, field, candidate, options) {
  if (!records.length) return {};
  const grouped = records.map((record, index) => ({
    ...record,
    source: String(record[field] || record.source || `group-${index + 1}`),
  }));
  return replayRecords(grouped, candidate, {
    ...options,
    maxExamples: 0,
  }).by_source || {};
}

function hasOutput(record) {
  return String(record && record.stdout || "").length > 0 ||
    String(record && record.stderr || "").length > 0;
}

function replayRecords(records, candidate, options) {
  if (!records.length) return emptyMetrics();
  const metrics = evaluatePolicyAgainstLegacy(records, candidate, options);
  const {
    examples: _examples,
    loss_examples: _lossExamples,
    candidate_tokens_est: candidateTokens,
    incremental_token_reduction: incrementalReduction,
    raw_token_reduction: currentRawReduction,
    ...rest
  } = metrics;
  return {
    ...rest,
    current_tokens_est: candidateTokens,
    legacy_raw_token_reduction: metrics.raw_tokens_est
      ? (metrics.raw_tokens_est - metrics.legacy_tokens_est) / metrics.raw_tokens_est
      : 0,
    current_raw_token_reduction: currentRawReduction,
    current_vs_legacy_reduction: incrementalReduction,
  };
}

function emptyMetrics() {
  return {
    valid: false,
    eligible_records: 0,
    raw_tokens_est: 0,
    legacy_tokens_est: 0,
    current_tokens_est: 0,
    legacy_raw_token_reduction: null,
    current_raw_token_reduction: null,
    current_vs_legacy_reduction: null,
    critical_fact_retention: null,
    legacy_critical_fact_retention: null,
    protected_block_retention: null,
    legacy_protected_block_retention: null,
  };
}

module.exports = {
  buildStaticReplayReport,
  replayByField,
  replayRecords,
};
