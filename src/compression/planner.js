"use strict";

const { KEEP_PATTERNS, STRIP_PATTERNS } = require("./patterns");
const { foldRepeats } = require("./format");
const { dropProgressLines, progressSummary } = require("./progress");
const { estimateTokens, matchesAny, numberOr } = require("./utils");

const DEFAULT_PLANNER = {
  highThreshold: 50,
  mediumThreshold: 10,
  minimumBudgetTokens: 800,
  budgetRatios: {
    low: 0.75,
    default: 0.5,
    high: 0.35,
    xhigh: 0.25,
  },
  medium: {
    keepFirstN: 8,
    keepLastN: 16,
    maxLines: 80,
    tightKeepFirstN: 4,
    tightKeepLastN: 8,
    tightMaxLines: 32,
  },
  low: {
    keepFirstN: 4,
    keepLastN: 8,
    maxLines: 40,
  },
};

function planCompression(scoredBlocks, options = {}) {
  const settings = normalizePlanner(options.config);
  const strength = String(options.strength || "default");
  const ratio = numberOr(settings.budgetRatios[strength], settings.budgetRatios.default);
  const targetTokens = Math.max(
    settings.minimumBudgetTokens,
    Math.ceil(numberOr(options.rawTokens, 0) * ratio)
  );
  const rules = Array.isArray(options.rules) ? options.rules : [];
  const candidates = scoredBlocks.map((scored, index) =>
    blockCandidate(scored, index, rules, settings)
  );

  let plannedTokens = 48 + candidates.reduce((sum, candidate) => sum + candidateCost(candidate), 0);
  for (const candidate of candidates) {
    if (plannedTokens <= targetTokens || candidate.tier !== "low" || !candidate.tighter) continue;
    plannedTokens -= candidateCost(candidate) - candidateCost(candidate, candidate.tighter);
    candidate.current = candidate.tighter;
  }
  for (const candidate of candidates) {
    if (plannedTokens <= targetTokens || candidate.tier !== "medium" || !candidate.tighter) continue;
    plannedTokens -= candidateCost(candidate) - candidateCost(candidate, candidate.tighter);
    candidate.current = candidate.tighter;
  }

  const rendered = candidates.map((candidate) => renderCandidate(candidate));
  const summary = (tokens) =>
    `[compression plan] blocks=${candidates.filter((candidate) => !candidate.separator).length}, ` +
      `high=${candidates.filter((candidate) => candidate.tier === "high").length}, ` +
      `medium=${candidates.filter((candidate) => candidate.tier === "medium").length}, ` +
      `low=${candidates.filter((candidate) => candidate.tier === "low" && !candidate.separator).length}, ` +
      `target_tokens=${targetTokens}, planned_tokens=${tokens}, ` +
      `budget_exceeded=${String(tokens > targetTokens)}.`;
  let body = [summary(plannedTokens), ...rendered].join("\n").trimEnd() + "\n";
  plannedTokens = estimateTokens(body);
  body = [summary(plannedTokens), ...rendered].join("\n").trimEnd() + "\n";
  plannedTokens = estimateTokens(body);
  const ruleIds = new Set(["ansi_strip", "block_splitter", "importance_scorer", "compression_planner"]);
  for (const candidate of candidates) {
    for (const ruleId of candidate.current.ruleIds) ruleIds.add(ruleId);
  }
  for (const rule of rules) {
    if (rule.rule_id) ruleIds.add(String(rule.rule_id));
  }
  return {
    body,
    targetTokens,
    plannedTokens,
    budgetExceeded: plannedTokens > targetTokens,
    ruleIds: Array.from(ruleIds),
    blocks: candidates.map((candidate) => ({
      startLine: candidate.block.startLine,
      endLine: candidate.block.endLine,
      score: candidate.score,
      tier: candidate.tier,
      reasons: candidate.reasons,
      mode: candidate.current.mode,
    })),
  };
}

function blockCandidate(scored, index, rules, settings) {
  const { block, score, reasons } = scored;
  if (block.separator) {
    const separator = variant("", "separator", []);
    return {
      index,
      block,
      score,
      reasons,
      tier: "low",
      separator: true,
      current: separator,
      tighter: null,
    };
  }
  const tier = score >= settings.highThreshold
    ? "high"
    : score >= settings.mediumThreshold
      ? "medium"
      : "low";
  if (tier === "high") {
    return {
      index,
      block,
      score,
      reasons,
      tier,
      separator: false,
      current: variant(block.lines.join("\n"), "lossless", ["importance_high_retain"]),
      tighter: null,
    };
  }
  if (tier === "medium") {
    return {
      index,
      block,
      score,
      reasons,
      tier,
      separator: false,
      current: mediumVariant(block.lines, rules, settings.medium, false),
      tighter: mediumVariant(block.lines, rules, settings.medium, true),
    };
  }
  return {
    index,
    block,
    score,
    reasons,
    tier,
    separator: false,
    current: lowVariant(block.lines, rules, settings.low),
    tighter: minimalVariant(block.lines),
  };
}

function mediumVariant(lines, rules, settings, tight) {
  const keepPatterns = KEEP_PATTERNS.concat(rules.flatMap((rule) => rule.keep_patterns || []));
  const stripPatterns = STRIP_PATTERNS.concat(rules.flatMap((rule) => rule.strip_patterns || []));
  const filtered = lines.filter((line) =>
    matchesAny(keepPatterns, line) || !matchesAny(stripPatterns, line)
  );
  const compacted = retainLines(filtered, {
    keepFirstN: tight ? settings.tightKeepFirstN : settings.keepFirstN,
    keepLastN: tight ? settings.tightKeepLastN : settings.keepLastN,
    maxLines: tight ? settings.tightMaxLines : settings.maxLines,
    keepPatterns,
  });
  return variant(
    foldRepeats(compacted.lines).join("\n"),
    tight ? "light-tight" : "light",
    ["importance_medium_retain", "repeat_fold", ...(compacted.omitted ? ["head_tail"] : [])]
  );
}

function lowVariant(lines, rules, settings) {
  const keepPatterns = KEEP_PATTERNS.concat(rules.flatMap((rule) => rule.keep_patterns || []));
  const stripPatterns = STRIP_PATTERNS.concat(rules.flatMap((rule) => rule.strip_patterns || []));
  const [withoutProgress, progressOmitted, progressMetrics, progressSamples] = dropProgressLines(lines);
  const filtered = withoutProgress.filter((line) =>
    matchesAny(keepPatterns, line) || !matchesAny(stripPatterns, line)
  );
  const compacted = retainLines(filtered, {
    keepFirstN: settings.keepFirstN,
    keepLastN: settings.keepLastN,
    maxLines: settings.maxLines,
    keepPatterns,
  });
  const output = [
    ...progressSummary(progressOmitted, progressMetrics, progressSamples),
    ...foldRepeats(compacted.lines),
  ];
  if (!output.length) output.push(`[omitted ${lines.length} low-importance noise lines]`);
  return variant(output.join("\n"), "strong", [
    "importance_low_compress",
    "progress_strip",
    "repeat_fold",
    ...(compacted.omitted ? ["head_tail"] : []),
  ]);
}

function minimalVariant(lines) {
  const nonEmpty = lines.filter((line) => line.trim());
  const retained = [];
  if (nonEmpty[0]) retained.push(nonEmpty[0]);
  if (nonEmpty.length > 1 && nonEmpty[nonEmpty.length - 1] !== nonEmpty[0]) {
    retained.push(nonEmpty[nonEmpty.length - 1]);
  }
  return variant([
    `[compressed low-importance block: retained ${retained.length} of ${lines.length} lines]`,
    ...retained,
  ].join("\n"), "minimal", ["importance_low_budget_fold"]);
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

function renderCandidate(candidate, selected = candidate.current) {
  if (candidate.separator) return "";
  const reasons = candidate.reasons.length
    ? candidate.reasons.map((reason) => `${reason.id}:${reason.score >= 0 ? "+" : ""}${reason.score}`).join(",")
    : "none";
  return [
    `[block ${candidate.index + 1} lines=${candidate.block.startLine}-${candidate.block.endLine} ` +
      `importance=${candidate.tier} score=${candidate.score} mode=${selected.mode} reasons=${reasons}]`,
    selected.text,
  ].join("\n");
}

function candidateCost(candidate, selected = candidate.current) {
  return estimateTokens(renderCandidate(candidate, selected));
}

function variant(text, mode, ruleIds) {
  return {
    text,
    mode,
    ruleIds,
    tokens: estimateTokens(text),
  };
}

function normalizePlanner(config = {}) {
  const budgetRatios = config.budget_ratios || config.budgetRatios || {};
  const medium = config.medium || {};
  const low = config.low || {};
  return {
    highThreshold: numberOr(config.high_threshold, numberOr(config.highThreshold, DEFAULT_PLANNER.highThreshold)),
    mediumThreshold: numberOr(config.medium_threshold, numberOr(config.mediumThreshold, DEFAULT_PLANNER.mediumThreshold)),
    minimumBudgetTokens: numberOr(
      config.minimum_budget_tokens,
      numberOr(config.minimumBudgetTokens, DEFAULT_PLANNER.minimumBudgetTokens)
    ),
    budgetRatios: {
      ...DEFAULT_PLANNER.budgetRatios,
      ...budgetRatios,
    },
    medium: {
      keepFirstN: numberOr(medium.keep_first_n, numberOr(medium.keepFirstN, DEFAULT_PLANNER.medium.keepFirstN)),
      keepLastN: numberOr(medium.keep_last_n, numberOr(medium.keepLastN, DEFAULT_PLANNER.medium.keepLastN)),
      maxLines: numberOr(medium.max_lines, numberOr(medium.maxLines, DEFAULT_PLANNER.medium.maxLines)),
      tightKeepFirstN: numberOr(
        medium.tight_keep_first_n,
        numberOr(medium.tightKeepFirstN, DEFAULT_PLANNER.medium.tightKeepFirstN)
      ),
      tightKeepLastN: numberOr(
        medium.tight_keep_last_n,
        numberOr(medium.tightKeepLastN, DEFAULT_PLANNER.medium.tightKeepLastN)
      ),
      tightMaxLines: numberOr(
        medium.tight_max_lines,
        numberOr(medium.tightMaxLines, DEFAULT_PLANNER.medium.tightMaxLines)
      ),
    },
    low: {
      keepFirstN: numberOr(low.keep_first_n, numberOr(low.keepFirstN, DEFAULT_PLANNER.low.keepFirstN)),
      keepLastN: numberOr(low.keep_last_n, numberOr(low.keepLastN, DEFAULT_PLANNER.low.keepLastN)),
      maxLines: numberOr(low.max_lines, numberOr(low.maxLines, DEFAULT_PLANNER.low.maxLines)),
    },
  };
}

module.exports = {
  DEFAULT_PLANNER,
  normalizePlanner,
  planCompression,
  retainLines,
};
