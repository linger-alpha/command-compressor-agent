"use strict";

const {
  commandFromInput,
  compressForPresentedAdapter,
  normalizedObservation,
  normalizedResponse,
  readStdin,
} = require("./common");
const {
  CODEX_BLOCK_PREFIX,
  codexReplacementText,
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
  const { result, replacementText } = compressForPresentedAdapter(
    observation,
    options,
    codexReplacementText
  );
  if (!result.changed) return {};
  return {
    decision: "block",
    reason: replacementText,
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
