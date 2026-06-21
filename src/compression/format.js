"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { commandSummary, estimateTokens, redact, stripAnsi } = require("./utils");

function formatRaw(observation) {
  const parts = [
    `$ ${observation.command}`.trimEnd(),
    `[exit_code] ${observation.exitCode == null ? "unknown" : observation.exitCode}`,
  ];
  if (observation.stdout) parts.push("[stdout]", redact(stripAnsi(observation.stdout)).trimEnd());
  if (observation.stderr) parts.push("[stderr]", redact(stripAnsi(observation.stderr)).trimEnd());
  return parts.join("\n").trimEnd() + "\n";
}

function withHeader(observation, body, rawRef, status) {
  const header = [
    "[command-compressor]",
    `status: ${status}`,
    `command: ${commandSummary(observation.command)}`,
    `exit_code: ${observation.exitCode == null ? "unknown" : observation.exitCode}`,
  ];
  if (rawRef) {
    header.push(`raw_ref: ${rawRef}`);
    header.push("fallback: use raw_ref only if a required fact is missing from retained output; do not read it for routine confirmation");
  }
  return `${header.join("\n")}\n\n${body.trimEnd()}\n`;
}

function writeRaw(raw, rawDir) {
  fs.mkdirSync(rawDir, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const digest = crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  const rawRef = path.join(rawDir, `${stamp}-${digest}.log`);
  fs.writeFileSync(rawRef, raw, "utf8");
  return rawRef;
}

function outputLinesFromObservation(observation) {
  const lines = [];
  if (observation.stdout) lines.push(...redact(stripAnsi(observation.stdout)).trimEnd().split(/\r?\n/));
  if (observation.stderr) {
    if (lines.length) lines.push("[stderr]");
    lines.push(...redact(stripAnsi(observation.stderr)).trimEnd().split(/\r?\n/));
  }
  return lines.filter((line, index, all) => line !== "" || index < all.length - 1);
}

function foldRepeats(lines) {
  const folded = [];
  let previous = null;
  let count = 0;
  for (const line of lines) {
    if (line === previous) {
      count += 1;
      continue;
    }
    appendFolded(folded, previous, count);
    previous = line;
    count = 1;
  }
  appendFolded(folded, previous, count);
  return folded;
}

function appendFolded(folded, line, count) {
  if (line == null) return;
  if (count >= 3) folded.push(`${line}  [repeated ${count}x]`);
  else for (let i = 0; i < count; i += 1) folded.push(line);
}

function appliedRuleIds(rules, fallback) {
  return ["ansi_strip", fallback, "repeat_fold", ...rules.map((rule) => String(rule.rule_id || ""))].filter(Boolean);
}

function buildResult(text, rawRef, raw, ruleIds, critical, changed, strength = "default") {
  return {
    text,
    rawRef,
    rawTokensEst: estimateTokens(raw),
    compressedTokensEst: estimateTokens(text),
    rawChars: raw.length,
    compressedChars: text.length,
    ruleIds,
    critical,
    changed,
    strength,
  };
}

module.exports = {
  appliedRuleIds,
  buildResult,
  foldRepeats,
  formatRaw,
  outputLinesFromObservation,
  withHeader,
  writeRaw,
};
