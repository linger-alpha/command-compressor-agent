"use strict";

const { repetitionSignature } = require("./splitter");

const TIER_ORDER = {
  aggressive: 0,
  light: 1,
  preserve: 2,
};

const DEFAULT_SIGNALS = [
  {
    id: "opaque_encoded",
    kind: "opaque_encoded",
    tier: "preserve",
  },
  {
    id: "dense_semantic",
    kind: "dense_semantic",
    tier: "preserve",
  },
  {
    id: "visual_structure",
    kind: "visual",
    tier: "preserve",
  },
  {
    id: "traceback_exception",
    pattern: "(?:\\bTraceback\\b|\\b(?:Exception|[A-Za-z_][A-Za-z0-9_]*Exception)\\b)",
    flags: "i",
    tier: "preserve",
  },
  {
    id: "error_failure",
    pattern: "(?:\\b(?:ERROR|FATAL|FAILED)\\b|\\b(?:error|fatal|failed)\\s*:|\\b\\d+\\s+failed\\b|\\bFailed to\\b|\\b[A-Za-z_][A-Za-z0-9_]*(?:Error|Failure)\\b)",
    flags: "",
    tier: "preserve",
  },
  {
    id: "critical_runtime_failure",
    pattern: "(?:\\btimed?\\s+out\\b|\\bTimeout(?:Error|Exception)\\b|\\b(?:command|connection|operation|request|test)\\b[^\\n]{0,80}\\btimeout\\b|\\bsegmentation fault\\b|\\bpanic\\b|\\bOOM\\b|\\bundefined reference\\b|\\bNo such file or directory\\b|\\bPermission denied\\b|\\bnpm ERR!|\\bCommand failed\\b)",
    flags: "i",
    tier: "preserve",
  },
  {
    id: "file_line",
    pattern: "(?:\\bFile\\s+\"[^\"]+\",\\s*line\\s+\\d+|(?:^|\\s)(?:(?:[^\\s:]*[/\\\\][^\\s:]+)|(?:[A-Za-z0-9_.-]+\\.[A-Za-z0-9]{1,8})):\\d+(?::\\d+)?)",
    flags: "i",
    tier: "light",
  },
  {
    id: "warning",
    pattern: "\\b(?:warning|warn)\\b",
    flags: "i",
    tier: "light",
  },
  {
    id: "progress_download",
    kind: "progress",
    tier: "aggressive",
  },
  {
    id: "duplicate",
    kind: "duplicate",
    tier: "aggressive",
  },
];

function scoreBlock(block, config = {}) {
  if (block.separator) {
    return {
      block,
      tier: "aggressive",
      score: 0,
      reasons: [],
    };
  }
  const text = block.lines.join("\n");
  const reasons = [];
  let matchedTier = null;
  const signals = normalizeSignals(config.signals);
  for (const signal of signals) {
    if (!signalMatches(signal, block, text, config)) continue;
    reasons.push({ id: signal.id, tier: signal.tier });
    if (matchedTier == null || TIER_ORDER[signal.tier] > TIER_ORDER[matchedTier]) {
      matchedTier = signal.tier;
    }
  }
  const tier = matchedTier || normalizeTier(config.default_tier || config.defaultTier || "light");
  return {
    block,
    tier,
    score: tierScore(tier),
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
      tier: signalTier(signal),
      pattern: signal.pattern == null ? "" : String(signal.pattern),
      flags: String(signal.flags == null ? "i" : signal.flags).replace(/g/g, ""),
      kind: signal.kind ? String(signal.kind) : "",
    }));
}

function signalTier(signal) {
  if (signal.tier) return normalizeTier(signal.tier);
  const legacyScore = Number(signal.score);
  if (legacyScore >= 50) return "preserve";
  if (legacyScore >= 0) return "light";
  return "aggressive";
}

function normalizeTier(value) {
  const tier = String(value || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIER_ORDER, tier) ? tier : "light";
}

function tierScore(tier) {
  if (tier === "preserve") return 100;
  if (tier === "light") return 50;
  return 0;
}

function signalMatches(signal, block, text, config) {
  if (signal.kind === "duplicate") return hasDuplicatePattern(block.lines);
  if (signal.kind === "progress") return hasProgressPattern(block.lines);
  if (signal.kind === "opaque_encoded") return isOpaqueEncodedBlock(block.lines, config.opaque_encoded);
  if (signal.kind === "dense_semantic") return isDenseSemanticBlock(block.lines, config.dense_semantic);
  if (signal.kind === "visual") return isVisualStructureBlock(block.lines, config.visual);
  return safeTest(signal.pattern, text, signal.flags);
}

function hasDuplicatePattern(lines) {
  const counts = new Map();
  for (const line of lines) {
    const exact = String(line).trim();
    if (!exact) continue;
    const count = (counts.get(exact) || 0) + 1;
    counts.set(exact, count);
    if (count >= 3) return true;
  }
  return false;
}

function hasProgressPattern(lines) {
  let matches = 0;
  for (const line of lines) {
    if (
      /\d{1,3}%\|/.test(line) ||
      /\b(?:Downloading|Extracting|Processing|Uploading|Receiving|Resolving)\b/i.test(line) ||
      /\b(?:ETA|elapsed|remaining|it\/s|s\/it|B\/s|MB\/s|GB\/s)\b/i.test(line)
    ) {
      matches += 1;
      if (matches >= Math.min(3, Math.max(1, lines.length))) return true;
    }
  }
  return false;
}

function isOpaqueEncodedBlock(lines, config = {}) {
  const minimumEncodedChars = finitePositive(config && config.minimum_encoded_chars, 256);
  const minimumEncodedLines = finitePositive(config && config.minimum_encoded_lines, 2);
  let encodedChars = 0;
  let encodedLines = 0;
  let hexLines = 0;
  for (const value of lines) {
    const line = String(value);
    const trimmed = line.trim();
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(line)) return true;
    if (/^-----BEGIN [A-Z0-9 ][A-Z0-9 -]*-----$/.test(trimmed)) return true;
    if (/^data:[^,\s]{1,200};base64,[A-Za-z0-9+/=]{128,}$/.test(trimmed)) return true;
    if (/^(?:[A-Za-z0-9+/]{4}){16,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(trimmed)) {
      encodedLines += 1;
      encodedChars += trimmed.length;
      if (trimmed.length >= minimumEncodedChars) return true;
    }
    if (/^\s*(?:[0-9a-f]{4,16}:?\s+)(?:[0-9a-f]{2}(?:\s+|$)){8,}/i.test(line)) {
      hexLines += 1;
    }
  }
  return (
    encodedLines >= minimumEncodedLines &&
    encodedChars >= minimumEncodedChars
  ) || hexLines >= 2;
}

function isDenseSemanticBlock(lines, config = {}) {
  const minimumLines = finitePositive(config && config.minimum_lines, 80);
  const minimumNumbered = finitePositive(config && config.minimum_numbered_lines, 40);
  const minimumRatio = finiteRatio(config && config.minimum_numbered_ratio, 0.5);
  const nonEmpty = lines.filter((line) => String(line).trim());
  if (nonEmpty.length < minimumLines) return false;
  const progressLines = nonEmpty.filter((line) => hasProgressPattern([line]));
  if (progressLines.length > Math.max(4, Math.floor(nonEmpty.length * 0.05))) return false;
  const numbered = nonEmpty.filter((line) => /^\s*\d{1,6}\s*(?::|\.|\)|\t)\s*\S/.test(line));
  if (numbered.length >= minimumNumbered && numbered.length / nonEmpty.length >= minimumRatio) return true;
  const uniqueRatio = new Set(nonEmpty.map((line) => String(line).trim())).size / nonEmpty.length;
  if (uniqueRatio < 0.8) return false;
  const signatures = new Map();
  for (const line of nonEmpty) {
    const signature = repetitionSignature(line);
    signatures.set(signature, (signatures.get(signature) || 0) + 1);
  }
  const largestStructure = Math.max(0, ...signatures.values());
  return largestStructure / nonEmpty.length >= minimumRatio;
}

function isVisualStructureBlock(lines, config = {}) {
  const minimumMatrixLines = finitePositive(config && config.minimum_matrix_lines, 8);
  let matrixLines = 0;
  for (const value of lines) {
    const trimmed = String(value).trim();
    if (trimmed.length < 8 || trimmed.length > 200) continue;
    if (/^[.#01XxOo@+\-*\s]+$/.test(trimmed)) {
      matrixLines += 1;
      if (matrixLines >= minimumMatrixLines) return true;
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

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : fallback;
}

module.exports = {
  hasDuplicatePattern,
  hasProgressPattern,
  isDenseSemanticBlock,
  isOpaqueEncodedBlock,
  isVisualStructureBlock,
  scoreBlock,
  scoreBlocks,
};
