"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  AGENTS,
  CCA_MARKER,
  detectAgent,
  installAgent,
  isAgentInstalled,
  targetPath,
  uninstallAgent,
} = require("../src/takeover/install");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cca-${name}-`));
}

const homeDir = tempDir("install-home");
const cwd = tempDir("install-project");
const configPath = path.join(homeDir, ".command-compressor-agent", "config.json");

for (const scope of ["global", "project"]) {
  const options = { scope, homeDir, cwd, configPath };
  const claudePath = targetPath("claude-code", scope, options);
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "printf unrelated" }],
      }],
    },
    preserved: true,
  }), "utf8");

  for (const agent of AGENTS) {
    const first = installAgent(agent, options);
    assert.strictEqual(first.changed, true, `${agent} first install should change state`);
    if (agent === "codex") assert.match(first.warning, /blocked feedback/i);
    assert.strictEqual(isAgentInstalled(agent, options), true);
    const second = installAgent(agent, options);
    assert.strictEqual(second.changed, false, `${agent} install should be idempotent`);
  }

  const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  assert.strictEqual(claude.preserved, true);
  assert(claude.hooks.PostToolUse[0].hooks.some((hook) => hook.command === "printf unrelated"));
  const codexText = fs.readFileSync(targetPath("codex", scope, options), "utf8");
  assert(codexText.includes(CCA_MARKER));
  assert(codexText.includes('"statusMessage": "Compressing command output"'));
  assert(fs.readFileSync(targetPath("opencode", scope, options), "utf8").includes("tool.execute.after"));
  assert(fs.readFileSync(targetPath("pi", scope, options), "utf8").includes('pi.on("tool_result"'));

  for (const agent of AGENTS) {
    const removed = uninstallAgent(agent, options);
    assert.strictEqual(removed.changed, true, `${agent} uninstall should remove owned integration`);
    assert.strictEqual(isAgentInstalled(agent, options), false);
    assert.strictEqual(uninstallAgent(agent, options).changed, false);
  }
  const preserved = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  assert(preserved.hooks.PostToolUse[0].hooks.some((hook) => hook.command === "printf unrelated"));
}

{
  const conflictHome = tempDir("install-conflict");
  const options = { scope: "global", homeDir: conflictHome, configPath };
  const pluginPath = targetPath("opencode", "global", options);
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, "export const UserPlugin = async () => ({});\n", "utf8");
  assert.throws(() => installAgent("opencode", options), /Refusing to overwrite/);
  const removed = uninstallAgent("opencode", options);
  assert.strictEqual(removed.changed, false);
  assert.strictEqual(removed.conflict, true);
  assert(fs.existsSync(pluginPath));
}

{
  const binDir = tempDir("detect-bin");
  for (const [agent, executable] of Object.entries({
    "claude-code": "claude",
    codex: "codex",
    opencode: "opencode",
    pi: "pi",
  })) {
    const pathname = path.join(binDir, executable);
    const body = agent === "codex"
      ? '#!/bin/sh\nif [ "$1" = "features" ]; then printf "hooks stable true\\n"; else printf "codex 1.0.0\\n"; fi\n'
      : `#!/bin/sh\nprintf "${executable} 1.0.0\\n"\n`;
    fs.writeFileSync(pathname, body, { encoding: "utf8", mode: 0o755 });
  }
  for (const agent of AGENTS) {
    const detected = detectAgent(agent, {
      envPath: binDir,
      scope: "global",
      homeDir,
    });
    assert.strictEqual(detected.detected, true);
    assert.strictEqual(detected.supported, true);
    if (agent === "codex") {
      assert.strictEqual(detected.replacementSupport, "supported-via-block-feedback");
      assert.strictEqual(detected.supportBlocker, null);
    }
    assert(detected.version.includes("1.0.0"));
  }
}

console.log("install tests passed");
