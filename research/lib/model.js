"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ALLOWED_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function buildCodexArgs(options) {
  const effort = String(options.effort || "");
  if (!ALLOWED_EFFORTS.has(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--model",
    String(options.model),
    "--config",
    `model_reasoning_effort="${effort}"`,
    "--output-schema",
    path.resolve(options.schemaPath),
    "--output-last-message",
    path.resolve(options.outputPath),
    "--color",
    "never",
    "-",
  ];
}

function runCodexStructured(options) {
  const prompt = String(options.prompt || "");
  const maxPromptChars = Number(options.maxPromptChars || 200000);
  if (prompt.length > maxPromptChars) {
    throw new Error(`Bounded model prompt exceeded ${maxPromptChars} characters`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-research-model-"));
  const outputPath = path.join(tempDir, "result.json");
  const args = buildCodexArgs({
    ...options,
    outputPath,
  });
  try {
    const result = childProcess.spawnSync(options.codexBin || "codex", args, {
      cwd: options.cwd,
      encoding: "utf8",
      input: prompt,
      maxBuffer: 10 * 1024 * 1024,
      timeout: Number(options.timeoutMs || 30 * 60 * 1000),
      env: options.env || process.env,
      shell: false,
    });
    if (result.error || result.status !== 0) {
      const detail = `${result.stderr || ""}${result.stdout || ""}`.trim().slice(-3000);
      throw new Error(`Codex structured run failed (${result.status}): ${detail}`);
    }
    const text = fs.readFileSync(outputPath, "utf8");
    return JSON.parse(text);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  ALLOWED_EFFORTS,
  buildCodexArgs,
  runCodexStructured,
};
