"use strict";

const assert = require("assert");

const {
  handleClaudePostToolUse,
  observationFromClaude,
} = require("../src/takeover/claude-code");
const {
  handleCodexPostToolUse,
  observationFromCodex,
} = require("../src/takeover/codex");
const {
  handleOpenCodeToolAfter,
  observationFromOpenCode,
} = require("../src/takeover/opencode");
const {
  handlePiToolResult,
  observationFromPi,
} = require("../src/takeover/pi");

function result(changed) {
  return {
    changed,
    text: changed ? "[compressed output]" : "[raw output]",
    rawTokensEst: 1000,
    compressedTokensEst: changed ? 100 : 1000,
    critical: false,
    strength: "default",
    ruleIds: ["test"],
    rawRef: "/tmp/raw.log",
  };
}

function options(changed, observations) {
  return {
    config: {},
    record: false,
    compress(observation) {
      observations.push(observation);
      return result(changed);
    },
  };
}

{
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "printf hello" },
    tool_response: { stdout: "hello", stderr: "warn", exit_code: 0, interrupted: true },
  };
  assert.deepStrictEqual(observationFromClaude(payload), {
    command: "printf hello",
    stdout: "hello",
    stderr: "warn",
    exitCode: 0,
    agent: "claude-code",
    toolName: "Bash",
  });
  const observations = [];
  const response = handleClaudePostToolUse(payload, options(true, observations));
  assert.strictEqual(response.hookSpecificOutput.updatedToolOutput.stdout, "[compressed output]");
  assert.strictEqual(response.hookSpecificOutput.updatedToolOutput.interrupted, true);
  assert.strictEqual(observations[0].agent, "claude-code");
  const unchanged = handleClaudePostToolUse(payload, options(false, []));
  assert.strictEqual(unchanged.hookSpecificOutput.updatedToolOutput, undefined);
}

{
  const payload = {
    tool_name: "Bash",
    tool_input: { command: "make" },
    tool_response: { output: "building", exitCode: 2 },
  };
  assert.deepStrictEqual(observationFromCodex(payload), {
    command: "make",
    stdout: "building",
    stderr: "",
    exitCode: 2,
    agent: "codex",
    toolName: "Bash",
  });
  const changed = handleCodexPostToolUse(payload, options(true, []));
  assert.deepStrictEqual(changed, { continue: false, stopReason: "[compressed output]" });
  assert.deepStrictEqual(handleCodexPostToolUse(payload, options(false, [])), {});
  assert.throws(
    () => handleCodexPostToolUse(payload, { config: {}, record: false, compress() { throw new Error("boom"); } }),
    /boom/
  );
}

{
  const input = { tool: "bash", args: { command: "npm install" } };
  const output = { title: "Install", output: "Downloading", metadata: { exitCode: 0, keep: true } };
  assert.strictEqual(observationFromOpenCode(input, output).command, "npm install");
  const response = handleOpenCodeToolAfter(input, output, options(true, []));
  assert.strictEqual(response.changed, true);
  assert.strictEqual(output.output, "[compressed output]");
  assert.deepStrictEqual(output.metadata, { exitCode: 0, keep: true });
  const ignored = { output: "unchanged" };
  handleOpenCodeToolAfter({ tool: "read" }, ignored, options(true, []));
  assert.strictEqual(ignored.output, "unchanged");
  const failed = { output: "original" };
  handleOpenCodeToolAfter({ tool: "bash", args: { command: "x" } }, failed, {
    config: {},
    record: false,
    compress() {
      throw new Error("boom");
    },
  });
  assert.strictEqual(failed.output, "original");
}

{
  const event = {
    toolName: "bash",
    input: { command: "cargo test" },
    content: [{ type: "text", text: "running tests" }],
    details: { exitCode: 1, preserved: true },
    isError: true,
  };
  assert.strictEqual(observationFromPi(event).stdout, "running tests");
  const patch = handlePiToolResult(event, options(true, []));
  assert.deepStrictEqual(patch, { content: [{ type: "text", text: "[compressed output]" }] });
  assert.strictEqual(patch.details, undefined, "Pi adapter must omit details so Pi preserves it");
  assert.strictEqual(handlePiToolResult(event, options(false, [])), undefined);
  assert.strictEqual(handlePiToolResult({ toolName: "read" }, options(true, [])), undefined);
  assert.strictEqual(handlePiToolResult(event, {
    config: {},
    record: false,
    compress() {
      throw new Error("boom");
    },
  }), undefined);
}

console.log("adapter tests passed");
