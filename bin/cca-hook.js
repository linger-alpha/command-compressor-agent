#!/usr/bin/env node
"use strict";

const { runClaudeHook } = require("../src/takeover/claude-code");
const { runCodexHook } = require("../src/takeover/codex");

const agent = process.argv[2] || "claude-code";
const runner = agent === "codex" ? runCodexHook : runClaudeHook;

runner().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  if (agent === "codex") process.stdout.write("{}\n");
  else {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `command-compressor fail-open: ${message}`,
      },
    })}\n`);
  }
});
