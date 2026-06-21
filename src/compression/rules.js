"use strict";

const fs = require("fs");
const path = require("path");

const { numberOr, regexTest } = require("./utils");

function loadRuleSet(configuredPath) {
  const rulePath = configuredPath || process.env.COMMAND_COMPRESSOR_RULES || defaultRulePath();
  try {
    const data = JSON.parse(fs.readFileSync(rulePath, "utf8"));
    const legacyRules = Array.isArray(data.rules) ? data.rules : [];
    const strongRules = normalizeRules(data.strong_rules || data.strongRules || legacyRules.filter((rule) => rule.strength === "strong"));
    const weakRules = normalizeRules(data.weak_rules || data.weakRules || legacyRules.filter((rule) => rule.strength !== "strong"));
    const visual = data.visual_diagnostic_passthrough || {};
    return {
      whitelist: []
        .concat(Array.isArray(data.whitelist) ? data.whitelist : [])
        .concat(Array.isArray(data.rtk_whitelist) ? data.rtk_whitelist : []),
      visualCommandPatterns: Array.isArray(visual.command_patterns) ? visual.command_patterns : [],
      visualOutputPatterns: Array.isArray(visual.output_patterns) ? visual.output_patterns : [],
      strongRules,
      weakRules,
    };
  } catch {
    return { whitelist: [], visualCommandPatterns: [], visualOutputPatterns: [], strongRules: [], weakRules: [] };
  }
}

function normalizeRules(rules) {
  const enabled = Array.isArray(rules) ? rules.filter((rule) => rule && rule.enabled !== false) : [];
  enabled.sort((a, b) => numberOr(b.priority, 50) - numberOr(a.priority, 50));
  return enabled;
}

function defaultRulePath() {
  const root = path.resolve(__dirname, "..");
  const releaseRules = path.join(root, "..", "rules", "default-rules.json");
  if (fs.existsSync(releaseRules)) return releaseRules;
  return path.join(root, "rules", "default-rules.json");
}

function selectRules(rules, command, output) {
  return rules.filter((rule) => {
    const trigger = String(rule.trigger_regex || "");
    const out = String(rule.output_regex || "");
    const commandMatch = trigger && regexTest(trigger, command);
    const outputMatch = out && regexTest(out, output, "m");
    return trigger && out ? commandMatch && outputMatch : commandMatch || outputMatch;
  });
}

module.exports = {
  loadRuleSet,
  selectRules,
};
