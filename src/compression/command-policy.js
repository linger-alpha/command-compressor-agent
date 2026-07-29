"use strict";

const { RAW_FALLBACK_COMMAND_PATTERNS } = require("./patterns");
const { matchesAny } = require("./utils");

const DEFAULT_RTK_PATTERNS = [
  "^\\s*(?:RTK_DISABLED=1\\s+)?rtk\\b",
];

const DEFAULT_READ_ONLY_PATTERNS = [
  "^\\s*(?:cca|command-compressor-agent)\\b",
  "^\\s*(?:pwd|ls|tree|fd|find|rg|grep|wc|cat|nl|head|tail|less|more|diff|sort|uniq|cut|tr|awk|jq|yq|stat|file|du|df|which|type|md5sum|sha\\d+sum)\\b",
  "^\\s*(?:ps|pgrep|lsof|netstat|ss|uname|locale|printenv|journalctl)\\b",
  "^\\s*env(?:\\s+(?:-0|--null))*\\s*$",
  "^\\s*sed\\b",
  "^\\s*(?:xxd|hexdump|od|strings|base64)\\b",
  "^\\s*git(?:\\s+(?:(?:-C|-c)\\s+(?:\"[^\"]*\"|'[^']*'|\\S+)|--(?:no-pager|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs)))*\\s+(?:status|diff|show|log|branch|tag|rev-parse|ls-files|grep|blame|remote\\s+-v)\\b",
  "^\\s*gh\\s+(?:pr|issue|run|repo|release)\\s+(?:view|list|status|checks|diff)\\b",
  "^\\s*glab\\s+(?:mr|issue|ci|pipeline|release)\\s+(?:view|list|status|diff)\\b",
  "^\\s*(?:sqlite3|duckdb)\\b.*\\s(?:\\.dump|\\.recover|\\.schema)\\b",
  "^\\s*(?:python\\s+-m\\s+)?pip\\s+(?:show|list|freeze|check|index\\s+versions)\\b",
  "^\\s*(?:npm|pnpm|yarn)\\s+(?:list|ls|view|info|why|outdated)\\b",
  "^\\s*docker\\s+(?:ps|container\\s+ls|inspect|logs|images|info|version|stats)\\b",
  "^\\s*kubectl\\s+(?:get|describe|logs|version|cluster-info|api-resources|explain)\\b",
  "^\\s*systemctl\\s+(?:status|show|is-active|is-enabled|list-units|list-unit-files)\\b",
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
  const unwrapped = unwrapShellCommand(text) || unwrapInspectionRunner(text);
  if (unwrapped != null) return isReadOnlyCommand(unwrapped, patterns);
  text = text
    .replace(/\s+2>\s*\/dev\/null\b/g, "")
    .replace(/\s+2>&1\b/g, "")
    .replace(/\s+<\s*\/dev\/null\b/g, "");
  if (hasUnsafeExpansionOrRedirect(text)) return false;
  const segments = splitShellSegments(text);
  let inspectionCommands = 0;
  for (const rawSegment of segments) {
    const segment = normalizeShellSegment(rawSegment);
    if (!segment) continue;
    if (isShellControlSegment(segment)) continue;
    if (isUnsafeInspectionSegment(segment)) return false;
    if (
      matchesAny(patterns, segment, "i") ||
      /^command\s+-v\b/.test(segment) ||
      hasInspectionOnlyFlag(segment)
    ) {
      inspectionCommands += 1;
      continue;
    }
    if (isSafeShellBuiltin(segment)) continue;
    return false;
  }
  return inspectionCommands > 0;
}

function unwrapInspectionRunner(command) {
  const match = String(command || "").match(
    /^(?:\/[^\s]+\/)?(?:conda|mamba|micromamba)\s+run\s+(?:(?:(?:-n|--name|-p|--prefix)\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:live-stream|no-capture-output))\s+)*([\s\S]+)$/
  );
  return match ? match[1].trim() : null;
}

function hasUnsafeExpansionOrRedirect(command) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = "";
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") {
        quote = "";
        continue;
      }
      if (char === "`" || (char === "$" && command[index + 1] === "(")) return true;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (
      char === "<" ||
      char === ">" ||
      char === "`" ||
      (char === "$" && command[index + 1] === "(")
    ) {
      return true;
    }
  }
  return false;
}

function isUnsafeInspectionSegment(segment) {
  if (/^tee(?:\s|$)/i.test(segment)) return true;
  if (/^find\b.*(?:-delete|-exec|-execdir|-ok|-okdir)\b/i.test(segment)) return true;
  return /^sed\b.*(?:^|\s)-i(?:\s|$)/i.test(segment);
}

function hasInspectionOnlyFlag(segment) {
  return /(?:^|\s)(?:--help|-h|--version|-V)(?:\s|$)/.test(segment);
}

function unwrapShellCommand(command) {
  const match = String(command || "").match(
    /^(?:(?:\/usr\/bin\/env)\s+)?(?:\/[^\s]+\/)?(?:bash|dash|fish|sh|zsh)\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/
  );
  if (!match) return null;
  return decodeSingleShellWord(match[1].trim());
}

function decodeSingleShellWord(argument) {
  let output = "";
  let index = 0;
  let consumed = false;
  while (index < argument.length) {
    const char = argument[index];
    if (/\s/.test(char)) {
      return argument.slice(index).trim() ? null : output;
    }
    consumed = true;
    if (char === "'") {
      const end = argument.indexOf("'", index + 1);
      if (end < 0) return null;
      output += argument.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === "\"") {
      index += 1;
      let closed = false;
      while (index < argument.length) {
        const inner = argument[index];
        if (inner === "\"") {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "$" || inner === "`") return null;
        if (inner === "\\" && index + 1 < argument.length) {
          output += argument[index + 1];
          index += 2;
          continue;
        }
        output += inner;
        index += 1;
      }
      if (!closed) return null;
      continue;
    }
    if (char === "\\" && index + 1 < argument.length) {
      output += argument[index + 1];
      index += 2;
      continue;
    }
    if (char === "$" || char === "`") return null;
    output += char;
    index += 1;
  }
  return consumed ? output : null;
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
  decodeSingleShellWord,
  isRawFallbackRead,
  isReadOnlyCommand,
  isSafeReadOnlyShape,
  hasUnsafeExpansionOrRedirect,
  splitShellSegments,
  stripSafeDirectoryPrefix,
  unwrapInspectionRunner,
  unwrapShellCommand,
};
