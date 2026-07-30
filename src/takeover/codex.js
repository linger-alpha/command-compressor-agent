"use strict";

const {
  commandFromInput,
  compressForAdapter,
  normalizedObservation,
  normalizedResponse,
  readStdin,
} = require("./common");

const CODEX_BLOCK_PREFIX = [
  "The command already ran; Codex marks this result as blocked only because its output was replaced.",
  "Below is compressed output. If required information is missing, read raw_ref instead of rerunning the command.",
  "",
].join("\n");

function observationFromCodex(payload) {
  const response = normalizedResponse(payload.tool_response);
  return normalizedObservation({
    command: commandFromInput(payload.tool_input),
    ...response,
    agent: "codex",
    toolName: payload.tool_name || "Bash",
  });
}

function handleCodexPostToolUse(payload, options = {}) {
  const observation = observationFromCodex(payload);
  const result = compressForAdapter(observation, options);
  if (!result.changed) return {};
  return {
    decision: "block",
    reason: `${CODEX_BLOCK_PREFIX}${result.text}`,
  };
}

async function runCodexHook() {
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    process.stdout.write(`${JSON.stringify(handleCodexPostToolUse(payload))}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

module.exports = {
  CODEX_BLOCK_PREFIX,
  handleCodexPostToolUse,
  observationFromCodex,
  runCodexHook,
};
