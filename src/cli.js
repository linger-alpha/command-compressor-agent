"use strict";

const { ensureUserConfig, loadConfig, saveConfig } = require("./config/paths");
const { listStrengthProfiles, normalizeStrength } = require("./config/strength");
const { readGain, resetGain } = require("./evaluation/store");
const { installClaudeHook, uninstallClaudeHook } = require("./takeover/install");
const { runClaudeHook } = require("./takeover/claude-code");

async function main(argv) {
  const command = argv[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "hook" && argv[1] === "claude-code") {
    await runClaudeHook();
    return 0;
  }
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
  const scope = flags.project ? "project" : "global";
  const config = ensureUserConfig({
    configPath: flags.config,
    strength: flags.strength,
    rulesPath: flags.rules,
  });
  const installed = installClaudeHook({
    scope,
    settingsPath: flags.settings,
    configPath: config.configPath,
  });
  printJsonOrText(flags, {
    status: "installed",
    scope,
    settings: installed.settingsPath,
    command: installed.command,
    config: config.configPath,
    rules: config.rulesPath,
    rawDir: config.rawDir,
    metrics: config.metricsPath,
    strength: config.strength,
  }, [
    `Installed command-compressor-agent for Claude Code (${scope}).`,
    `settings: ${installed.settingsPath}`,
    `config: ${config.configPath}`,
    `rules: ${config.rulesPath}`,
    `strength: ${config.strength}`,
  ]);
  return 0;
}

function uninstall(args) {
  const flags = parseFlags(args);
  const scope = flags.project ? "project" : "global";
  const removed = uninstallClaudeHook({ scope, settingsPath: flags.settings });
  printJsonOrText(flags, { status: "uninstalled", scope, settings: removed.settingsPath, changed: removed.changed }, [
    `Uninstalled command-compressor-agent hook (${scope}).`,
    `settings: ${removed.settingsPath}`,
    `changed: ${removed.changed}`,
  ]);
  return 0;
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
    minRawTokens: profile.minRawTokens,
    strongOnly: profile.strongOnly,
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
  const config = loadConfig(flags.config);
  printJsonOrText(flags, config, [
    `config: ${config.configPath}`,
    `rules: ${config.rulesPath}`,
    `strength: ${config.strength}`,
    `rawDir: ${config.rawDir}`,
    `metrics: ${config.metricsPath}`,
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
  process.stdout.write(`  cca init --global [--strength default|high|xhigh|low]\n`);
  process.stdout.write(`  cca strength [default|high|xhigh|low]\n`);
  process.stdout.write(`  cca gain [--json] [--reset]\n`);
  process.stdout.write(`  cca status [--json]\n`);
  process.stdout.write(`  cca uninstall --global\n`);
  process.stdout.write(`  cca hook claude-code\n`);
  return code;
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
};
