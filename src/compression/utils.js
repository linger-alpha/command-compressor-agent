"use strict";

const crypto = require("crypto");

const {
  ANSI_RE,
  LONG_COMMAND_HEAD,
  LONG_COMMAND_LIMIT,
  REDACTION_PATTERNS,
} = require("./patterns");

function commandSummary(command) {
  const oneLine = command.split(/\s+/).filter(Boolean).join(" ");
  if (oneLine.length <= LONG_COMMAND_LIMIT) return oneLine;
  const digest = crypto.createHash("sha256").update(command, "utf8").digest("hex").slice(0, 12);
  return `${commandPrefix(command)} ... [command chars=${command.length} sha256=${digest}]`;
}

function commandPrefix(command) {
  const firstLine = command.split(/\r?\n/)[0] || command;
  const prefix = firstLine.split(/\s+/).filter(Boolean).join(" ");
  return prefix.length <= LONG_COMMAND_HEAD ? prefix : prefix.slice(0, LONG_COMMAND_HEAD).trimEnd();
}

function redact(text) {
  let result = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}

function estimateTokens(text) {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function matchesAny(patterns, text, flags = "") {
  return patterns.some((pattern) => regexTest(pattern, text, flags));
}

function regexTest(pattern, text, flags = "") {
  try {
    return new RegExp(pattern, flags).test(text);
  } catch {
    return false;
  }
}

function shorten(line) {
  return line.length <= 220 ? line : `${line.slice(0, 217).trimEnd()}...`;
}

function uniqueTail(values, limit) {
  const unique = [];
  const seen = new Set();
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= limit) break;
  }
  return unique.reverse();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (value != null) return String(value);
  }
  return "";
}

function asInt(...values) {
  for (const value of values) {
    if (value == null) continue;
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  asInt,
  commandSummary,
  estimateTokens,
  firstString,
  matchesAny,
  numberOr,
  objectOrEmpty,
  redact,
  regexTest,
  shorten,
  stripAnsi,
  uniqueTail,
};
