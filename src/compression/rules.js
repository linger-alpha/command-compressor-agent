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
  const legacyWhitelist = []
    .concat(Array.isArray(data.whitelist) ? data.whitelist : [])
    .concat(Array.isArray(data.rtk_whitelist) ? data.rtk_whitelist : []);
  const commandPolicy = mergeCommandPolicy(
    bundled.command_policy || bundled.commandPolicy,
    data.command_policy || data.commandPolicy,
    legacyWhitelist
  );
  const blockPolicy = mergeSection(
    bundled.block_policy || bundled.blockPolicy || bundled.importance,
    data.block_policy || data.blockPolicy || data.importance
  );
  return {
    version: numberOr(data.version, 1),
    whitelist: legacyWhitelist,
    commandPolicy,
    visualCommandPatterns: Array.isArray(visual.command_patterns) ? visual.command_patterns : [],
    visualOutputPatterns: Array.isArray(visual.output_patterns) ? visual.output_patterns : [],
    strongRules,
    weakRules,
    splitter: mergeSection(bundled.splitter, data.splitter),
    blockPolicy,
    importance: blockPolicy,
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
  merged.light = {
    ...(fallbackObject.light || fallbackObject.medium || {}),
    ...(configuredObject.light || configuredObject.medium || {}),
  };
  merged.aggressive = {
    ...(fallbackObject.aggressive || fallbackObject.low || {}),
    ...(configuredObject.aggressive || configuredObject.low || {}),
  };
  return merged;
}

function mergeCommandPolicy(fallback, configured, legacyWhitelist) {
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const next = configured && typeof configured === "object" ? configured : {};
  return {
    ...base,
    ...next,
    rtk_patterns: uniquePatterns([]
      .concat(Array.isArray(base.rtk_patterns) ? base.rtk_patterns : [])
      .concat(Array.isArray(next.rtk_patterns) ? next.rtk_patterns : [])),
    read_only_patterns: uniquePatterns([]
      .concat(Array.isArray(base.read_only_patterns) ? base.read_only_patterns : [])
      .concat(Array.isArray(next.read_only_patterns) ? next.read_only_patterns : [])),
    compatibility_patterns: uniquePatterns([]
      .concat(Array.isArray(base.compatibility_patterns) ? base.compatibility_patterns : [])
      .concat(Array.isArray(next.compatibility_patterns) ? next.compatibility_patterns : [])
      .concat(legacyWhitelist)),
  };
}

function uniquePatterns(patterns) {
  return Array.from(new Set(patterns.map(String).filter(Boolean)));
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
