"use strict";

const { estimateTokens } = require("./utils");
const {
  isCritical,
} = require("./classifiers");
const {
  buildResult,
  formatRaw,
  outputLinesFromObservation,
  withHeader,
  writeRaw,
} = require("./format");
const { loadRuleSet, selectRules } = require("./rules");
const { splitBlocks } = require("./splitter");
const { scoreBlocks } = require("./scorer");
const { planCompression } = require("./planner");
const { commandPassthroughReason } = require("./command-policy");
const { normalizeStrength } = require("../config/strength");

function compressObservation(observation, options = {}) {
  const ruleSet = loadRuleSet(options.rulesPath);
  const rawDir = options.rawDir || process.env.COMMAND_COMPRESSOR_RAW_DIR || ".command-compressor/raw";
  const strength = normalizeStrength(options.strength || process.env.CCA_STRENGTH || "default");
  const raw = formatRaw(observation);
  const rawRef = writeRaw(raw, rawDir);
  const rawTokens = estimateTokens(raw);
  const critical = isCritical(observation, raw);

  const passthrough = commandPassthroughReason(observation.command, rawDir, ruleSet.commandPolicy);
  if (passthrough) {
    return passthroughResult(raw, rawRef, passthrough, critical, strength);
  }

  const selectedStrongRules = selectRules(ruleSet.strongRules, observation.command, raw);
  const selectedWeakRules = selectRules(ruleSet.weakRules, observation.command, raw);
  const selectedRules = selectedStrongRules.concat(selectedWeakRules);

  const blocks = splitBlocks(outputLinesFromObservation(observation), ruleSet.splitter);
  const scoredBlocks = scoreBlocks(blocks, ruleSet.blockPolicy);
  const plan = planCompression(scoredBlocks, {
    config: ruleSet.planner,
    rules: selectedRules,
  });
  let text = withHeader(observation, plan.body, rawRef);
  let changed = estimateTokens(text) < rawTokens;
  let ruleIds = plan.ruleIds;
  if (!changed) {
    text = raw;
    ruleIds = ["no_savings_passthrough"];
  }
  const result = buildResult(text, rawRef, raw, ruleIds, critical, changed, strength);
  result.plan = {
    plannedTokens: plan.plannedTokens,
    blocks: plan.blocks,
  };
  return result;
}

function passthroughResult(raw, rawRef, reason, critical, strength) {
  return buildResult(raw, rawRef, raw, reason.rules, critical, false, strength);
}

module.exports = {
  compressObservation,
};
