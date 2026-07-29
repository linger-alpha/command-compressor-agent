#!/usr/bin/env node

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-agent-hooks-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(project, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
  PI_OFFLINE: "1",
  NO_COLOR: "1",
};

function run(executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, {
    cwd: options.cwd || project,
    env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout || 60_000,
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${executable} ${args.join(" ")} failed`,
      `status=${result.status}`,
      result.error ? String(result.error) : "",
      result.stdout || "",
      result.stderr || "",
    ].filter(Boolean).join("\n"));
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function assertCompressed(before, after, label) {
  assert.equal(typeof after, "string", `${label} must return text`);
  assert(after.length < before.length, `${label} did not reduce the noisy output`);
  assert(after.includes("raw_ref"), `${label} did not retain the raw fallback reference`);
}

function invokeCommandHook(command, payload) {
  const result = run("bash", ["-lc", command], {
    input: `${JSON.stringify(payload)}\n`,
  });
  return JSON.parse(result.stdout.trim());
}

async function probeOpenCodeServer() {
  const port = 41963;
  const server = childProcess.spawn("opencode", [
    "--print-logs",
    "--log-level",
    "DEBUG",
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let health;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (server.exitCode != null) {
        throw new Error(`OpenCode server exited early (${server.exitCode})\n${stdout}\n${stderr}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // Server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(health && health.healthy, `OpenCode health probe failed\n${stdout}\n${stderr}`);
    const configResponse = await fetch(
      `http://127.0.0.1:${port}/config?directory=${encodeURIComponent(project)}`,
      { signal: AbortSignal.timeout(60_000) }
    );
    assert.equal(configResponse.ok, true, `OpenCode config endpoint failed: ${configResponse.status}`);
    await configResponse.text();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    throw new Error([
      `OpenCode server probe failed: ${error && error.message ? error.message : String(error)}`,
      "stdout:",
      stdout,
      "stderr:",
      stderr,
    ].join("\n"));
  } finally {
    if (server.exitCode == null) {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (server.exitCode == null) {
        server.kill("SIGKILL");
        await Promise.race([
          exited,
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
      }
    }
  }
  return { health, stdout, stderr };
}

const init = run(process.execPath, [
  path.join(repoRoot, "bin", "cca.js"),
  "init",
  "--global",
  "--json",
]);
const initResult = JSON.parse(init.stdout);
assert.equal(initResult.status, "installed");
for (const agent of ["claude-code", "codex", "opencode", "pi"]) {
  assert.equal(initResult.agents[agent].status, "installed", `${agent} was not installed`);
  assert.equal(initResult.detected[agent].detected, true, `${agent} was not detected`);
}

const secondInit = JSON.parse(run(process.execPath, [
  path.join(repoRoot, "bin", "cca.js"),
  "init",
  "--global",
  "--json",
]).stdout);
for (const agent of ["claude-code", "codex", "opencode", "pi"]) {
  assert.equal(secondInit.agents[agent].changed, false, `${agent} install was not idempotent`);
}

const paths = {
  claude: path.join(home, ".claude", "settings.json"),
  codex: path.join(home, ".codex", "hooks.json"),
  opencode: path.join(home, ".config", "opencode", "plugins", "command-compressor-agent.js"),
  pi: path.join(home, ".pi", "agent", "extensions", "command-compressor-agent.ts"),
};
for (const pathname of Object.values(paths)) {
  assert(fs.existsSync(pathname), `missing installed integration: ${pathname}`);
}

const claudeDoctor = run("claude", ["doctor"], { timeout: 90_000 });
assert.match(
  `${claudeDoctor.stdout}\n${claudeDoctor.stderr}`,
  /No installation issues found\./
);
const openCodeStartup = run("opencode", [
  "--print-logs",
  "--log-level",
  "DEBUG",
  "debug",
  "startup",
]);
const openCodeServer = await probeOpenCodeServer();
assert(
  !/failed to load.*command-compressor|command-compressor.*(?:error|failed)/i.test(
    `${openCodeServer.stdout}\n${openCodeServer.stderr}`
  ),
  `OpenCode reported a CCA plugin load error\n${openCodeServer.stdout}\n${openCodeServer.stderr}`
);
if (process.env.CCA_SMOKE_VERBOSE === "1") {
  process.stderr.write(`OpenCode startup stdout:\n${openCodeStartup.stdout}\n`);
  process.stderr.write(`OpenCode startup stderr:\n${openCodeStartup.stderr}\n`);
  process.stderr.write(`OpenCode server stdout:\n${openCodeServer.stdout}\n`);
  process.stderr.write(`OpenCode server stderr:\n${openCodeServer.stderr}\n`);
  const logDir = path.join(home, ".local", "share", "opencode", "log");
  if (fs.existsSync(logDir)) {
    for (const entry of fs.readdirSync(logDir)) {
      const pathname = path.join(logDir, entry);
      if (fs.statSync(pathname).isFile()) {
        process.stderr.write(`OpenCode log ${entry}:\n${fs.readFileSync(pathname, "utf8")}\n`);
      }
    }
  }
}
const piModels = run("pi", ["--offline", "--list-models"]);
const codexFeatures = run("codex", ["features", "list"]);
assert.match(codexFeatures.stdout, /^hooks\s+\S+\s+true\b/im);

const noisy = Array.from({ length: 3_000 }, () =>
  "Downloading package artifact [====================] 99%"
).join("\n");
const configPath = initResult.config;

const claudeSettings = readJson(paths.claude);
const claudeCommand = claudeSettings.hooks.PostToolUse
  .flatMap((entry) => entry.hooks || [])
  .find((hook) => String(hook.command || "").includes("command-compressor-agent"))
  .command;
const claudePayload = {
  tool_name: "Bash",
  tool_input: { command: "npm install example" },
  tool_response: { stdout: noisy, stderr: "", exit_code: 0, interrupted: false },
};
const claudePatch = invokeCommandHook(claudeCommand, claudePayload);
const claudeOutput = claudePatch.hookSpecificOutput.updatedToolOutput.stdout;
assertCompressed(noisy, claudeOutput, "Claude Code hook");
assert.equal(claudePatch.hookSpecificOutput.updatedToolOutput.interrupted, false);

const codexHooks = readJson(paths.codex);
const codexCommand = codexHooks.hooks.PostToolUse
  .flatMap((entry) => entry.hooks || [])
  .find((hook) => String(hook.command || "").includes("command-compressor-agent"))
  .command;
assert(!codexCommand.includes("bypass-hook-trust"), "normal Codex install bypassed trust");
const codexPatch = invokeCommandHook(codexCommand, {
  tool_name: "Bash",
  tool_input: { command: "npm install example" },
  tool_response: { output: noisy, exitCode: 0 },
});
assert.equal(codexPatch.continue, false);
assertCompressed(noisy, codexPatch.stopReason, "Codex hook");

const openCodeProbeModule = path.join(root, "command-compressor-agent.mjs");
fs.copyFileSync(paths.opencode, openCodeProbeModule);
const openCodeModule = await import(`${pathToFileURL(openCodeProbeModule).href}?smoke=${Date.now()}`);
const openCodeHooks = await openCodeModule.CommandCompressorAgent({});
const openCodeOutput = {
  title: "Install",
  output: noisy,
  metadata: { exitCode: 0, sentinel: "preserved" },
};
await openCodeHooks["tool.execute.after"](
  { tool: "bash", args: { command: "npm install example" } },
  openCodeOutput
);
assertCompressed(noisy, openCodeOutput.output, "OpenCode plugin");
assert.deepEqual(openCodeOutput.metadata, { exitCode: 0, sentinel: "preserved" });

const piPackageRoot = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const { createExtensionRuntime, loadExtensions } = await import(
  pathToFileURL(path.join(piPackageRoot, "core", "extensions", "loader.js")).href
);
const { ExtensionRunner } = await import(
  pathToFileURL(path.join(piPackageRoot, "core", "extensions", "runner.js")).href
);
const runtime = createExtensionRuntime();
const loaded = await loadExtensions([paths.pi], project, undefined, runtime);
assert.equal(loaded.errors.length, 0, `Pi extension load errors: ${JSON.stringify(loaded.errors)}`);
assert.equal(loaded.extensions.length, 1, "Pi did not load the installed extension");
const piRunner = new ExtensionRunner(loaded.extensions, runtime, project, {}, {});
const piErrors = [];
piRunner.onError((error) => piErrors.push(error));
const piResult = await piRunner.emitToolResult({
  type: "tool_result",
  toolName: "bash",
  toolCallId: "cca-smoke",
  input: { command: "npm install example" },
  content: [{ type: "text", text: noisy }],
  details: { exitCode: 1, sentinel: "preserved" },
  isError: true,
});
assert.equal(piErrors.length, 0, `Pi runner errors: ${JSON.stringify(piErrors)}`);
assertCompressed(noisy, piResult.content[0].text, "Pi extension");
assert.deepEqual(piResult.details, { exitCode: 1, sentinel: "preserved" });
assert.equal(piResult.isError, true);

const status = JSON.parse(run(process.execPath, [
  path.join(repoRoot, "bin", "cca.js"),
  "status",
  "--global",
  "--json",
]).stdout);
for (const agent of ["claude-code", "codex", "opencode", "pi"]) {
  assert.equal(status.agents[agent].installed, true);
}
assert.equal(status.agents.codex.trustStatus, "review-required-or-unknown");

const metrics = fs.readFileSync(path.join(path.dirname(configPath), "gain.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
for (const agent of ["claude-code", "codex", "opencode", "pi"]) {
  assert(metrics.some((entry) => entry.agent === agent && entry.changed), `${agent} produced no changed metric`);
}

const uninstall = JSON.parse(run(process.execPath, [
  path.join(repoRoot, "bin", "cca.js"),
  "uninstall",
  "--global",
  "--json",
]).stdout);
assert.equal(uninstall.status, "uninstalled");
for (const pathname of [paths.opencode, paths.pi]) {
  assert(!fs.existsSync(pathname), `uninstall left owned CCA file behind: ${pathname}`);
}
for (const pathname of [paths.claude, paths.codex]) {
  assert(fs.existsSync(pathname), `uninstall removed the user's settings file: ${pathname}`);
  assert(
    !fs.readFileSync(pathname, "utf8").includes("command-compressor"),
    `uninstall left a CCA JSON hook behind: ${pathname}`
  );
}
const statusAfterUninstall = JSON.parse(run(process.execPath, [
  path.join(repoRoot, "bin", "cca.js"),
  "status",
  "--global",
  "--json",
]).stdout);
for (const agent of ["claude-code", "codex", "opencode", "pi"]) {
  assert.equal(statusAfterUninstall.agents[agent].installed, false);
}

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  versions: {
    claude_code: run("claude", ["--version"]).stdout.trim(),
    codex: run("codex", ["--version"]).stdout.trim(),
    opencode: run("opencode", ["--version"]).stdout.trim(),
    pi: run("pi", ["--version"]).stdout.trim(),
  },
  install: "passed",
  idempotency: "passed",
  loaders: {
    claude_doctor: "passed",
    opencode_startup: "passed",
    opencode_server: openCodeServer.health,
    pi_cli: piModels.stdout.split(/\r?\n/).filter(Boolean).length > 0 ? "passed" : "no-models",
    codex_features: "hooks-enabled",
  },
  replacement: {
    claude_code: "passed",
    codex: "passed",
    opencode: "passed",
    pi: "passed",
  },
  preservation: {
    claude_tool_response_fields: "passed",
    opencode_metadata: "passed",
    pi_details_and_is_error: "passed",
  },
  uninstall: "passed",
  metrics_observations: metrics.length,
}, null, 2)}\n`);
