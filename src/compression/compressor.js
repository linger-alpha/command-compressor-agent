"use strict";

const {
  CONSERVATIVE_PASSTHROUGH_COMMAND_PATTERNS,
  KEEP_PATTERNS,
  RAW_FALLBACK_COMMAND_PATTERNS,
  STRIP_PATTERNS,
} = require("./patterns");
const {
  asInt,
  estimateTokens,
  firstString,
  matchesAny,
  numberOr,
  objectOrEmpty,
} = require("./utils");
const {
  criticalFacts,
  hasStrongCompressionCandidate,
  isCritical,
  isCriticalContextLine,
  isCriticalLine,
  isDenseSemanticListOutput,
  isVisualDiagnosticOutput,
} = require("./classifiers");
const {
  appliedRuleIds,
  buildResult,
  foldRepeats,
  formatRaw,
  outputLinesFromObservation,
  withHeader,
  writeRaw,
} = require("./format");
const { dropProgressLines, progressSummary } = require("./progress");
const { loadRuleSet, selectRules } = require("./rules");
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

  const strongOnly = profile.strongOnly || !selectedWeakRules.length;
  const [body, ids] = critical
    ? compressCriticalLines(observation, 4, 8, 80)
    : compressLines(observation, selectedRules, 12, 24, 120, { strongOnly });
  let text = withHeader(observation, body, rawRef, critical ? "compressed critical output" : "compressed static output");
  let changed = estimateTokens(text) < rawTokens;
  let ruleIds = ids;
  if (!changed) {
    text = raw;
    ruleIds = ["no_savings_passthrough"];
  }
  return buildResult(text, rawRef, raw, ruleIds, critical, changed, profile.name);
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
  if (!critical && isDenseSemanticListOutput(observation)) {
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

function compressLines(observation, rules, keepFirstN, keepLastN, maxLines, options = {}) {
  const keepPatterns = KEEP_PATTERNS.concat(rules.flatMap((rule) => rule.keep_patterns || []));
  const stripPatterns = STRIP_PATTERNS.concat(rules.flatMap((rule) => rule.strip_patterns || []));
  const settings = lineSettings(rules, keepFirstN, keepLastN, maxLines);
  const outputLines = outputLinesFromObservation(observation);
  const [lines, progressOmitted, progressMetrics, progressSamples] = dropProgressLines(outputLines);

  if (options.strongOnly) {
    const keptStrong = lines.filter((line) => !matchesAny(stripPatterns, line));
    return retainedBody(keptStrong, outputLines, progressOmitted, progressMetrics, progressSamples, "strong-rule noise lines", appliedRuleIds(rules, "strong_noise_strip"));
  }
  if (lines.length <= settings.maxLines) {
    const keptShort = lines.filter((line) => !matchesAny(stripPatterns, line));
    if (keptShort.length < outputLines.length) {
      return retainedBody(keptShort, outputLines, progressOmitted, progressMetrics, progressSamples, "low-signal lines", appliedRuleIds(rules, "progress_strip"));
    }
    return [foldRepeats(lines).join("\n") + "\n", ["ansi_strip", "repeat_fold"]];
  }

  const kept = [];
  lines.forEach((line, index) => {
    const reason = keepReason(index, line, lines.length, settings, keepPatterns, stripPatterns);
    if (reason) kept.push(`L${index + 1}: ${line}`);
  });
  return retainedBody(kept, outputLines, progressOmitted, progressMetrics, progressSamples, "low-signal lines", appliedRuleIds(rules, "static_keep_patterns"));
}

function compressCriticalLines(observation, keepFirstN, keepLastN, maxLines) {
  const outputLines = outputLinesFromObservation(observation);
  const [lines, progressOmitted, progressMetrics, progressSamples] = dropProgressLines(outputLines);
  const keptEntries = selectedCriticalEntries(lines, keepFirstN, keepLastN, maxLines);
  const retained = keptEntries.map(([index, reason]) => `L${index + 1} [${reason}]: ${lines[index]}`);
  const body = [
    `[compressed] retained ${keptEntries.length} of ${outputLines.length} output lines; omitted ${Math.max(0, outputLines.length - keptEntries.length)} low-signal lines.`,
    "[critical facts retained]",
    ...criticalFacts(lines),
    ...progressSummary(progressOmitted, progressMetrics, progressSamples),
    "[retained output]",
    ...foldRepeats(retained),
  ];
  return [body.join("\n").trimEnd() + "\n", ["ansi_strip", "critical_fact_keep", "head_tail", "repeat_fold"]];
}

function selectedCriticalEntries(lines, keepFirstN, keepLastN, maxLines) {
  const kept = new Map();
  const mark = (index, reason) => {
    if (index >= 0 && index < lines.length && !kept.has(index)) kept.set(index, reason);
  };
  lines.forEach((line, index) => {
    if (index < keepFirstN) mark(index, "head");
    if (index >= lines.length - keepLastN) mark(index, "tail");
    if (isCriticalLine(line) || isCriticalContextLine(line)) {
      for (let offset = -1; offset <= 1; offset += 1) mark(index + offset, offset === 0 ? "critical" : "critical_context");
    }
  });
  let entries = Array.from(kept.entries()).sort((a, b) => a[0] - b[0]);
  if (entries.length <= maxLines) return entries;
  const priority = new Set(["critical", "critical_context"]);
  const prioritized = entries.filter(([, reason]) => priority.has(reason));
  const remaining = entries.filter(([, reason]) => !priority.has(reason));
  return prioritized.concat(remaining).slice(0, maxLines).sort((a, b) => a[0] - b[0]);
}

function lineSettings(rules, keepFirstN, keepLastN, maxLines) {
  if (!rules.length) return { keepFirstN, keepLastN, maxLines };
  return {
    keepFirstN: Math.min(...rules.map((rule) => numberOr(rule.keep_first_n, keepFirstN))),
    keepLastN: Math.max(...rules.map((rule) => numberOr(rule.keep_last_n, keepLastN))),
    maxLines: Math.min(...rules.map((rule) => numberOr(rule.max_lines, maxLines))),
  };
}

function keepReason(index, line, lineCount, settings, keepPatterns, stripPatterns) {
  if (index < settings.keepFirstN) return "head";
  if (index >= lineCount - settings.keepLastN) return "tail";
  if (matchesAny(keepPatterns, line)) return "keep_pattern";
  if (matchesAny(stripPatterns, line)) return "";
  return "";
}

function retainedBody(lines, outputLines, progressOmitted, progressMetrics, progressSamples, omittedLabel, ruleIds) {
  const body = [
    `[compressed] retained ${lines.length} of ${outputLines.length} output lines; omitted ${Math.max(0, outputLines.length - lines.length)} ${omittedLabel}.`,
    ...progressSummary(progressOmitted, progressMetrics, progressSamples),
    "[retained output]",
    ...foldRepeats(lines),
  ];
  return [body.join("\n").trimEnd() + "\n", ruleIds];
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
