"use strict";

const {
  PROGRESS_FILE_PATTERN,
  PROGRESS_LINE_PATTERNS,
  PROGRESS_METRIC_PATTERN,
  SECRET_HIT_PATTERNS,
  URL_PATTERN,
} = require("./patterns");
const { matchesAny, shorten, uniqueTail } = require("./utils");

function dropProgressLines(lines) {
  const kept = [];
  const metrics = [];
  const first = [];
  let last = [];
  let omitted = 0;
  for (const line of lines) {
    if (!isProgressLine(line) || mustKeepProgressLine(line)) {
      kept.push(line);
      continue;
    }
    omitted += 1;
    const sample = shorten(line);
    if (first.length < 2) first.push(sample);
    last = [...last.slice(-1), sample];
    const metric = extractProgressMetric(line);
    if (metric) metrics.push(metric);
  }
  const samples = first.map((line) => `first: ${line}`);
  for (const line of last) {
    if (!first.includes(line)) samples.push(`last: ${line}`);
  }
  return [kept, omitted, uniqueTail(metrics, 8), samples];
}

function progressSummary(omitted, metrics, samples) {
  if (omitted <= 0) return [];
  const lines = [`[progress] omitted ${omitted} progress/status lines before head/tail retention.`];
  if (samples.length) lines.push("[progress samples retained]", ...samples);
  if (metrics.length) lines.push("[progress facts retained]", ...metrics);
  return lines;
}

function extractProgressMetric(line) {
  const facts = [];
  const metrics = Array.from(line.matchAll(PROGRESS_METRIC_PATTERN), (match) => match[0]);
  const urls = Array.from(line.matchAll(URL_PATTERN), (match) => match[0]);
  const files = Array.from(line.matchAll(PROGRESS_FILE_PATTERN), (match) => match[0]);
  if (metrics.length) facts.push(`metrics=${metrics.slice(0, 8).join(", ")}`);
  if (urls.length) facts.push(`urls=${urls.slice(0, 3).join(", ")}`);
  if (files.length) facts.push(`files=${files.slice(0, 6).join(", ")}`);
  return facts.length ? `progress facts: ${facts.join("; ")}` : null;
}

function isProgressLine(line) {
  return matchesAny(PROGRESS_LINE_PATTERNS, line);
}

function mustKeepProgressLine(line) {
  return matchesAny([
    ...SECRET_HIT_PATTERNS,
    "\\b(ERROR|Error|error|ERR!)\\b",
    "\\b(WARNING|Warning|warning|WARN)\\b",
    "\\b(FAILED|Failed|failed|FAIL)\\b",
    "\\bTraceback\\b",
    "\\bException\\b",
    "\\bCUDA out of memory\\b",
    "\\bNaN\\b",
    "\\binf\\b",
  ], line);
}

module.exports = {
  dropProgressLines,
  isProgressLine,
  progressSummary,
};
