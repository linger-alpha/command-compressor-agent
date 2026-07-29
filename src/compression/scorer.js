"use strict";

const { repetitionSignature } = require("./splitter");

const DEFAULT_SIGNALS = [
  {
    id: "exception_traceback",
    score: 80,
    pattern: "\\b(?:Exception|Traceback)\\b",
    flags: "i",
  },
  {
    id: "error_fatal_failed",
    score: 50,
    pattern: "(?:\\b(?:ERROR|fatal|FAILED)\\b|\\b[A-Za-z_][A-Za-z0-9_]*(?:Error|Failure)\\b)",
    flags: "i",
  },
  {
    id: "file_line",
    score: 20,
    pattern: "(?:\\bFile\\s+\"[^\"]+\",\\s*line\\s+\\d+|(?:^|\\s)[^\\s:]+:\\d+(?::\\d+)?)",
    flags: "i",
  },
  {
    id: "warning",
    score: 10,
    pattern: "\\b(?:warning|warn)\\b",
    flags: "i",
  },
  {
    id: "progress_download",
    score: -20,
    pattern: "(?:\\b(?:progress|download(?:ing|ed)?|upload(?:ing|ed)?|extracting|receiving|resolving)\\b|\\d{1,3}%\\|)",
    flags: "i",
  },
  {
    id: "duplicate",
    score: -30,
    kind: "duplicate",
  },
];

function scoreBlock(block, config = {}) {
  const text = block.lines.join("\n");
  const reasons = [];
  let score = 0;
  const signals = normalizeSignals(config.signals);
  for (const signal of signals) {
    const matched = signal.kind === "duplicate"
      ? hasDuplicatePattern(block.lines)
      : safeTest(signal.pattern, text, signal.flags);
    if (!matched) continue;
    score += signal.score;
    reasons.push({ id: signal.id, score: signal.score });
  }
  const minimum = finiteNumber(config.min_score, config.minScore, -100);
  const maximum = finiteNumber(config.max_score, config.maxScore, 100);
  return {
    block,
    score: Math.max(minimum, Math.min(maximum, score)),
    reasons,
  };
}

function scoreBlocks(blocks, config = {}) {
  return blocks.map((block) => scoreBlock(block, config));
}

function normalizeSignals(value) {
  const signals = Array.isArray(value) && value.length ? value : DEFAULT_SIGNALS;
  return signals
    .filter((signal) => signal && typeof signal === "object")
    .map((signal, index) => ({
      id: String(signal.id || `signal_${index + 1}`),
      score: finiteNumber(signal.score, 0),
      pattern: signal.pattern == null ? "" : String(signal.pattern),
      flags: String(signal.flags || "i").replace(/g/g, ""),
      kind: signal.kind ? String(signal.kind) : "",
    }));
}

function hasDuplicatePattern(lines) {
  const counts = new Map();
  let previous = null;
  let run = 0;
  for (const line of lines) {
    if (!String(line).trim()) continue;
    const signature = repetitionSignature(line);
    const count = (counts.get(signature) || 0) + 1;
    counts.set(signature, count);
    if (count >= 3) return true;
    if (signature === previous) {
      run += 1;
      if (run >= 3) return true;
    } else {
      previous = signature;
      run = 1;
    }
  }
  return false;
}

function safeTest(pattern, text, flags) {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false;
  }
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

module.exports = {
  DEFAULT_SIGNALS,
  hasDuplicatePattern,
  scoreBlock,
  scoreBlocks,
};
