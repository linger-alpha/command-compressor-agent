"use strict";

const { ensureUserConfig, loadConfig, saveConfig } = require("./config/paths");
const { listStrengthProfiles, normalizeStrength } = require("./config/strength");
const { readGain, resetGain } = require("./evaluation/store");
const {
  AGENTS,
  detectAgent,
  installAgent,
  uninstallAgent,
} = require("./takeover/install");
const { runClaudeHook } = require("./takeover/claude-code");
const { runCodexHook } = require("./takeover/codex");

async function main(argv) {
  const command = argv[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "hook" && argv[1] === "claude-code") {
    await runClaudeHook();
    return 0;
  }
  if (command === "hook" && argv[1] === "codex") {
    await runCodexHook();
    return 0;
  }
  if (command === "install") return install(argv.slice(1));
  if (command === "init") return init(argv.slice(1));
  if (command === "uninstall") return uninstall(argv.slice(1));
  if (command === "strength") return strength(argv.slice(1));
  if (command === "gain") return gain(argv.slice(1));
  if (command === "status") return status(argv.slice(1));
  if (command === "rules") return rules(argv.slice(1));
  process.stderr.write(`Unknown command: ${command}\n`);
  return help(1);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key.includes("=")) {
      const [name, value] = key.split(/=(.*)/s);
      flags[name] = value;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function init(args) {
  const flags = parseFlags(args);
  const scope = parseScope(flags);
  const config = ensureUserConfig({
    configPath: flags.config,
    strength: flags.strength,
    rulesPath: flags.rules,
  });
  const detected = AGENTS.map((agent) => detectAgent(agent, { scope }));
  const selected = detected.filter((entry) => entry.detected && entry.supported).map((entry) => entry.agent);
  if (!selected.length) {
    printJsonOrText(flags, {
      status: "no-supported-agents-detected",
      scope,
      agents: Object.fromEntries(detected.map((entry) => [entry.agent, entry])),
    }, ["No installed supported coding agent was detected."]);
    return 1;
  }
  return installSelected(selected, flags, scope, config, detected);
}

function install(args) {
  const flags = parseFlags(args);
  const scope = parseScope(flags);
  const selected = selectedAgents(flags);
  if (!selected.length) {
    process.stderr.write("Choose at least one agent: --claude-code, --codex, --opencode, or --pi.\n");
    return 1;
  }
  const config = ensureUserConfig({
    configPath: flags.config,
    strength: flags.strength,
    rulesPath: flags.rules,
  });
  return installSelected(selected, flags, scope, config);
}

function installSelected(selected, flags, scope, config, detected = null) {
  const agents = {};
  let failed = false;
  for (const agent of selected) {
    try {
      const result = installAgent(agent, {
        scope,
        configPath: config.configPath,
        settingsPath: selected.length === 1 ? flags.settings : undefined,
      });
      agents[agent] = { status: "installed", ...result };
    } catch (error) {
      failed = true;
      agents[agent] = {
        status: "error",
        error: error && error.message ? error.message : String(error),
      };
    }
  }
  const object = {
    status: failed ? "partial" : "installed",
    scope,
    config: config.configPath,
    rules: config.rulesPath,
    rawDir: config.rawDir,
    metrics: config.metricsPath,
    strength: config.strength,
    agents,
  };
  if (detected) {
    object.detected = Object.fromEntries(detected.map((entry) => [entry.agent, entry]));
  }
  const lines = [`command-compressor-agent install (${scope}):`];
  for (const [agent, result] of Object.entries(agents)) {
    lines.push(`${agent}: ${result.status}${result.path ? ` (${result.path})` : `: ${result.error}`}`);
    if (agent === "codex" && result.status === "installed") {
      lines.push("codex: open /hooks to review and trust the installed hook.");
      lines.push(`codex: warning: ${result.warning}`);
    }
  }
  printJsonOrText(flags, object, lines);
  return failed ? 1 : 0;
}

function uninstall(args) {
  const flags = parseFlags(args);
  const scope = parseScope(flags);
  const selected = selectedAgents(flags);
  const targets = selected.length ? selected : AGENTS;
  const agents = {};
  let failed = false;
  for (const agent of targets) {
    try {
      const result = uninstallAgent(agent, {
        scope,
        settingsPath: targets.length === 1 ? flags.settings : undefined,
      });
      agents[agent] = { status: result.conflict ? "skipped-conflict" : "uninstalled", ...result };
    } catch (error) {
      failed = true;
      agents[agent] = {
        status: "error",
        error: error && error.message ? error.message : String(error),
      };
    }
  }
  printJsonOrText(flags, { status: failed ? "partial" : "uninstalled", scope, agents }, [
    `command-compressor-agent uninstall (${scope}):`,
    ...Object.entries(agents).map(([agent, result]) =>
      `${agent}: ${result.status}${result.changed == null ? "" : `, changed=${result.changed}`}`
    ),
  ]);
  return failed ? 1 : 0;
}

function strength(args) {
  const flags = parseFlags(args);
  const config = ensureUserConfig({ configPath: flags.config });
  const level = flags._[0];
  if (level) {
    config.strength = normalizeStrength(level);
    saveConfig(config, config.configPath);
  }
  const profiles = listStrengthProfiles().map((profile) => ({
    name: profile.name,
    description: profile.description,
  }));
  printJsonOrText(flags, { strength: config.strength, profiles }, [
    `strength: ${config.strength}`,
    ...profiles.map((profile) => `${profile.name}: ${profile.description}`),
  ]);
  return 0;
}

function gain(args) {
  const flags = parseFlags(args);
  const config = ensureUserConfig({ configPath: flags.config });
  const summary = readGain(config);
  if (flags.reset) resetGain(config);
  printJsonOrText(flags, { ...summary, metrics: config.metricsPath, reset: Boolean(flags.reset) }, [
    `observations: ${summary.observations}`,
    `compressed: ${summary.compressed_observations}`,
    `raw_tokens_est: ${summary.raw_tokens_est}`,
    `effective_tokens_est: ${summary.effective_tokens_est}`,
    `saved_tokens_est: ${summary.saved_tokens_est}`,
    `metrics: ${config.metricsPath}`,
  ]);
  return 0;
}

function status(args) {
  const flags = parseFlags(args);
  const scope = parseScope(flags);
  const config = loadConfig(flags.config);
  const agents = Object.fromEntries(
    AGENTS.map((agent) => [agent, detectAgent(agent, { scope })])
  );
  printJsonOrText(flags, { ...config, scope, agents }, [
    `config: ${config.configPath}`,
    `rules: ${config.rulesPath}`,
    `strength: ${config.strength}`,
    `rawDir: ${config.rawDir}`,
    `metrics: ${config.metricsPath}`,
    ...Object.values(agents).map((agent) =>
      `${agent.agent}: detected=${agent.detected}, installed=${agent.installed}, version=${agent.version || "unknown"}`
    ),
  ]);
  return 0;
}

function rules(args) {
  const flags = parseFlags(args);
  const config = ensureUserConfig({ configPath: flags.config });
  printJsonOrText(flags, { rules: config.rulesPath }, [`rules: ${config.rulesPath}`]);
  return 0;
}

function help(code = 0) {
  process.stdout.write(`Command Compressor for Agent\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  cca install --claude-code|--codex|--opencode|--pi [--global|--project]\n`);
  process.stdout.write(`  cca init [--global|--project] [--strength default|high|xhigh|low]\n`);
  process.stdout.write(`  cca strength [default|high|xhigh|low]\n`);
  process.stdout.write(`  cca gain [--json] [--reset]\n`);
  process.stdout.write(`  cca status [--global|--project] [--json]\n`);
  process.stdout.write(`  cca uninstall [--claude-code|--codex|--opencode|--pi] [--global|--project]\n`);
  return code;
}

function parseScope(flags) {
  if (flags.global && flags.project) throw new Error("Choose only one scope: --global or --project.");
  return flags.project ? "project" : "global";
}

function selectedAgents(flags) {
  return AGENTS.filter((agent) => Boolean(flags[agent]));
}

function printJsonOrText(flags, object, lines) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(object, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = {
  main,
  parseFlags,
};
