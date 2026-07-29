#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function textContent(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);
  if (typeof value.text === "string") return value.text;
  if (typeof value.output === "string") return value.output;
  if (typeof value.stdout === "string") return value.stdout;
  return value.content == null ? "" : textContent(value.content);
}

function firstInteger(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isInteger(number)) return number;
  }
  return null;
}

function observationFromPayload(payload) {
  const input = payload && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const args = input && typeof input.args === "object" ? input.args : {};
  const response = payload ? payload.tool_response : null;
  const responseObject = response && typeof response === "object" && !Array.isArray(response)
    ? response
    : null;
  return {
    schema_version: 1,
    command: typeof input.command === "string"
      ? input.command
      : typeof args.command === "string"
        ? args.command
        : "",
    stdout: responseObject
      ? textContent(
        responseObject.stdout != null
          ? responseObject.stdout
          : responseObject.output != null
            ? responseObject.output
            : responseObject.content
      )
      : textContent(response),
    stderr: responseObject ? textContent(responseObject.stderr) : "",
    exit_code: firstInteger(
      responseObject && responseObject.exit_code,
      responseObject && responseObject.exitCode,
      responseObject && responseObject.code,
      responseObject && responseObject.status
    ),
    agent: "codex",
    tool_name: String(payload && payload.tool_name || "Bash"),
  };
}

function appendObservation(pathname, observation) {
  if (!pathname) return;
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.appendFileSync(pathname, `${JSON.stringify(observation)}\n`, "utf8");
}

function handlePayload(payload, env = process.env) {
  appendObservation(env.CCA_OBSERVATIONS_PATH, observationFromPayload(payload));
  const arm = String(env.CCA_BENCHMARK_ARM || "none");
  if (arm === "none") return {};
  const runtimeRoot = path.resolve(env.CCA_RUNTIME_ROOT || path.resolve(__dirname, "..", ".."));
  const { handleCodexPostToolUse } = require(path.join(runtimeRoot, "src", "takeover", "codex.js"));
  return handleCodexPostToolUse(payload, {
    configPath: env.CCA_CONFIG_PATH,
  });
}

function main() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const payload = raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(`${JSON.stringify(handlePayload(payload))}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

if (require.main === module) main();

module.exports = {
  handlePayload,
  observationFromPayload,
};
