"use strict";

const { estimateTokens } = require("../compression/utils");

const MIN_REPLACEMENT_RAW_TOKENS = 256;
const MIN_REPLACEMENT_SAVED_TOKENS = 64;
const MIN_REPLACEMENT_SAVINGS_RATIO = 0.15;

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

function replacementIsWorthwhile(observation, text) {
  const originalOutput = [observation.stdout, observation.stderr]
    .filter(Boolean)
    .join("\n");
  const rawTokens = estimateTokens(originalOutput);
  const replacementTokens = estimateTokens(text);
  const savedTokens = rawTokens - replacementTokens;
  return rawTokens >= MIN_REPLACEMENT_RAW_TOKENS &&
    savedTokens >= MIN_REPLACEMENT_SAVED_TOKENS &&
    savedTokens / rawTokens >= MIN_REPLACEMENT_SAVINGS_RATIO;
}

module.exports = {
  CODEX_BLOCK_PREFIX,
  MIN_REPLACEMENT_RAW_TOKENS,
  MIN_REPLACEMENT_SAVED_TOKENS,
  MIN_REPLACEMENT_SAVINGS_RATIO,
  STANDARD_REPLACEMENT_PREFIX,
  codexReplacementText,
  replacementIsWorthwhile,
  standardReplacementText,
};
