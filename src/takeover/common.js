"use strict";

const { compressObservation } = require("../compression/compressor");
const { loadConfig } = require("../config/paths");
const { recordCompressionEvent } = require("../evaluation/store");
const { asInt, objectOrEmpty } = require("../compression/utils");

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => textContent(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object") return String(value);
  if (typeof value.text === "string") return value.text;
  if (typeof value.output === "string") return value.output;
  if (typeof value.stdout === "string") return value.stdout;
  if (value.content != null) return textContent(value.content);
  return "";
}

function normalizedResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { stdout: textContent(value), stderr: "", exitCode: null };
  }
  return {
    stdout: textContent(value.stdout != null ? value.stdout : value.output != null ? value.output : value.content),
    stderr: textContent(value.stderr),
    exitCode: asInt(value.exit_code, value.exitCode, value.code, value.status),
  };
}

function normalizedObservation(fields = {}) {
  return {
    command: typeof fields.command === "string" ? fields.command : "",
    stdout: typeof fields.stdout === "string" ? fields.stdout : "",
    stderr: typeof fields.stderr === "string" ? fields.stderr : "",
    exitCode: fields.exitCode == null ? null : asInt(fields.exitCode),
    agent: String(fields.agent || "unknown"),
    toolName: String(fields.toolName || "Bash"),
  };
}

function commandFromInput(value) {
  const input = objectOrEmpty(value);
  const args = objectOrEmpty(input.args);
  if (typeof input.command === "string") return input.command;
  if (typeof args.command === "string") return args.command;
  return "";
}

function compressForAdapter(observation, options = {}) {
  const config = options.config || loadConfig(options.configPath);
  const compressor = options.compress || compressObservation;
  const result = compressor(observation, {
    rulesPath: config.rulesPath,
    rawDir: config.rawDir,
    strength: config.strength,
  });
  if (options.record !== false) recordCompressionEvent(config, observation, result);
  return result;
}

module.exports = {
  commandFromInput,
  compressForAdapter,
  normalizedObservation,
  normalizedResponse,
  readStdin,
  textContent,
};
