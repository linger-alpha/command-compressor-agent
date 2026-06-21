"use strict";

const fs = require("fs");
const path = require("path");

const { defaultClaudeSettingsPath } = require("../config/paths");

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function hookScriptPath() {
  return path.resolve(__dirname, "..", "..", "bin", "cca-hook.js");
}

function hookCommand(configPath, nodePath = process.execPath || "node") {
  return `CCA_CONFIG_PATH=${shQuote(configPath)} ${shQuote(nodePath)} ${shQuote(hookScriptPath())}`;
}

function loadSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Expected object JSON in ${settingsPath}`);
  }
  return data;
}

function writeSettings(settingsPath, data) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function installClaudeHook(options = {}) {
  const scope = options.scope || "global";
  const settingsPath = options.settingsPath || defaultClaudeSettingsPath(scope);
  const command = hookCommand(options.configPath);
  const data = loadSettings(settingsPath);
  const hooks = ensureObject(data, "hooks");
  const post = ensureArray(hooks, "PostToolUse");
  const existing = post.find((entry) => entry && entry.matcher === "Bash");
  const target = existing || { matcher: "Bash", hooks: [] };
  target.hooks = Array.isArray(target.hooks) ? target.hooks.filter((hook) => !isCcaHook(hook)) : [];
  const present = target.hooks.some((hook) => hook && hook.type === "command" && hook.command === command);
  if (!present) target.hooks.push({ type: "command", command });
  if (!existing) post.push(target);
  writeSettings(settingsPath, data);
  return { settingsPath, command, changed: !present };
}

function uninstallClaudeHook(options = {}) {
  const scope = options.scope || "global";
  const settingsPath = options.settingsPath || defaultClaudeSettingsPath(scope);
  const data = loadSettings(settingsPath);
  const hooks = data.hooks;
  if (!hooks || !Array.isArray(hooks.PostToolUse)) return { settingsPath, changed: false };
  let changed = false;
  hooks.PostToolUse = hooks.PostToolUse.flatMap((entry) => {
    if (!entry || entry.matcher !== "Bash" || !Array.isArray(entry.hooks)) return [entry];
    const kept = entry.hooks.filter((hook) => !isCcaHook(hook));
    if (kept.length !== entry.hooks.length) changed = true;
    return kept.length ? [{ ...entry, hooks: kept }] : [];
  });
  if (!hooks.PostToolUse.length) delete hooks.PostToolUse;
  if (!Object.keys(hooks).length) delete data.hooks;
  writeSettings(settingsPath, data);
  return { settingsPath, changed };
}

function ensureObject(data, key) {
  if (data[key] && typeof data[key] === "object" && !Array.isArray(data[key])) return data[key];
  data[key] = {};
  return data[key];
}

function ensureArray(data, key) {
  if (Array.isArray(data[key])) return data[key];
  data[key] = [];
  return data[key];
}

function isCcaHook(hook) {
  if (!hook || hook.type !== "command") return false;
  const command = String(hook.command || "");
  return command.includes("cca-hook.js") || command.includes("command-compressor-agent") || command.includes("command-compressor");
}

module.exports = {
  hookCommand,
  hookScriptPath,
  installClaudeHook,
  uninstallClaudeHook,
};
