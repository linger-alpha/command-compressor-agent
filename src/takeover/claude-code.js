"use strict";

const { compressObservation, failOpen, observationFromPayload } = require("../compression/compressor");
const { loadConfig } = require("../config/paths");
const { recordCompressionEvent } = require("../evaluation/store");

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

function handleClaudePostToolUse(payload, options = {}) {
  const config = options.config || loadConfig(options.configPath);
  const observation = observationFromPayload(payload);
  const result = compressObservation(observation, {
    rulesPath: config.rulesPath,
    rawDir: config.rawDir,
    strength: config.strength,
  });
  recordCompressionEvent(config, observation, result);

  const hookOutput = {
    hookEventName: "PostToolUse",
  };
  if (result.changed) {
    hookOutput.additionalContext = [
      "Command output was replaced by command-compressor.",
      `raw_tokens_est=${result.rawTokensEst},`,
      `compressed_tokens_est=${result.compressedTokensEst},`,
      `critical=${String(result.critical)},`,
      `changed=${String(result.changed)},`,
      `strength=${result.strength},`,
      `rules=${result.ruleIds.join("+")},`,
      `raw_ref=${result.rawRef}.`,
    ].join(" ");
    const toolResponse = payload.tool_response && typeof payload.tool_response === "object" ? payload.tool_response : {};
    hookOutput.updatedToolOutput = {
      stdout: result.text,
      stderr: "",
      interrupted: Boolean(toolResponse.interrupted),
      isImage: Boolean(toolResponse.isImage),
    };
  }
  return { hookSpecificOutput: hookOutput };
}

async function runClaudeHook() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(`${JSON.stringify(handleClaudePostToolUse(payload))}\n`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(failOpen(message))}\n`);
  }
}

module.exports = {
  handleClaudePostToolUse,
  readStdin,
  runClaudeHook,
};
