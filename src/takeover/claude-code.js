"use strict";

const { objectOrEmpty } = require("../compression/utils");
const {
  commandFromInput,
  compressForAdapter,
  normalizedObservation,
  normalizedResponse,
  readStdin,
} = require("./common");

function observationFromClaude(payload) {
  const response = normalizedResponse(payload.tool_response || payload.output || payload.tool_output);
  return normalizedObservation({
    command: commandFromInput(payload.tool_input || payload.input) || payload.command,
    ...response,
    agent: "claude-code",
    toolName: payload.tool_name || "Bash",
  });
}

function handleClaudePostToolUse(payload, options = {}) {
  const observation = observationFromClaude(payload);
  const result = compressForAdapter(observation, options);

  const hookOutput = {
    hookEventName: "PostToolUse",
  };
  if (result.changed) {
    const toolResponse = objectOrEmpty(payload.tool_response);
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
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `command-compressor fail-open: ${message}`,
      },
    })}\n`);
  }
}

module.exports = {
  handleClaudePostToolUse,
  observationFromClaude,
  readStdin,
  runClaudeHook,
};
