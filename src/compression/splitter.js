"use strict";

const DEFAULT_SPLITTER = {
  logLevelPattern: "(?:^|\\s|\\[)(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)(?:\\s|:|\\])",
  tracebackStartPattern: "^Traceback \\(most recent call last\\):",
  tracebackEndPattern: "^\\S*(?:Error|Exception|Failure|Interrupt)(?::|\\b)",
};

function splitBlocks(input, config = {}) {
  const lines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  if (!lines.length) return [];
  const settings = normalizeSettings(config);
  const blocks = [];
  let current = [];
  let inTraceback = false;
  let previous = null;
  let previousPreviousSignature = null;

  const flush = () => {
    if (!current.length) return;
    blocks.push(makeBlock(current));
    current = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index]);
    if (line.trim() === "") {
      flush();
      blocks.push(makeBlock([{ index, line, meta: { blank: true } }]));
      previous = null;
      previousPreviousSignature = null;
      continue;
    }

    const startsTraceback = settings.tracebackStart.test(line);
    const lineInTraceback = inTraceback || startsTraceback;
    const endsTraceback = lineInTraceback && !startsTraceback && settings.tracebackEnd.test(line);
    const signature = repetitionSignature(line);
    const nextLine = index + 1 < lines.length ? String(lines[index + 1]) : "";
    const nextSignature = nextLine.trim() ? repetitionSignature(nextLine) : null;
    const meta = {
      blank: false,
      indent: indentationClass(line),
      level: logLevel(line, settings.logLevel),
      timestamp: timestampKey(line),
      traceback: lineInTraceback,
      tracebackStart: startsTraceback,
      tracebackEnd: endsTraceback,
      signature,
    };

    if (current.length && isBoundary({
      current: meta,
      nextSignature,
      previous,
      previousPreviousSignature,
    })) {
      flush();
    }

    current.push({ index, line, meta });
    previousPreviousSignature = previous ? previous.signature : null;
    previous = meta;
    if (startsTraceback) inTraceback = true;
    if (endsTraceback) inTraceback = false;
  }
  flush();
  return blocks;
}

function isBoundary({ current, nextSignature, previous, previousPreviousSignature }) {
  if (!previous) return false;
  if (current.tracebackStart || previous.tracebackEnd) return true;
  if (!current.traceback && !previous.traceback) {
    if (current.timestamp && previous.timestamp && current.timestamp !== previous.timestamp) return true;
    if (current.level && previous.level && current.level !== previous.level) return true;
    if (current.indent !== previous.indent) return true;
    const startsRepeatedRun =
      nextSignature && current.signature === nextSignature && current.signature !== previous.signature;
    const endsRepeatedRun =
      previous.signature === previousPreviousSignature && current.signature !== previous.signature;
    if (startsRepeatedRun || endsRepeatedRun) return true;
  }
  return false;
}

function makeBlock(entries) {
  const first = entries[0];
  const last = entries[entries.length - 1];
  const isSeparator = entries.every((entry) => entry.meta.blank);
  return {
    startLine: first.index + 1,
    endLine: last.index + 1,
    lines: entries.map((entry) => entry.line),
    separator: isSeparator,
    kind: isSeparator
      ? "separator"
      : entries.some((entry) => entry.meta.traceback)
        ? "traceback"
        : entries.some((entry) => entry.meta.level)
          ? "log"
          : "text",
  };
}

function normalizeSettings(config) {
  return {
    logLevel: safeRegex(config.log_level_pattern || config.logLevelPattern, DEFAULT_SPLITTER.logLevelPattern, "i"),
    tracebackStart: safeRegex(
      config.traceback_start_pattern || config.tracebackStartPattern,
      DEFAULT_SPLITTER.tracebackStartPattern,
      "i"
    ),
    tracebackEnd: safeRegex(
      config.traceback_end_pattern || config.tracebackEndPattern,
      DEFAULT_SPLITTER.tracebackEndPattern,
      "i"
    ),
  };
}

function safeRegex(value, fallback, flags) {
  try {
    return new RegExp(String(value || fallback), flags);
  } catch {
    return new RegExp(fallback, flags);
  }
}

function logLevel(line, pattern) {
  pattern.lastIndex = 0;
  const match = pattern.exec(line);
  return match ? String(match[1] || match[0]).toUpperCase() : null;
}

function timestampKey(line) {
  let match = line.match(/^\s*\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}):\d{2}(?::\d{2})?/);
  if (match) return `iso:${match[1]}:${match[2]}`;
  match = line.match(/^\s*\[?(\d{2}):\d{2}(?::\d{2})?/);
  if (match) return `time:${match[1]}`;
  match = line.match(/^\s*\[?(\d{4}\/\d{2}\/\d{2})[ T](\d{2}):\d{2}/);
  if (match) return `slash:${match[1]}:${match[2]}`;
  return null;
}

function indentationClass(line) {
  return /^[\t ]+\S/.test(line) ? "indented" : "root";
}

function repetitionSignature(line) {
  return String(line)
    .trim()
    .replace(/[#=\u2588\u2593\u2592\u2591>.\\-]{2,}/g, "<bar>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|%|kb|mb|gb|tb)?\b/gi, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

module.exports = {
  indentationClass,
  repetitionSignature,
  splitBlocks,
  timestampKey,
};
