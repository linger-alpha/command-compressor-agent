"use strict";

const { CRITICAL_PATTERNS } = require("./patterns");
const { outputLinesFromObservation } = require("./format");
const { dropProgressLines, isProgressLine } = require("./progress");
const { matchesAny, shorten } = require("./utils");

function isVisualDiagnosticOutput(observation, raw, ruleSet = {}) {
  const command = observation.command || "";
  const outputLines = outputLinesFromObservation(observation);
  const output = outputLines.join("\n");
  const visualCommand = matchesAny([
    "\\b(chess|board|fen|image|pixel|pixels|PIL|pillow|opencv|cv2|ocr|screenshot|contour|silhouette)\\b",
    "\\.(png|jpg|jpeg|webp|gif|bmp)\\b",
    ...(ruleSet.visualCommandPatterns || []),
  ], command, "i");
  const visualText = matchesAny([
    "\\bbinary silhouette\\b",
    "\\bpiece shape\\b",
    "\\bultra-sensitive piece detection\\b",
    "\\boccupied square\\b",
    "\\bcontour\\b",
    "\\bpixel\\b",
    "\\bgrid\\b",
    "\\bchess\\b",
    "\\bFEN\\b",
    ...(ruleSet.visualOutputPatterns || []),
  ], raw, "i");
  const chessCoordinates = Array.from(output.matchAll(/\b[a-h][1-8]\b/g)).length;
  const chessPieces = Array.from(output.matchAll(/\b(king|queen|rook|bishop|knight|pawn|WHITE|BLACK)\b/gi)).length;
  const matrixLines = outputLines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length < 8 || trimmed.length > 160) return false;
    return /^[.#01XxOo@+\-*\s]+$/.test(trimmed);
  });
  return (visualCommand && visualText) || matrixLines.length >= 8 || (chessCoordinates >= 8 && chessPieces >= 4);
}

function isDenseSemanticListOutput(observation) {
  const outputLines = outputLinesFromObservation(observation);
  if (outputLines.length < 80) return false;
  const [lines, progressOmitted] = dropProgressLines(outputLines);
  if (progressOmitted > Math.max(4, Math.floor(outputLines.length * 0.05))) return false;
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length < 80) return false;
  const numbered = nonEmpty.filter((line) => /^\s*\d{1,6}\s*(?::|\.|\)|\t)\s*\S/.test(line));
  return numbered.length >= 40 && numbered.length / nonEmpty.length >= 0.5;
}

function hasStrongCompressionCandidate(observation, raw, selectedStrongRules) {
  if (selectedStrongRules.length) return true;
  const outputLines = outputLinesFromObservation(observation);
  if (outputLines.some((line) => isProgressLine(line))) return true;
  let previous = null;
  let count = 0;
  for (const line of outputLines) {
    if (line && line === previous) {
      count += 1;
      if (count >= 3) return true;
      continue;
    }
    previous = line;
    count = 1;
  }
  return matchesAny(["\\x1b\\[[0-9;?]*[ -/]*[@-~]"], raw);
}

function isCritical(observation, raw) {
  if (observation.exitCode != null && observation.exitCode !== 0) return true;
  return matchesAny(CRITICAL_PATTERNS, raw, "i");
}

function isCriticalLine(line) {
  return matchesAny(CRITICAL_PATTERNS, line, "i") || /\bFAIL(?:ED)?\b/i.test(line);
}

function isCriticalContextLine(line) {
  return matchesAny([
    "^\\s*expected\\s*:",
    "^\\s*got\\s*:",
    "^\\s*actual\\s*:",
    "^\\s*diff\\s*:",
    "^\\s*E\\s+",
    "^\\s*>\\s+",
    "^\\s*at\\s+",
    "^\\s*File\\s+\"[^\"]+\",\\s*line\\s+\\d+",
    "\\bline=|\\bcase=",
  ], line, "i");
}

function criticalFacts(lines) {
  const facts = [];
  let failCount = 0;
  let errorCount = 0;
  let passCount = 0;
  for (const line of lines) {
    if (/\bPASS(?:ED)?\b/i.test(line)) passCount += 1;
    if (/\bFAIL(?:ED)?\b/i.test(line)) failCount += 1;
    if (/\b(?:ERROR|Exception|Traceback|AssertionError|SyntaxError|TypeError)\b/i.test(line)) errorCount += 1;
  }
  facts.push(`fail_lines=${failCount}`);
  facts.push(`error_lines=${errorCount}`);
  if (passCount) facts.push(`pass_lines=${passCount}`);
  const firstCritical = lines.find((line) => isCriticalLine(line));
  if (firstCritical) facts.push(`first_critical=${shorten(firstCritical)}`);
  return facts;
}

module.exports = {
  criticalFacts,
  hasStrongCompressionCandidate,
  isCritical,
  isCriticalContextLine,
  isCriticalLine,
  isDenseSemanticListOutput,
  isVisualDiagnosticOutput,
};
