"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  defaultClaudeSettingsPath,
  defaultCodexHooksPath,
  defaultOpenCodePluginPath,
  defaultPiExtensionPath,
} = require("../config/paths");

const AGENTS = ["claude-code", "codex", "opencode", "pi"];
const CCA_MARKER = "command-compressor-agent managed";
const EXECUTABLES = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
};

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function hookScriptPath() {
  return path.resolve(__dirname, "..", "..", "bin", "cca-hook.js");
}

function hookCommand(configPath, nodePath = process.execPath || "node", agent = "claude-code") {
  const agentArg = agent === "claude-code" ? "" : ` ${shQuote(agent)}`;
  return `CCA_CONFIG_PATH=${shQuote(configPath)} ${shQuote(nodePath)} ${shQuote(hookScriptPath())}${agentArg} # ${CCA_MARKER}`;
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
  return installJsonHook("claude-code", options);
}

function installCodexHook(options = {}) {
  return installJsonHook("codex", options);
}

function uninstallClaudeHook(options = {}) {
  return uninstallJsonHook("claude-code", options);
}

function uninstallCodexHook(options = {}) {
  return uninstallJsonHook("codex", options);
}

function installJsonHook(agent, options = {}) {
  const scope = options.scope || "global";
  const settingsPath = options.settingsPath || targetPath(agent, scope, options);
  const command = hookCommand(options.configPath, options.nodePath, agent);
  const data = loadSettings(settingsPath);
  const before = JSON.stringify(data);
  const hooks = ensureObject(data, "hooks");
  const post = ensureArray(hooks, "PostToolUse");
  let target = post.find((entry) =>
    entry && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isCcaHook(hook))
  );
  if (!target) target = post.find((entry) => entry && /^(?:\^)?Bash(?:\$)?$/.test(String(entry.matcher || "")));
  if (!target) {
    target = { matcher: agent === "codex" ? "^Bash$" : "Bash", hooks: [] };
    post.push(target);
  }
  target.hooks = Array.isArray(target.hooks) ? target.hooks.filter((hook) => !isCcaHook(hook)) : [];
  const handler = { type: "command", command };
  if (agent === "codex") {
    handler.timeout = 30;
    handler.statusMessage = "Compressing command output";
  }
  target.hooks.push(handler);
  const changed = before !== JSON.stringify(data);
  if (changed || !fs.existsSync(settingsPath)) writeSettings(settingsPath, data);
  return {
    agent,
    scope,
    settingsPath,
    path: settingsPath,
    command,
    changed,
    needsTrust: agent === "codex",
    warning: agent === "codex"
      ? "Codex PostToolUse replacement is not model-visible in code mode; use this integration only with a verified function-tool-mode Codex setup."
      : null,
  };
}

function uninstallJsonHook(agent, options = {}) {
  const scope = options.scope || "global";
  const settingsPath = options.settingsPath || targetPath(agent, scope, options);
  if (!fs.existsSync(settingsPath)) return { agent, scope, settingsPath, path: settingsPath, changed: false };
  const data = loadSettings(settingsPath);
  const hooks = data.hooks;
  if (!hooks || !Array.isArray(hooks.PostToolUse)) {
    return { agent, scope, settingsPath, path: settingsPath, changed: false };
  }
  let changed = false;
  hooks.PostToolUse = hooks.PostToolUse.flatMap((entry) => {
    if (!entry || !Array.isArray(entry.hooks)) return [entry];
    const kept = entry.hooks.filter((hook) => !isCcaHook(hook));
    if (kept.length !== entry.hooks.length) changed = true;
    return kept.length ? [{ ...entry, hooks: kept }] : [];
  });
  if (!hooks.PostToolUse.length) delete hooks.PostToolUse;
  if (!Object.keys(hooks).length) delete data.hooks;
  if (changed) writeSettings(settingsPath, data);
  return { agent, scope, settingsPath, path: settingsPath, changed };
}

function installOpenCodePlugin(options = {}) {
  return installOwnedFile("opencode", options, openCodePluginSource);
}

function uninstallOpenCodePlugin(options = {}) {
  return uninstallOwnedFile("opencode", options);
}

function installPiExtension(options = {}) {
  return installOwnedFile("pi", options, piExtensionSource);
}

function uninstallPiExtension(options = {}) {
  return uninstallOwnedFile("pi", options);
}

function installOwnedFile(agent, options, sourceFactory) {
  const scope = options.scope || "global";
  const pathname = options.settingsPath || targetPath(agent, scope, options);
  const source = sourceFactory(options.configPath);
  if (fs.existsSync(pathname)) {
    const existing = fs.readFileSync(pathname, "utf8");
    if (!existing.includes(CCA_MARKER)) {
      throw new Error(`Refusing to overwrite non-CCA file: ${pathname}`);
    }
    if (existing === source) return { agent, scope, path: pathname, changed: false };
  }
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, source, "utf8");
  return { agent, scope, path: pathname, changed: true };
}

function uninstallOwnedFile(agent, options = {}) {
  const scope = options.scope || "global";
  const pathname = options.settingsPath || targetPath(agent, scope, options);
  if (!fs.existsSync(pathname)) return { agent, scope, path: pathname, changed: false };
  const existing = fs.readFileSync(pathname, "utf8");
  if (!existing.includes(CCA_MARKER)) {
    return { agent, scope, path: pathname, changed: false, conflict: true };
  }
  fs.unlinkSync(pathname);
  return { agent, scope, path: pathname, changed: true };
}

function openCodePluginSource(configPath) {
  const adapterPath = path.resolve(__dirname, "opencode.js");
  return [
    `// ${CCA_MARKER}`,
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    `const { handleOpenCodeToolAfter } = require(${JSON.stringify(adapterPath)});`,
    "",
    "export const CommandCompressorAgent = async () => ({",
    '  "tool.execute.after": async (input, output) => {',
    `    handleOpenCodeToolAfter(input, output, { configPath: ${JSON.stringify(configPath)} });`,
    "  },",
    "});",
    "",
  ].join("\n");
}

function piExtensionSource(configPath) {
  const adapterPath = path.resolve(__dirname, "pi.js");
  return [
    `// ${CCA_MARKER}`,
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    `const { handlePiToolResult } = require(${JSON.stringify(adapterPath)});`,
    "",
    "export default function commandCompressorAgent(pi) {",
    '  pi.on("tool_result", async (event) =>',
    `    handlePiToolResult(event, { configPath: ${JSON.stringify(configPath)} })`,
    "  );",
    "}",
    "",
  ].join("\n");
}

function targetPath(agent, scope = "global", options = {}) {
  if (agent === "claude-code") return defaultClaudeSettingsPath(scope, options);
  if (agent === "codex") return defaultCodexHooksPath(scope, options);
  if (agent === "opencode") return defaultOpenCodePluginPath(scope, options);
  if (agent === "pi") return defaultPiExtensionPath(scope, options);
  throw new Error(`Unsupported agent: ${agent}`);
}

function installAgent(agent, options = {}) {
  if (agent === "claude-code") return installClaudeHook(options);
  if (agent === "codex") return installCodexHook(options);
  if (agent === "opencode") return installOpenCodePlugin(options);
  if (agent === "pi") return installPiExtension(options);
  throw new Error(`Unsupported agent: ${agent}`);
}

function uninstallAgent(agent, options = {}) {
  if (agent === "claude-code") return uninstallClaudeHook(options);
  if (agent === "codex") return uninstallCodexHook(options);
  if (agent === "opencode") return uninstallOpenCodePlugin(options);
  if (agent === "pi") return uninstallPiExtension(options);
  throw new Error(`Unsupported agent: ${agent}`);
}

function isAgentInstalled(agent, options = {}) {
  const scope = options.scope || "global";
  const pathname = options.settingsPath || targetPath(agent, scope, options);
  if (!fs.existsSync(pathname)) return false;
  if (agent === "opencode" || agent === "pi") {
    return fs.readFileSync(pathname, "utf8").includes(CCA_MARKER);
  }
  try {
    const data = loadSettings(pathname);
    return Boolean(
      data.hooks &&
      Array.isArray(data.hooks.PostToolUse) &&
      data.hooks.PostToolUse.some((entry) =>
        entry && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isCcaHook(hook))
      )
    );
  } catch {
    return false;
  }
}

function findExecutable(name, envPath = process.env.PATH || "") {
  for (const directory of String(envPath).split(path.delimiter).filter(Boolean)) {
    const pathname = path.join(directory, name);
    try {
      fs.accessSync(pathname, fs.constants.X_OK);
      return pathname;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function commandOutput(executable, args) {
  if (!executable) return { ok: false, output: "" };
  const result = childProcess.spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 10000,
    shell: false,
  });
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function detectAgent(agent, options = {}) {
  const executable = (options.executables && options.executables[agent])
    || findExecutable(EXECUTABLES[agent], options.envPath);
  const versionResult = commandOutput(executable, ["--version"]);
  let hooksSupported = true;
  let hookSupport = "not-applicable";
  if (agent === "codex" && executable) {
    const features = commandOutput(executable, ["features", "list"]);
    if (features.ok) {
      hooksSupported = /^hooks\s+\S+\s+true\b/im.test(features.output);
      hookSupport = hooksSupported ? "enabled" : "disabled-or-unavailable";
    } else {
      hooksSupported = false;
      hookSupport = "unknown";
    }
  }
  const installed = isAgentInstalled(agent, options);
  const replacementSupport = agent === "codex"
    ? "function-tool-mode-only"
    : "supported";
  const integrationSupported = Boolean(executable) &&
    hooksSupported &&
    agent !== "codex";
  return {
    agent,
    detected: Boolean(executable),
    executable,
    version: versionResult.output.split(/\r?\n/)[0] || null,
    supported: integrationSupported,
    installed,
    path: targetPath(agent, options.scope || "global", options),
    hookSupport,
    replacementSupport,
    supportBlocker: agent === "codex" && executable && hooksSupported
      ? "PostToolUse replacements are ignored by current Codex code mode."
      : null,
    needsTrust: agent === "codex" && installed,
    trustStatus: agent === "codex" && installed ? "review-required-or-unknown" : "not-applicable",
  };
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
  AGENTS,
  CCA_MARKER,
  detectAgent,
  findExecutable,
  hookCommand,
  hookScriptPath,
  installAgent,
  installClaudeHook,
  installCodexHook,
  installOpenCodePlugin,
  installPiExtension,
  isAgentInstalled,
  targetPath,
  uninstallAgent,
  uninstallClaudeHook,
  uninstallCodexHook,
  uninstallOpenCodePlugin,
  uninstallPiExtension,
};
