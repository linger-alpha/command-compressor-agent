#!/usr/bin/env node
"use strict";

const { runClaudeHook } = require("../src/takeover/claude-code");

runClaudeHook().catch((error) => {
  const message = error && error.message ? error.message : String(error);
  const failOpen = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `command-compressor fail-open: ${message}`,
    },
  };
  process.stdout.write(`${JSON.stringify(failOpen)}\n`);
});
