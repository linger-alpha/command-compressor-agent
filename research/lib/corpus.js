"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { once } = require("events");

const { boundedRedacted, redactText } = require("./redaction");

const SHELL_TOOL_NAMES = new Set(["exec_command", "shell", "bash"]);

async function importCorpus(options) {
  const codexSources = Array.isArray(options.codexSources) ? options.codexSources : [];
  const publicSources = Array.isArray(options.publicSources) ? options.publicSources : [];
  const maxOutputChars = positiveInteger(options.maxOutputChars, 12000);
  const maxCommandChars = positiveInteger(options.maxCommandChars, 2000);
  const maxRecordsPerSession = positiveInteger(options.maxRecordsPerSession, 500);
  const seed = String(options.seed || "20260729");
  const outPath = path.resolve(options.outPath);
  const descriptors = [];

  for (const source of codexSources) {
    for (const filePath of listJsonlFiles(source.path)) {
      descriptors.push({
        kind: "private_codex",
        source: source.label,
        filePath,
        sessionKey: `${source.label}:${path.basename(filePath)}`,
      });
    }
  }
  for (const source of publicSources) {
    const sessions = await scanPublicSessions(source);
    for (const sessionKey of sessions) {
      descriptors.push({
        kind: "public_jsonl",
        source: source.label,
        filePath: path.resolve(source.path),
        sessionKey,
      });
    }
  }
  const splitBySession = assignSplits(descriptors, seed);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const output = fs.createWriteStream(outPath, { encoding: "utf8" });
  const seen = new Set();
  const summary = {
    records: 0,
    bySource: {},
    bySplit: { train: 0, validation: 0, test: 0 },
    skippedUnpaired: 0,
    truncated: 0,
    outPath,
  };

  const emit = async (rawRecord, descriptor, index) => {
    if (index >= maxRecordsPerSession) return;
    const command = boundedRedacted(rawRecord.command, maxCommandChars);
    const stdout = boundedRedacted(rawRecord.stdout, maxOutputChars);
    const stderr = boundedRedacted(rawRecord.stderr, maxOutputChars);
    if (!stdout.text.trim() && !stderr.text.trim()) return;
    const session = pseudonym(descriptor.sessionKey);
    const split = splitBySession.get(descriptor.sessionKey) || "train";
    const id = pseudonym([
      descriptor.source,
      session,
      command.text,
      stdout.text.slice(0, 1000),
      stderr.text.slice(0, 1000),
    ].join("\0"));
    if (seen.has(id)) return;
    seen.add(id);
    const record = {
      schema_version: 1,
      id,
      source: descriptor.source,
      source_kind: descriptor.kind,
      session_id: session,
      split,
      command: command.text,
      stdout: stdout.text,
      stderr: stderr.text,
      exit_code: integerOrNull(rawRecord.exitCode),
      agent: rawRecord.agent || (descriptor.kind === "private_codex" ? "codex" : "terminaltraj"),
      tool_name: rawRecord.toolName || "Bash",
      truncated: {
        command: command.truncated,
        stdout: stdout.truncated,
        stderr: stderr.truncated,
      },
    };
    if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, "drain");
    summary.records += 1;
    summary.bySource[descriptor.source] = (summary.bySource[descriptor.source] || 0) + 1;
    summary.bySplit[split] += 1;
    if (command.truncated || stdout.truncated || stderr.truncated) summary.truncated += 1;
  };

  for (const descriptor of descriptors.filter((entry) => entry.kind === "private_codex")) {
    const result = await extractCodexSession(descriptor, emit);
    summary.skippedUnpaired += result.skippedUnpaired;
  }
  for (const source of publicSources) {
    await extractPublicSource(source, splitBySession, emit);
  }
  output.end();
  await once(output, "finish");
  return summary;
}

async function extractCodexSession(descriptor, emit) {
  const calls = new Map();
  let emitted = 0;
  let skippedUnpaired = 0;
  for await (const item of jsonlItems(descriptor.filePath)) {
    const payload = objectOrEmpty(item.payload);
    if (
      item.type === "response_item" &&
      ["function_call", "custom_tool_call"].includes(payload.type) &&
      isShellTool(payload.name)
    ) {
      const args = parseArguments(payload.arguments != null ? payload.arguments : payload.input);
      const command = normalizeCommand(args.command != null ? args.command : args.cmd);
      if (payload.call_id && command) {
        calls.set(String(payload.call_id), {
          command,
          output: null,
        });
      }
      continue;
    }
    if (
      item.type === "event_msg" &&
      payload.type === "exec_command_end" &&
      payload.call_id
    ) {
      const call = calls.get(String(payload.call_id));
      if (!call) {
        skippedUnpaired += 1;
        continue;
      }
      await emit({
        command: call.command,
        stdout: stringValue(payload.stdout || payload.aggregated_output || payload.formatted_output),
        stderr: stringValue(payload.stderr),
        exitCode: payload.exit_code,
        agent: "codex",
        toolName: "Bash",
      }, descriptor, emitted);
      emitted += 1;
      calls.delete(String(payload.call_id));
      continue;
    }
    if (
      item.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(payload.type) &&
      payload.call_id
    ) {
      const call = calls.get(String(payload.call_id));
      if (call) call.output = payload.output;
    }
  }
  for (const call of calls.values()) {
    if (call.output == null) {
      skippedUnpaired += 1;
      continue;
    }
    const response = parseToolOutput(call.output);
    await emit({
      command: call.command,
      ...response,
      agent: "codex",
      toolName: "Bash",
    }, descriptor, emitted);
    emitted += 1;
  }
  return { emitted, skippedUnpaired };
}

async function extractPublicSource(source, splitBySession, emit) {
  let index = 0;
  const perSession = new Map();
  for await (const item of jsonlItems(source.path)) {
    const sessionKey = publicSessionKey(source.label, source.path, item, index);
    const descriptor = {
      kind: "public_jsonl",
      source: source.label,
      filePath: path.resolve(source.path),
      sessionKey,
    };
    if (!splitBySession.has(sessionKey)) {
      splitBySession.set(sessionKey, stableSplit(sessionKey));
    }
    const sessionIndex = perSession.get(sessionKey) || 0;
    await emit({
      command: stringValue(item.command),
      stdout: stringValue(item.stdout || item.origin_output || item.output),
      stderr: stringValue(item.stderr),
      exitCode: item.exit_code != null ? item.exit_code : item.exitCode,
      agent: stringValue(item.agent || "terminaltraj"),
      toolName: stringValue(item.tool_name || item.toolName || "Bash"),
    }, descriptor, sessionIndex);
    perSession.set(sessionKey, sessionIndex + 1);
    index += 1;
  }
}

async function scanPublicSessions(source) {
  const sessions = new Set();
  let index = 0;
  for await (const item of jsonlItems(source.path)) {
    sessions.add(publicSessionKey(source.label, source.path, item, index));
    index += 1;
  }
  return Array.from(sessions);
}

function publicSessionKey(label, filePath, item, index) {
  const explicit = item.session_id || item.sessionId || item.trajectory_id || item.trajectoryId || item.task_id || item.taskId;
  return explicit
    ? `${label}:${String(explicit)}`
    : `${label}:${path.basename(filePath)}:group-${Math.floor(index / 20)}`;
}

function assignSplits(descriptors, seed) {
  const groups = new Map();
  for (const descriptor of descriptors) {
    if (!groups.has(descriptor.source)) groups.set(descriptor.source, new Map());
    groups.get(descriptor.source).set(descriptor.sessionKey, descriptor);
  }
  const result = new Map();
  for (const sessions of groups.values()) {
    const ordered = Array.from(sessions.keys()).sort((left, right) =>
      hash(`${seed}:${left}`).localeCompare(hash(`${seed}:${right}`))
    );
    const trainCount = Math.round(ordered.length * 0.7);
    const validationCount = Math.round(ordered.length * 0.15);
    ordered.forEach((sessionKey, index) => {
      const split = index < trainCount
        ? "train"
        : index < trainCount + validationCount
          ? "validation"
          : "test";
      result.set(sessionKey, split);
    });
  }
  return result;
}

async function *jsonlItems(filePath) {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) yield value;
    } catch {
      // Corrupt history lines are ignored without aborting the stream.
    }
  }
}

function listJsonlFiles(rootPath) {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return root.endsWith(".jsonl") ? [root] : [];
  const found = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(pathname);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(pathname);
    }
  }
  return found.sort();
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseToolOutput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      stdout: stringValue(value.stdout || value.output || value.content),
      stderr: stringValue(value.stderr),
      exitCode: value.exit_code != null ? value.exit_code : value.exitCode,
    };
  }
  const text = stringValue(value);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parseToolOutput(parsed);
  } catch {
    // Plain text tool output is valid.
  }
  return { stdout: text, stderr: "", exitCode: null };
}

function normalizeCommand(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringValue).join(" ");
  return "";
}

function isShellTool(name) {
  const normalized = String(name || "").split(/(?:__|\.)/).pop().toLowerCase();
  return SHELL_TOOL_NAMES.has(normalized);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function integerOrNull(value) {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function pseudonym(value) {
  return hash(value).slice(0, 20);
}

function stableSplit(value) {
  const bucket = Number.parseInt(hash(value).slice(0, 8), 16) % 100;
  return bucket < 70 ? "train" : bucket < 85 ? "validation" : "test";
}

module.exports = {
  assignSplits,
  extractCodexSession,
  importCorpus,
  isShellTool,
  listJsonlFiles,
  parseToolOutput,
  publicSessionKey,
  redactText,
};
