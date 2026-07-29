"use strict";

const {
  CONSERVATIVE_PASSTHROUGH_COMMAND_PATTERNS,
  RAW_FALLBACK_COMMAND_PATTERNS,
} = require("./patterns");
const {
  asInt,
  estimateTokens,
  firstString,
  matchesAny,
  objectOrEmpty,
} = require("./utils");
const {
  hasStrongCompressionCandidate,
  isCritical,
  isDenseSemanticListOutput,
  isVisualDiagnosticOutput,
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
const { resolveStrengthProfile } = require("../config/strength");

function handleClaudePostToolUse(payload, options = {}) {
  const observation = observationFromPayload(payload);
  const result = compressObservation(observation, options);
  const hookOutput = { hookEventName: "PostToolUse" };
  if (result.changed) {
    hookOutput.additionalContext = compressionContext(result);
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
  const profile = resolveStrengthProfile(options.strength || process.env.CCA_STRENGTH || "default");
  const raw = formatRaw(observation);
  const rawRef = writeRaw(raw, rawDir);
  const rawTokens = estimateTokens(raw);
  const critical = isCritical(observation, raw);

  const passthrough = passthroughReason(observation, raw, ruleSet, critical, rawDir);
  if (passthrough) {
    return passthroughResult(observation, raw, rawRef, passthrough, critical, profile.name);
  }

  const selectedStrongRules = selectRules(ruleSet.strongRules, observation.command, raw);
  const selectedWeakRules = profile.strongOnly ? [] : selectRules(ruleSet.weakRules, observation.command, raw);
  const selectedRules = selectedStrongRules.concat(selectedWeakRules);
  const strongCandidate = hasStrongCompressionCandidate(observation, raw, selectedStrongRules);

  if (rawTokens < profile.minRawTokens) {
    return passthroughResult(observation, raw, rawRef, {
      status: `${profile.name} threshold passthrough`,
      rules: ["strength_threshold_passthrough"],
    }, critical, profile.name);
  }
  if (!selectedRules.length && !critical && !strongCandidate) {
    return passthroughResult(observation, raw, rawRef, {
      status: "no matching rule passthrough",
      rules: ["no_matching_rule_passthrough"],
    }, critical, profile.name);
  }

  const blocks = splitBlocks(outputLinesFromObservation(observation), ruleSet.splitter);
  const scoredBlocks = scoreBlocks(blocks, ruleSet.importance);
  const plan = planCompression(scoredBlocks, {
    config: ruleSet.planner,
    rawTokens,
    rules: selectedRules,
    strength: profile.name,
  });
  let text = withHeader(observation, plan.body, rawRef, "compressed importance-planned output");
  let changed = estimateTokens(text) < rawTokens;
  let ruleIds = plan.ruleIds;
  if (!changed) {
    text = raw;
    ruleIds = ["no_savings_passthrough"];
  }
  const result = buildResult(text, rawRef, raw, ruleIds, critical, changed, profile.name);
  result.plan = {
    targetTokens: plan.targetTokens,
    plannedTokens: plan.plannedTokens,
    budgetExceeded: plan.budgetExceeded,
    blocks: plan.blocks,
  };
  return result;
}

function passthroughReason(observation, raw, ruleSet, critical, rawDir) {
  if (isRawFallbackRead(observation.command, rawDir)) {
    return { status: "raw fallback read passthrough", rules: ["raw_fallback_read_passthrough"] };
  }
  if (matchesAny(ruleSet.whitelist, observation.command)) {
    return { status: "whitelist passthrough", rules: ["whitelist_passthrough"] };
  }
  if (matchesAny(CONSERVATIVE_PASSTHROUGH_COMMAND_PATTERNS, observation.command)) {
    return { status: "conservative passthrough: original data inspection output", rules: ["data_inspection_passthrough"] };
  }
  if (isVisualDiagnosticOutput(observation, raw, ruleSet)) {
    return { status: "visual diagnostic passthrough", rules: ["visual_diagnostic_passthrough"] };
  }
  if (isDenseSemanticListOutput(observation)) {
    return { status: "semantic list passthrough", rules: ["semantic_list_passthrough"] };
  }
  return null;
}

function isRawFallbackRead(command, rawDir) {
  const text = String(command || "");
  if (matchesAny(RAW_FALLBACK_COMMAND_PATTERNS, text, "i")) return true;
  return Boolean(rawDir && text.includes(String(rawDir)));
}

function passthroughResult(observation, raw, rawRef, reason, critical, strength) {
  const text = withHeader(observation, raw, rawRef, reason.status);
  return buildResult(text, rawRef, raw, reason.rules, critical, false, strength);
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

function compressionContext(result) {
  return [
    "Command output was replaced by command-compressor.",
    `raw_tokens_est=${result.rawTokensEst},`,
    `compressed_tokens_est=${result.compressedTokensEst},`,
    `critical=${String(result.critical)},`,
    `changed=${String(result.changed)},`,
    `strength=${result.strength},`,
    `rules=${result.ruleIds.join("+")},`,
    `raw_ref=${result.rawRef}.`,
  ].join(" ");
}

module.exports = {
  compressObservation,
  failOpen,
  handleClaudePostToolUse,
  observationFromPayload,
};
