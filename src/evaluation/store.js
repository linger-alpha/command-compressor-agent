"use strict";

const fs = require("fs");
const path = require("path");

const { commandSummary } = require("../compression/utils");

function recordCompressionEvent(config, observation, result) {
  if (!config || !config.metricsPath || !result) return;
  const event = {
    ts: new Date().toISOString(),
    agent: observation.agent || "claude-code",
    tool: observation.toolName || "Bash",
    command: commandSummary(observation.command || ""),
    strength: result.strength || config.strength || "default",
    raw_tokens_est: result.rawTokensEst || 0,
    compressed_tokens_est: result.changed ? result.compressedTokensEst || 0 : result.rawTokensEst || 0,
    saved_tokens_est: result.changed ? Math.max(0, (result.rawTokensEst || 0) - (result.compressedTokensEst || 0)) : 0,
    changed: Boolean(result.changed),
    critical: Boolean(result.critical),
    rules: Array.isArray(result.ruleIds) ? result.ruleIds : [],
    raw_ref: result.rawRef || "",
  };
  fs.mkdirSync(path.dirname(config.metricsPath), { recursive: true });
  fs.appendFileSync(config.metricsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function readGain(config) {
  const empty = {
    observations: 0,
    compressed_observations: 0,
    raw_tokens_est: 0,
    effective_tokens_est: 0,
    saved_tokens_est: 0,
    by_strength: {},
    by_rule: {},
  };
  if (!config || !config.metricsPath || !fs.existsSync(config.metricsPath)) return empty;
  const lines = fs.readFileSync(config.metricsPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    empty.observations += 1;
    if (event.changed) empty.compressed_observations += 1;
    empty.raw_tokens_est += Number(event.raw_tokens_est) || 0;
    empty.effective_tokens_est += Number(event.compressed_tokens_est) || 0;
    empty.saved_tokens_est += Number(event.saved_tokens_est) || 0;
    const strength = String(event.strength || "default");
    empty.by_strength[strength] = (empty.by_strength[strength] || 0) + 1;
    for (const rule of Array.isArray(event.rules) ? event.rules : []) {
      empty.by_rule[rule] = (empty.by_rule[rule] || 0) + 1;
    }
  }
  return empty;
}

function resetGain(config) {
  if (config && config.metricsPath && fs.existsSync(config.metricsPath)) fs.unlinkSync(config.metricsPath);
}

module.exports = {
  readGain,
  recordCompressionEvent,
  resetGain,
};
