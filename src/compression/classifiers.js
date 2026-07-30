"use strict";

const { CRITICAL_PATTERNS } = require("./patterns");
const { matchesAny } = require("./utils");

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

module.exports = {
  isCritical,
  isCriticalContextLine,
  isCriticalLine,
};
