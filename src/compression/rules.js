"use strict";

const fs = require("fs");
const path = require("path");

const { numberOr, regexTest } = require("./utils");

function loadRuleSet(configuredPath) {
  const rulePath = configuredPath || process.env.COMMAND_COMPRESSOR_RULES || defaultRulePath();
  const bundled = readRules(defaultRulePath()) || {};
  const data = readRules(rulePath) || bundled;
  const legacyRules = Array.isArray(data.rules) ? data.rules : [];
  const strongRules = normalizeRules(data.strong_rules || data.strongRules || legacyRules.filter((rule) => rule.strength === "strong"));
  const weakRules = normalizeRules(data.weak_rules || data.weakRules || legacyRules.filter((rule) => rule.strength !== "strong"));
  const visual = data.visual_diagnostic_passthrough || {};
  return {
    version: numberOr(data.version, 1),
    whitelist: []
      .concat(Array.isArray(data.whitelist) ? data.whitelist : [])
      .concat(Array.isArray(data.rtk_whitelist) ? data.rtk_whitelist : []),
    visualCommandPatterns: Array.isArray(visual.command_patterns) ? visual.command_patterns : [],
    visualOutputPatterns: Array.isArray(visual.output_patterns) ? visual.output_patterns : [],
    strongRules,
    weakRules,
    splitter: mergeSection(bundled.splitter, data.splitter),
    importance: mergeSection(bundled.importance, data.importance),
    planner: mergePlanner(bundled.planner, data.planner),
  };
}

function readRules(pathname) {
  try {
    const value = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function mergeSection(fallback, configured) {
  const base = fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback : {};
  const next = configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {};
  return { ...base, ...next };
}

function mergePlanner(fallback, configured) {
  const merged = mergeSection(fallback, configured);
  const fallbackObject = fallback && typeof fallback === "object" ? fallback : {};
  const configuredObject = configured && typeof configured === "object" ? configured : {};
  merged.budget_ratios = {
    ...(fallbackObject.budget_ratios || {}),
    ...(configuredObject.budget_ratios || {}),
  };
  merged.medium = {
    ...(fallbackObject.medium || {}),
    ...(configuredObject.medium || {}),
  };
  merged.low = {
    ...(fallbackObject.low || {}),
    ...(configuredObject.low || {}),
  };
  return merged;
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
  defaultRulePath,
  loadRuleSet,
  selectRules,
};
