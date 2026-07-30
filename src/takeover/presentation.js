"use strict";

const { estimateTokens } = require("../compression/utils");

const STANDARD_REPLACEMENT_PREFIX = [
  "[CCA compressed this command output.]",
  "[If needed, search the raw_ref below locally instead of rerunning the command.]",
  "",
].join("\n");

const CODEX_BLOCK_PREFIX = [
  "The command already ran. Codex labels this result as blocked only because CCA replaced its output.",
  "If needed, search the raw_ref below locally instead of rerunning the command.",
  "",
].join("\n");

function standardReplacementText(result) {
  return `${STANDARD_REPLACEMENT_PREFIX}${result.text}`;
}

function codexReplacementText(result) {
  return `${CODEX_BLOCK_PREFIX}${result.text}`;
}

function replacementIsSmaller(observation, text) {
  const originalOutput = [observation.stdout, observation.stderr]
    .filter(Boolean)
    .join("\n");
  return estimateTokens(text) < estimateTokens(originalOutput);
}

module.exports = {
  CODEX_BLOCK_PREFIX,
  STANDARD_REPLACEMENT_PREFIX,
  codexReplacementText,
  replacementIsSmaller,
  standardReplacementText,
};
