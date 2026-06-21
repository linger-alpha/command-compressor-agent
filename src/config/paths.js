"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { normalizeStrength } = require("./strength");

function packageRoot() {
  return path.resolve(__dirname, "..", "..");
}

function userDir() {
  return path.join(os.homedir(), ".command-compressor-agent");
}

function defaultConfigPath() {
  return process.env.CCA_CONFIG_PATH || path.join(userDir(), "config.json");
}

function defaultRulesPath() {
  return path.join(userDir(), "rules.json");
}

function bundledRulesPath() {
  return path.join(packageRoot(), "rules", "default-rules.json");
}

function defaultRawDir() {
  return path.join(userDir(), "raw");
}

function defaultMetricsPath() {
  return path.join(userDir(), "gain.jsonl");
}

function defaultClaudeSettingsPath(scope = "global") {
  if (scope === "project") return path.join(process.cwd(), ".claude", "settings.local.json");
  return path.join(os.homedir(), ".claude", "settings.json");
}

function defaultConfig(overrides = {}) {
  const rulesPath = overrides.rulesPath || defaultRulesPath();
  return {
    version: 1,
    strength: normalizeStrength(overrides.strength),
    rulesPath,
    rawDir: overrides.rawDir || defaultRawDir(),
    metricsPath: overrides.metricsPath || defaultMetricsPath(),
  };
}

function readJson(pathname, fallback) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadConfig(configPath = defaultConfigPath()) {
  const existed = fs.existsSync(configPath);
  const loaded = readJson(configPath, {});
  const config = defaultConfig(loaded && typeof loaded === "object" ? loaded : {});
  const customBaseDir = configPath !== defaultConfigPath() ? path.dirname(configPath) : null;
  if (customBaseDir && !existed) {
    config.rulesPath = path.join(customBaseDir, "rules.json");
    config.rawDir = path.join(customBaseDir, "raw");
    config.metricsPath = path.join(customBaseDir, "gain.jsonl");
  }
  if (loaded && typeof loaded === "object") {
    if (loaded.rulesPath) config.rulesPath = String(loaded.rulesPath);
    if (loaded.rawDir) config.rawDir = String(loaded.rawDir);
    if (loaded.metricsPath) config.metricsPath = String(loaded.metricsPath);
  }
  config.configPath = configPath;
  return config;
}

function saveConfig(config, configPath = config.configPath || defaultConfigPath()) {
  const copy = {
    version: 1,
    strength: normalizeStrength(config.strength),
    rulesPath: config.rulesPath || defaultRulesPath(),
    rawDir: config.rawDir || defaultRawDir(),
    metricsPath: config.metricsPath || defaultMetricsPath(),
  };
  writeJson(configPath, copy);
  return copy;
}

function ensureUserConfig(options = {}) {
  const configPath = options.configPath || defaultConfigPath();
  const existed = fs.existsSync(configPath);
  const current = loadConfig(configPath);
  const customBaseDir = options.configPath ? path.dirname(configPath) : null;
  const next = {
    ...current,
    strength: normalizeStrength(options.strength || current.strength),
    rulesPath: options.rulesPath || current.rulesPath || (customBaseDir ? path.join(customBaseDir, "rules.json") : defaultRulesPath()),
    rawDir: options.rawDir || current.rawDir || (customBaseDir ? path.join(customBaseDir, "raw") : defaultRawDir()),
    metricsPath: options.metricsPath || current.metricsPath || (customBaseDir ? path.join(customBaseDir, "gain.jsonl") : defaultMetricsPath()),
  };
  if (customBaseDir && !existed) {
    if (!options.rulesPath) next.rulesPath = path.join(customBaseDir, "rules.json");
    if (!options.rawDir) next.rawDir = path.join(customBaseDir, "raw");
    if (!options.metricsPath) next.metricsPath = path.join(customBaseDir, "gain.jsonl");
  }
  fs.mkdirSync(path.dirname(next.rulesPath), { recursive: true });
  if (!fs.existsSync(next.rulesPath)) fs.copyFileSync(bundledRulesPath(), next.rulesPath);
  saveConfig(next, configPath);
  return loadConfig(configPath);
}

module.exports = {
  bundledRulesPath,
  defaultClaudeSettingsPath,
  defaultConfig,
  defaultConfigPath,
  defaultMetricsPath,
  defaultRawDir,
  defaultRulesPath,
  ensureUserConfig,
  loadConfig,
  packageRoot,
  saveConfig,
  userDir,
  writeJson,
};
