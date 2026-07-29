"use strict";

const { RAW_FALLBACK_COMMAND_PATTERNS } = require("./patterns");
const { matchesAny } = require("./utils");

const DEFAULT_RTK_PATTERNS = [
  "^\\s*(?:RTK_DISABLED=1\\s+)?rtk\\b",
];

const DEFAULT_READ_ONLY_PATTERNS = [
  "^\\s*(?:cca|command-compressor-agent)\\b",
  "^\\s*(?:pwd|ls|tree|fd|find|rg|grep|wc|cat|nl|head|tail|less|more|diff|sort|uniq|cut|tr|awk|jq|yq|stat|file|du|df|which|type|md5sum|sha\\d+sum)\\b",
  "^\\s*sed\\b",
  "^\\s*(?:xxd|hexdump|od|strings|base64)\\b",
  "^\\s*git\\s+(?:status|diff|show|log|branch|tag|rev-parse|ls-files|grep|blame|remote\\s+-v)\\b",
  "^\\s*gh\\s+(?:pr|issue|run|repo|release)\\s+(?:view|list|status|checks|diff)\\b",
  "^\\s*glab\\s+(?:mr|issue|ci|pipeline|release)\\s+(?:view|list|status|diff)\\b",
  "^\\s*(?:sqlite3|duckdb)\\b.*\\s(?:\\.dump|\\.recover|\\.schema)\\b",
];

function commandPassthroughReason(command, rawDir, policy = {}) {
  const text = String(command || "");
  if (isRawFallbackRead(text, rawDir)) {
    return {
      status: "raw fallback read passthrough",
      rules: ["raw_fallback_read_passthrough"],
    };
  }
  const rtkPatterns = configuredPatterns(policy, "rtk_patterns", "rtkPatterns", DEFAULT_RTK_PATTERNS);
  if (matchesAny(rtkPatterns, text, "i")) {
    return {
      status: "RTK compatibility passthrough",
      rules: ["rtk_passthrough"],
    };
  }
  const readOnlyPatterns = configuredPatterns(
    policy,
    "read_only_patterns",
    "readOnlyPatterns",
    DEFAULT_READ_ONLY_PATTERNS
  );
  if (isReadOnlyCommand(text, readOnlyPatterns)) {
    return {
      status: "read-only inspection passthrough",
      rules: ["read_only_passthrough"],
    };
  }
  const compatibilityPatterns = []
    .concat(Array.isArray(policy.compatibility_patterns) ? policy.compatibility_patterns : [])
    .concat(Array.isArray(policy.compatibilityPatterns) ? policy.compatibilityPatterns : []);
  if (matchesAny(compatibilityPatterns, text, "i")) {
    return {
      status: "user command compatibility passthrough",
      rules: ["command_compatibility_passthrough"],
    };
  }
  return null;
}

function configuredPatterns(policy, snakeName, camelName, fallback) {
  const configured = []
    .concat(Array.isArray(policy[snakeName]) ? policy[snakeName] : [])
    .concat(Array.isArray(policy[camelName]) ? policy[camelName] : []);
  return configured.length ? configured : fallback;
}

function isRawFallbackRead(command, rawDir) {
  if (matchesAny(RAW_FALLBACK_COMMAND_PATTERNS, command, "i")) return true;
  return Boolean(rawDir && command.includes(String(rawDir)));
}

function stripSafeDirectoryPrefix(command) {
  let text = String(command || "").trim();
  for (let count = 0; count < 4; count += 1) {
    const match = text.match(/^(?:cd|pushd)\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/);
    if (!match) break;
    text = text.slice(match[0].length);
  }
  return text;
}

function isSafeReadOnlyShape(command) {
  return isReadOnlyCommand(command, DEFAULT_READ_ONLY_PATTERNS);
}

function isReadOnlyCommand(command, patterns = DEFAULT_READ_ONLY_PATTERNS) {
  let text = String(command || "").trim();
  if (!text) return false;
  text = text
    .replace(/\s+2>\s*\/dev\/null\b/g, "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+<\s*\/dev\/null\b/g, "");
  if (/(?:>>?|<<?|\$\(|`)/.test(text)) return false;
  if (/(?:^|\s)tee(?:\s|$)/i.test(text)) return false;
  if (/(?:^|\s)find\b[^;&|]*(?:-delete|-exec|-execdir|-ok|-okdir)\b/i.test(text)) return false;
  if (/(?:^|\s)sed\b[^;&|]*(?:^|\s)-i(?:\s|$)/i.test(text)) return false;
  const segments = splitShellSegments(text);
  let inspectionCommands = 0;
  for (const rawSegment of segments) {
    const segment = normalizeShellSegment(rawSegment);
    if (!segment) continue;
    if (isShellControlSegment(segment)) continue;
    if (matchesAny(patterns, segment, "i") || /^command\s+-v\b/.test(segment)) {
      inspectionCommands += 1;
      continue;
    }
    if (isSafeShellBuiltin(segment)) continue;
    return false;
  }
  return inspectionCommands > 0;
}

function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n" || char === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function normalizeShellSegment(value) {
  let text = String(value || "").trim();
  text = text.replace(/^(?:then|else|do)\b\s*/, "");
  text = text.replace(/^(?:elif|if|while|until)\b\s*/, "");
  text = text.replace(/^\{\s*/, "").replace(/\s*\}$/, "");
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, "");
  return text.trim();
}

function isShellControlSegment(segment) {
  return /^(?:fi|done|esac|\{|\})$/.test(segment) ||
    /^(?:for|select)\s+[A-Za-z_][A-Za-z0-9_]*\s+in\b/.test(segment) ||
    /^case\b.*\bin$/.test(segment);
}

function isSafeShellBuiltin(segment) {
  return /^(?:cd|pushd|popd|test|true|false|echo|printf)\b/.test(segment) ||
    /^\[\s/.test(segment);
}

module.exports = {
  DEFAULT_READ_ONLY_PATTERNS,
  DEFAULT_RTK_PATTERNS,
  commandPassthroughReason,
  isRawFallbackRead,
  isReadOnlyCommand,
  isSafeReadOnlyShape,
  splitShellSegments,
  stripSafeDirectoryPrefix,
};
