"use strict";

const {
  asInt,
  estimateTokens,
  firstString,
  objectOrEmpty,
} = require("./utils");
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

function handleClaudePostToolUse(payload, options = {}) {
  const observation = observationFromPayload(payload);
  const result = compressObservation(observation, options);
  const hookOutput = { hookEventName: "PostToolUse" };
  if (result.changed) {
    const toolResponse = objectOrEmpty(payload.tool_response);
    hookOutput.updatedToolOutput = {
      stdout: result.text,
      stderr: "",
      interrupted: Boolean(toolResponse.interrupted),
      isImage: Boolean(toolResponse.isImage),
    };
  }
  return { hookSpecificOutput: hookOutput };
}

function failOpen(message) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `command-compressor fail-open: ${message}`,
    },
  };
}

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

function observationFromPayload(payload) {
  const toolInput = objectOrEmpty(payload.tool_input || payload.input);
  const toolResponse = payload.tool_response || payload.output || {};
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  if (toolResponse && typeof toolResponse === "object" && !Array.isArray(toolResponse)) {
    stdout = firstString(toolResponse.stdout, toolResponse.output, toolResponse.content, "");
    stderr = firstString(toolResponse.stderr, "");
    exitCode = asInt(toolResponse.exit_code, toolResponse.exitCode, toolResponse.status);
  } else {
    stdout = firstString(toolResponse, "");
  }
  if (!stdout && !stderr && typeof payload.tool_output === "string") stdout = payload.tool_output;
  return {
    command: firstString(toolInput.command, payload.command, ""),
    stdout,
    stderr,
    exitCode,
    agent: "claude-code",
    toolName: firstString(payload.tool_name, "Bash"),
  };
}

module.exports = {
  compressObservation,
  failOpen,
  handleClaudePostToolUse,
  observationFromPayload,
};
