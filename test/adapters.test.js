"use strict";

const assert = require("assert");

const {
  handleClaudePostToolUse,
  observationFromClaude,
} = require("../src/takeover/claude-code");
const {
  CODEX_BLOCK_PREFIX,
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
const {
  MIN_REPLACEMENT_RAW_TOKENS,
  MIN_REPLACEMENT_SAVED_TOKENS,
  MIN_REPLACEMENT_SAVINGS_RATIO,
  STANDARD_REPLACEMENT_PREFIX,
  replacementIsWorthwhile,
} = require("../src/takeover/presentation");

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

{
  assert.strictEqual(MIN_REPLACEMENT_RAW_TOKENS, 256);
  assert.strictEqual(MIN_REPLACEMENT_SAVED_TOKENS, 64);
  assert.strictEqual(MIN_REPLACEMENT_SAVINGS_RATIO, 0.15);
  const observation = (tokens) => ({
    stdout: "x".repeat(tokens * 4),
    stderr: "",
  });
  const replacement = (tokens) => "y".repeat(tokens * 4);
  assert.strictEqual(
    replacementIsWorthwhile(observation(255), replacement(1)),
    false,
    "short output must remain direct even when highly compressible"
  );
  assert.strictEqual(
    replacementIsWorthwhile(observation(400), replacement(340)),
    false,
    "saving fewer than 64 tokens is not worthwhile"
  );
  assert.strictEqual(
    replacementIsWorthwhile(observation(1000), replacement(900)),
    false,
    "saving less than 15% is not worthwhile"
  );
  assert.strictEqual(
    replacementIsWorthwhile(observation(400), replacement(320)),
    true
  );
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
  const response = handleClaudePostToolUse({
    ...payload,
    tool_response: {
      ...payload.tool_response,
      stdout: "hello\n".repeat(200),
    },
  }, options(true, observations));
  assert.strictEqual(
    response.hookSpecificOutput.updatedToolOutput.stdout,
    `${STANDARD_REPLACEMENT_PREFIX}[compressed output]`
  );
  assert.strictEqual(response.hookSpecificOutput.updatedToolOutput.interrupted, true);
  assert.strictEqual(observations[0].agent, "claude-code");
  const tooShort = handleClaudePostToolUse(payload, options(true, []));
  assert.strictEqual(tooShort.hookSpecificOutput.updatedToolOutput, undefined);
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
  assert.deepStrictEqual(
    handleCodexPostToolUse(payload, options(true, [])),
    {},
    "Codex must not turn a short result into blocked feedback"
  );
  const changed = handleCodexPostToolUse({
    ...payload,
    tool_response: { output: "building\n".repeat(200), exitCode: 2 },
  }, options(true, []));
  assert.deepStrictEqual(changed, {
    decision: "block",
    reason: `${CODEX_BLOCK_PREFIX}[compressed output]`,
  });
  assert.match(changed.reason, /command already ran/i);
  assert.match(changed.reason, /search the raw_ref below locally instead of rerunning/i);
  assert.deepStrictEqual(handleCodexPostToolUse(payload, options(false, [])), {});
  assert.throws(
    () => handleCodexPostToolUse(payload, { config: {}, record: false, compress() { throw new Error("boom"); } }),
    /boom/
  );
}

{
  const input = { tool: "bash", args: { command: "npm install" } };
  const output = {
    title: "Install",
    output: "Downloading\n".repeat(200),
    metadata: { exitCode: 0, keep: true },
  };
  assert.strictEqual(observationFromOpenCode(input, output).command, "npm install");
  const response = handleOpenCodeToolAfter(input, output, options(true, []));
  assert.strictEqual(response.changed, true);
  assert.strictEqual(
    output.output,
    `${STANDARD_REPLACEMENT_PREFIX}[compressed output]`
  );
  assert.deepStrictEqual(output.metadata, { exitCode: 0, keep: true });
  const short = { output: "Downloading", metadata: { exitCode: 0 } };
  assert.strictEqual(
    handleOpenCodeToolAfter(input, short, options(true, [])).changed,
    false
  );
  assert.strictEqual(short.output, "Downloading");
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
    content: [{ type: "text", text: "running tests\n".repeat(200) }],
    details: { exitCode: 1, preserved: true },
    isError: true,
  };
  assert.strictEqual(
    observationFromPi(event).stdout,
    "running tests\n".repeat(200)
  );
  const patch = handlePiToolResult(event, options(true, []));
  assert.deepStrictEqual(patch, {
    content: [{
      type: "text",
      text: `${STANDARD_REPLACEMENT_PREFIX}[compressed output]`,
    }],
  });
  assert.strictEqual(patch.details, undefined, "Pi adapter must omit details so Pi preserves it");
  assert.strictEqual(handlePiToolResult({
    ...event,
    content: [{ type: "text", text: "short" }],
  }, options(true, [])), undefined);
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
