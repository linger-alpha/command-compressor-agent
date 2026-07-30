"use strict";

const { asInt, objectOrEmpty } = require("../compression/utils");
const {
  commandFromInput,
  compressForPresentedAdapter,
  normalizedObservation,
  textContent,
} = require("./common");
const {
  standardReplacementText,
} = require("./presentation");

function observationFromPi(event) {
  const details = objectOrEmpty(event.details);
  return normalizedObservation({
    command: commandFromInput(event.input),
    stdout: textContent(event.content),
    stderr: "",
    exitCode: asInt(details.exitCode, details.exit_code, event.isError ? 1 : null),
    agent: "pi",
    toolName: event.toolName || "bash",
  });
}

function handlePiToolResult(event, options = {}) {
  if (!event || String(event.toolName || "").toLowerCase() !== "bash") return undefined;
  try {
    const observation = observationFromPi(event);
    const { result, replacementText } = compressForPresentedAdapter(
      observation,
      options,
      standardReplacementText
    );
    if (!result.changed) return undefined;
    return {
      content: [{ type: "text", text: replacementText }],
    };
  } catch {
    return undefined;
  }
}

module.exports = {
  handlePiToolResult,
  observationFromPi,
};
