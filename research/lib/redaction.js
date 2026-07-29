"use strict";

const SECRET_PATTERNS = [
  [/(api[_-]?key|token|secret|password|passwd|authorization)(\s*[:=]\s*)([^\s'"`]+)/gi, "$1$2[REDACTED]"],
  [/bearer\s+[a-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]"],
  [/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, "[REDACTED_JWT]"],
  [/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, "[REDACTED_HF_TOKEN]"],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
];

const PRIVACY_PATTERNS = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
  [/(?:https?|ssh):\/\/[^/\s:@]+:[^/\s@]+@[^/\s]+/gi, (value) => `${value.split("://")[0]}://[REDACTED_AUTHORITY]`],
  [/\/Users\/[^/\s"'`\\]+/g, "/Users/[USER]"],
  [/\/home\/[^/\s"'`\\]+/g, "/home/[USER]"],
  [/[A-Za-z]:\\Users\\[^\\\s"'`/]+/g, "C:\\Users\\[USER]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
  [/\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi, "[REDACTED_IP]"],
  [/\b(host(?:name)?|server|remote|endpoint)(\s*[:=]\s*)(?!\[REDACTED_HOST\])([A-Za-z0-9._-]+)/gi, "$1$2[REDACTED_HOST]"],
  [/\b[A-Za-z0-9._-]+\.(?:local|internal|lan|home)\b/gi, "[REDACTED_HOST]"],
  [/\b(?:ssh|scp|sftp)\s+(?:-[^\s]+\s+)*(?:[^@\s]+@)?[A-Za-z0-9._-]+/gi, (value) => {
    const command = value.split(/\s+/)[0];
    return `${command} [REDACTED_HOST]`;
  }],
  [/\b[^@\s]+@[A-Za-z0-9._-]+\b/g, "[REDACTED_USER_HOST]"],
];

function redactText(value) {
  let text = String(value == null ? "" : value);
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
    for (const [pattern, replacement] of PRIVACY_PATTERNS) text = text.replace(pattern, replacement);
    if (text === before) break;
  }
  return text;
}

function boundedRedacted(value, maxChars = 12000) {
  const redacted = redactText(value);
  if (redacted.length <= maxChars) {
    return { text: redacted, truncated: false, originalChars: redacted.length };
  }
  const safetyMargin = Math.min(512, Math.max(32, Math.floor(maxChars * 0.05)));
  const marker = `\n[research sample truncated: output was ${redacted.length} chars]\n`;
  const remaining = Math.max(0, maxChars - marker.length - safetyMargin);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return {
    text: redactText(redacted.slice(0, head) + marker + redacted.slice(redacted.length - tail)),
    truncated: true,
    originalChars: redacted.length,
  };
}

module.exports = {
  boundedRedacted,
  redactText,
};
