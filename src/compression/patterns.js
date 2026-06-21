"use strict";

const CRITICAL_PATTERNS = [
  "\\bTraceback\\b",
  "\\bException\\b",
  "\\bSyntaxError\\b",
  "\\bTypeError\\b",
  "\\bAssertionError\\b",
  "\\bFAILED\\b",
  "\\berror:",
  "\\bfatal:",
  "\\bsegmentation fault\\b",
  "\\bpanic\\b",
  "\\bundefined reference\\b",
  "\\bNo such file or directory\\b",
  "\\bPermission denied\\b",
  "\\bnpm ERR!",
  "\\bCommand failed\\b",
  "\\btimeout\\b",
  "\\bOOM\\b",
];

const AWS_ACCESS_KEY_PREFIX = "AK" + "IA";
const AWS_SESSION_KEY_PREFIX = "AS" + "IA";
const GITHUB_PAT_PREFIX = "github" + "_pat_";
const HF_TOKEN_PREFIX = "h" + "f_";

const SECRET_HIT_PATTERNS = [
  `\\b${AWS_ACCESS_KEY_PREFIX}[0-9A-Z]{16}\\b`,
  `\\b${AWS_SESSION_KEY_PREFIX}[0-9A-Z]{16}\\b`,
  "\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b",
  `\\b${GITHUB_PAT_PREFIX}[A-Za-z0-9_]{20,}\\b`,
  `\\b${HF_TOKEN_PREFIX}[A-Za-z0-9]{20,}\\b`,
  "\\bsk-[A-Za-z0-9_-]{20,}\\b",
  "\\b(?:api[_-]?key|token|secret|password|passwd|authorization)\\s*[:=]\\s*\\S+",
  "\\[REDACTED_(?:AWS_KEY|GITHUB_TOKEN|HF_TOKEN|API_KEY|JWT|PRIVATE_KEY)\\]",
  "\\b(?:api[_-]?key|token|secret|password|passwd|authorization)\\s*[:=]\\s*\\[REDACTED\\]",
  "\\b[A-Za-z0-9_]*(?:api[_-]?key|API[_-]?KEY|token|TOKEN|secret|SECRET|password|PASSWORD|passwd|PASSWD|authorization|AUTHORIZATION)\\s*[:=]\\s*\\[REDACTED\\]",
];

const KEEP_PATTERNS = [
  "\\b(ERROR|Error|error|ERR!)\\b",
  "\\b(WARNING|Warning|warning|WARN)\\b",
  "\\b(FAILED|Failed|failed|FAIL)\\b",
  "\\b(passed|failed|skipped|xfailed|xpassed)\\b",
  "\\bTraceback\\b",
  "\\bAssertionError\\b",
  "\\bSyntaxError\\b",
  "\\bTypeError\\b",
  "\\bException\\b",
  "\\b\\d+\\s+(passed|failed|skipped|errors?)\\b",
  "[/\\w.-]+:\\d+(:\\d+)?",
  ...SECRET_HIT_PATTERNS,
];

const STRIP_PATTERNS = [
  "^\\s*Collecting\\s+\\S+",
  "^\\s*Downloading\\s+\\S+",
  "^\\s*Using cached\\s+\\S+",
  "^\\s*Requirement already satisfied:",
  "^\\s*Installing collected packages:",
  "^\\s*[|/\\\\-]\\s*$",
  "^\\s*\\d{1,3}%\\|",
  "^\\s*\\[[=>.\\s-]+\\]\\s*\\d{1,3}%",
  "^\\s*remote:\\s*(Counting|Compressing|Receiving|Resolving)",
];

const PROGRESS_LINE_PATTERNS = [
  "\\d{1,3}%\\|.*\\|\\s*\\d+/\\d+",
  "\\[[#=\\u2588>.\\s-]+\\]\\s*\\d{1,3}%",
  "\\b(Downloading|Extracting|Processing|Uploading|Receiving|Resolving)\\b",
  "\\b\\d+\\s*/\\s*\\d+\\b.*(?:it/s|s/it|B/s|MB/s|GB/s|ETA|elapsed|remaining)",
  "^\\s*\\d+\\s*/\\s*\\d+\\s+\\[[^\\]]+\\]",
  "[\\u2588\\u2593\\u2592\\u2591\\u25a0\\u2589\\u258a\\u258b\\u258c\\u258d\\u258e\\u258f\\u2587\\u2586\\u2585\\u2584\\u2583\\u2582\\u2581\\u2501]{6,}",
  "\\b(?:ETA|elapsed|remaining|it/s|s/it|B/s|MB/s|GB/s)\\b",
];

const PROGRESS_METRIC_PATTERN = /\b(?:epoch|step|loss|eval_loss|val_loss|accuracy|acc|f1|perplexity|ppl|lr|learning_rate)\b\s*[:=]?\s*[-+0-9.eE/%a-zA-Z_]+/gi;
const URL_PATTERN = /https?:\/\/\S+/g;
const PROGRESS_FILE_PATTERN = /(?:[\w.-]+\/)+[\w.@+-]+\.(?:whl|zip|tar|gz|tgz|pt|pth|safetensors|onnx|json|yaml|yml|csv|parquet|log)\b/g;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const LONG_COMMAND_LIMIT = 180;
const LONG_COMMAND_HEAD = 120;

const RAW_FALLBACK_COMMAND_PATTERNS = [
  "\\bcommand-compressor-raw\\b",
  "(^|[\\s'\"=])\\.command-compressor[/\\\\]raw(?:[/\\\\]|\\b)",
  "[/\\\\]\\.command-compressor[/\\\\]raw(?:[/\\\\]|\\b)",
  "\\bCOMMAND_COMPRESSOR_RAW_DIR\\b",
];

const CONSERVATIVE_PASSTHROUGH_COMMAND_PATTERNS = [
  "^\\s*(xxd|hexdump|od|strings|base64)\\b",
  "^\\s*(sqlite3|duckdb)\\b.*\\s(\\.dump|\\.recover|\\.schema)\\b",
];

const REDACTION_PATTERNS = [
  [/(api[_-]?key|token|secret|password|passwd|authorization)(\s*[:=]\s*)([^\s'"`]+)/gi, "$1$2[REDACTED]"],
  [/bearer\s+[a-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]"],
  [/eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, "[REDACTED_JWT]"],
  [/sk-[a-zA-Z0-9_-]{20,}/g, "[REDACTED_API_KEY]"],
  [new RegExp(`${AWS_ACCESS_KEY_PREFIX}[0-9A-Z]{16}`, "g"), "[REDACTED_AWS_KEY]"],
  [new RegExp(`${AWS_SESSION_KEY_PREFIX}[0-9A-Z]{16}`, "g"), "[REDACTED_AWS_KEY]"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [new RegExp(`${GITHUB_PAT_PREFIX}[A-Za-z0-9_]{20,}`, "g"), "[REDACTED_GITHUB_TOKEN]"],
  [new RegExp(`${HF_TOKEN_PREFIX}[A-Za-z0-9]{20,}`, "g"), "[REDACTED_HF_TOKEN]"],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
];

module.exports = {
  ANSI_RE,
  CONSERVATIVE_PASSTHROUGH_COMMAND_PATTERNS,
  CRITICAL_PATTERNS,
  KEEP_PATTERNS,
  LONG_COMMAND_HEAD,
  LONG_COMMAND_LIMIT,
  PROGRESS_FILE_PATTERN,
  PROGRESS_LINE_PATTERNS,
  PROGRESS_METRIC_PATTERN,
  RAW_FALLBACK_COMMAND_PATTERNS,
  REDACTION_PATTERNS,
  SECRET_HIT_PATTERNS,
  STRIP_PATTERNS,
  URL_PATTERN,
};
