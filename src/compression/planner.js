"use strict";

const { KEEP_PATTERNS, STRIP_PATTERNS } = require("./patterns");
const { foldRepeats } = require("./format");
const { dropProgressLines, progressSummary } = require("./progress");
const { estimateTokens, matchesAny, numberOr } = require("./utils");

const DEFAULT_PLANNER = {
  light: {
    keepFirstN: 12,
    keepLastN: 24,
    maxLines: 120,
  },
  aggressive: {
    keepFirstN: 4,
    keepLastN: 8,
    maxLines: 40,
  },
};

function planCompression(scoredBlocks, options = {}) {
  const settings = normalizePlanner(options.config);
  const rules = Array.isArray(options.rules) ? options.rules : [];
  const groups = coalesceScoredBlocks(scoredBlocks, settings.mergeAdjacentLowValue);
  const candidates = groups.map((scored) => blockCandidate(scored, rules, settings));
  const body = candidates.map((candidate) => candidate.text).join("\n").trimEnd() + "\n";
  const ruleIds = new Set(["ansi_strip", "block_splitter", "importance_scorer", "compression_planner"]);
  if (groups.some((scored) => scored.mergedLowValue)) {
    ruleIds.add("adjacent_low_value_merge");
  }
  for (const candidate of candidates) {
    for (const ruleId of candidate.ruleIds) ruleIds.add(ruleId);
  }
  for (const rule of rules) {
    if (rule.rule_id) ruleIds.add(String(rule.rule_id));
  }
  return {
    body,
    plannedTokens: estimateTokens(body),
    ruleIds: Array.from(ruleIds),
    blocks: candidates.filter((candidate) => !candidate.block.separator).map((candidate) => ({
      startLine: candidate.block.startLine,
      endLine: candidate.block.endLine,
      tier: candidate.tier,
      reasons: candidate.reasons,
      mode: candidate.mode,
    })),
  };
}

function coalesceScoredBlocks(scoredBlocks, mergeConfig = {}) {
  const mergeSettings = normalizeMergeSettings(mergeConfig);
  const output = [];
  let pendingSeparators = [];
  for (const scored of scoredBlocks) {
    if (!scored || !scored.block) continue;
    if (scored.block.separator) {
      pendingSeparators.push(scored);
      continue;
    }
    const previous = output[output.length - 1];
    if (
      pendingSeparators.length &&
      canMergeLowValue(previous, scored, pendingSeparators, mergeSettings)
    ) {
      mergeScoredBlock(previous, scored, pendingSeparators, true);
      pendingSeparators = [];
      continue;
    }
    output.push(...pendingSeparators);
    pendingSeparators = [];
    const adjacent = output[output.length - 1];
    if (
      adjacent &&
      !adjacent.block.separator &&
      adjacent.tier === scored.tier &&
      adjacent.block.kind === scored.block.kind
    ) {
      mergeScoredBlock(adjacent, scored);
      continue;
    }
    if (canMergeLowValue(adjacent, scored, [], mergeSettings)) {
      mergeScoredBlock(adjacent, scored, [], true);
      continue;
    }
    output.push(cloneScoredBlock(scored));
  }
  output.push(...pendingSeparators);
  return output;
}

function canMergeLowValue(previous, current, separators, settings) {
  if (!settings.enabled || !previous || previous.block.separator) return false;
  if (previous.tier !== current.tier || !settings.tiers.has(current.tier)) return false;
  const separatorLines = separators.reduce(
    (total, scored) => total + scored.block.lines.length,
    0
  );
  return separatorLines <= settings.maxSeparatorLines;
}

function mergeScoredBlock(target, source, separators = [], lowValue = false) {
  target.block.endLine = source.block.endLine;
  for (const separator of separators) target.block.lines.push(...separator.block.lines);
  target.block.lines.push(...source.block.lines);
  if (target.block.kind !== source.block.kind) target.block.kind = "mixed";
  target.reasons = mergeReasons(target.reasons, source.reasons);
  if (lowValue) target.mergedLowValue = true;
}

function cloneScoredBlock(scored) {
  return {
    ...scored,
    block: {
      ...scored.block,
      lines: scored.block.lines.slice(),
    },
    reasons: Array.isArray(scored.reasons) ? scored.reasons.slice() : [],
  };
}

function mergeReasons(left = [], right = []) {
  const seen = new Set();
  const output = [];
  for (const reason of left.concat(right)) {
    const key = `${reason.id}:${reason.tier || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reason);
  }
  return output;
}

function blockCandidate(scored, rules, settings) {
  const { block } = scored;
  const tier = scored.tier || "light";
  const reasons = Array.isArray(scored.reasons) ? scored.reasons : [];
  if (block.separator) {
    return candidate(block, tier, reasons, "", "separator", []);
  }
  if (tier === "preserve") {
    return candidate(
      block,
      tier,
      reasons,
      block.lines.join("\n"),
      "lossless",
      ["importance_preserve"]
    );
  }
  if (tier === "aggressive") {
    const variant = aggressiveVariant(block.lines, rules, settings.aggressive);
    return candidate(block, tier, reasons, variant.text, variant.mode, variant.ruleIds);
  }
  const variant = lightVariant(block.lines, rules, settings.light);
  return candidate(block, "light", reasons, variant.text, variant.mode, variant.ruleIds);
}

function candidate(block, tier, reasons, text, mode, ruleIds) {
  return {
    block,
    tier,
    reasons,
    text,
    mode,
    ruleIds,
  };
}

function lightVariant(lines, rules, settings) {
  const keepPatterns = KEEP_PATTERNS.concat(rules.flatMap((rule) => rule.keep_patterns || []));
  const stripPatterns = STRIP_PATTERNS.concat(rules.flatMap((rule) => rule.strip_patterns || []));
  const lineSettings = settingsForRules(settings, rules);
  const filtered = lines.filter((line) =>
    matchesAny(keepPatterns, line) || !matchesAny(stripPatterns, line)
  );
  const compacted = retainLines(filtered, {
    ...lineSettings,
    keepPatterns,
  });
  return variant(
    foldRepeats(compacted.lines).join("\n"),
    "light",
    ["importance_light_compress", "repeat_fold", ...(compacted.omitted ? ["head_tail"] : [])]
  );
}

function aggressiveVariant(lines, rules, settings) {
  const keepPatterns = KEEP_PATTERNS.concat(rules.flatMap((rule) => rule.keep_patterns || []));
  const stripPatterns = STRIP_PATTERNS.concat(rules.flatMap((rule) => rule.strip_patterns || []));
  const [withoutProgress, progressOmitted, progressMetrics, progressSamples] = dropProgressLines(lines);
  const filtered = withoutProgress.filter((line) =>
    matchesAny(keepPatterns, line) || !matchesAny(stripPatterns, line)
  );
  const compacted = retainLines(filtered, {
    ...settings,
    keepPatterns,
  });
  const output = [
    ...progressSummary(progressOmitted, progressMetrics, progressSamples),
    ...foldRepeats(compacted.lines),
  ];
  if (!output.length) output.push(`[omitted ${lines.length} repetitive/noise lines]`);
  return variant(output.join("\n"), "aggressive", [
    "importance_aggressive_compress",
    "progress_strip",
    "repeat_fold",
    ...(compacted.omitted ? ["head_tail"] : []),
  ]);
}

function settingsForRules(settings, rules) {
  if (!rules.length) return settings;
  return {
    keepFirstN: Math.min(
      settings.keepFirstN,
      ...rules.map((rule) => numberOr(rule.keep_first_n, settings.keepFirstN))
    ),
    keepLastN: Math.max(
      settings.keepLastN,
      ...rules.map((rule) => numberOr(rule.keep_last_n, settings.keepLastN))
    ),
    maxLines: Math.min(
      settings.maxLines,
      ...rules.map((rule) => numberOr(rule.max_lines, settings.maxLines))
    ),
  };
}

function retainLines(lines, settings) {
  if (lines.length <= settings.maxLines) return { lines, omitted: 0 };
  const kept = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (
      index < settings.keepFirstN ||
      index >= lines.length - settings.keepLastN ||
      matchesAny(settings.keepPatterns, lines[index])
    ) {
      kept.add(index);
    }
  }
  const indices = Array.from(kept).sort((a, b) => a - b);
  const output = [];
  let previous = -1;
  let omitted = 0;
  for (const index of indices) {
    if (index > previous + 1) {
      const gap = index - previous - 1;
      omitted += gap;
      output.push(`[... omitted ${gap} lines ...]`);
    }
    output.push(lines[index]);
    previous = index;
  }
  if (previous < lines.length - 1) {
    const gap = lines.length - previous - 1;
    omitted += gap;
    output.push(`[... omitted ${gap} lines ...]`);
  }
  return { lines: output, omitted };
}

function variant(text, mode, ruleIds) {
  return {
    text,
    mode,
    ruleIds,
  };
}

function normalizePlanner(config = {}) {
  const light = config.light || config.medium || {};
  const aggressive = config.aggressive || config.low || {};
  return {
    light: normalizeStrategy(light, DEFAULT_PLANNER.light),
    aggressive: normalizeStrategy(aggressive, DEFAULT_PLANNER.aggressive),
    mergeAdjacentLowValue: normalizeMergeSettings(
      config.merge_adjacent_low_value || config.mergeAdjacentLowValue
    ),
  };
}

function normalizeMergeSettings(config = {}) {
  const configuredTiers = config.tiers instanceof Set
    ? Array.from(config.tiers)
    : Array.isArray(config.tiers)
      ? config.tiers
      : ["light"];
  const tiers = configuredTiers.filter(
    (tier) => tier === "light" || tier === "aggressive"
  );
  return {
    enabled: config.enabled === true,
    maxSeparatorLines: Math.max(
      0,
      Math.min(8, Math.floor(numberOr(
        config.max_separator_lines,
        numberOr(config.maxSeparatorLines, 1)
      )))
    ),
    tiers: new Set(tiers),
  };
}

function normalizeStrategy(config, fallback) {
  return {
    keepFirstN: numberOr(config.keep_first_n, numberOr(config.keepFirstN, fallback.keepFirstN)),
    keepLastN: numberOr(config.keep_last_n, numberOr(config.keepLastN, fallback.keepLastN)),
    maxLines: numberOr(config.max_lines, numberOr(config.maxLines, fallback.maxLines)),
  };
}

module.exports = {
  planCompression,
};
