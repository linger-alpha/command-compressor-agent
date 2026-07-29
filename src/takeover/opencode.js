"use strict";

const { asInt, objectOrEmpty } = require("../compression/utils");
const {
  commandFromInput,
  compressForAdapter,
  normalizedObservation,
  textContent,
} = require("./common");

function observationFromOpenCode(input, output) {
  const metadata = objectOrEmpty(output && output.metadata);
  return normalizedObservation({
    command: commandFromInput(input),
    stdout: textContent(output && output.output),
    stderr: textContent(output && output.stderr),
    exitCode: asInt(metadata.exitCode, metadata.exit_code, output && output.exitCode),
    agent: "opencode",
    toolName: input && input.tool ? input.tool : "bash",
  });
}

function handleOpenCodeToolAfter(input, output, options = {}) {
  if (!input || String(input.tool || "").toLowerCase() !== "bash") return { changed: false };
  if (!output || typeof output !== "object") return { changed: false };
  try {
    const observation = observationFromOpenCode(input, output);
    const result = compressForAdapter(observation, options);
    if (result.changed) output.output = result.text;
    return { changed: result.changed, result };
  } catch (error) {
    return {
      changed: false,
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = {
  handleOpenCodeToolAfter,
  observationFromOpenCode,
};
