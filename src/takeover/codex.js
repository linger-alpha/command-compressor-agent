"use strict";

const {
  commandFromInput,
  compressForAdapter,
  normalizedObservation,
  normalizedResponse,
  readStdin,
} = require("./common");
const {
  CODEX_BLOCK_PREFIX,
  codexReplacementText,
  replacementIsSmaller,
} = require("./presentation");

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
  const result = compressForAdapter(observation, {
    ...options,
    acceptReplacement(candidate) {
      return replacementIsSmaller(
        observation,
        codexReplacementText(candidate)
      );
    },
  });
  if (!result.changed) return {};
  return {
    decision: "block",
    reason: codexReplacementText(result),
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
