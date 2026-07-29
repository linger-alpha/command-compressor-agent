"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { main } = require("../src/cli");

async function capture(fn) {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-cli-"));
  const config = path.join(dir, "config.json");
  const first = await capture(() => main(["strength", "high", "--config", config, "--json"]));
  assert.strictEqual(first.code, 0);
  const strengthOutput = JSON.parse(first.out);
  assert.strictEqual(strengthOutput.strength, "high");
  assert(strengthOutput.profiles.every((profile) => profile.minRawTokens === undefined));
  assert(strengthOutput.profiles.every((profile) => profile.strongOnly === undefined));

  const second = await capture(() => main(["status", "--config", config, "--json"]));
  assert.strictEqual(second.code, 0);
  assert.strictEqual(JSON.parse(second.out).strength, "high");

  const third = await capture(() => main(["gain", "--config", config, "--json"]));
  assert.strictEqual(third.code, 0);
  assert.strictEqual(JSON.parse(third.out).observations, 0);

  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-env-config-"));
  const oldConfigPath = process.env.CCA_CONFIG_PATH;
  process.env.CCA_CONFIG_PATH = path.join(envDir, "config.json");
  try {
    const envStrength = await capture(() => main(["strength", "--json"]));
    assert.strictEqual(envStrength.code, 0);
    assert.strictEqual(JSON.parse(envStrength.out).strength, "default");
    assert(fs.existsSync(path.join(envDir, "rules.json")), "CCA_CONFIG_PATH should keep rules beside the config file");
  } finally {
    if (oldConfigPath === undefined) delete process.env.CCA_CONFIG_PATH;
    else process.env.CCA_CONFIG_PATH = oldConfigPath;
  }

  const settings = path.join(dir, "settings.json");
  const fourth = await capture(() => main(["install", "--claude-code", "--global", "--settings", settings, "--config", config, "--json"]));
  assert.strictEqual(fourth.code, 0);
  const installed = JSON.parse(fourth.out);
  assert(installed.agents["claude-code"].command.includes(process.execPath), "hook command should use the absolute Node executable");
  assert(installed.agents["claude-code"].command.includes("cca-hook.js"), "hook command should call the bundled hook script");

  const noAgent = await capture(() => main(["install", "--project", "--config", config, "--json"]));
  assert.strictEqual(noAgent.code, 1, "explicit install requires an agent flag");

  const autoDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-auto-init-"));
  const autoBin = path.join(autoDir, "bin");
  fs.mkdirSync(autoBin);
  for (const executable of ["claude", "codex", "opencode", "pi"]) {
    const pathname = path.join(autoBin, executable);
    const body = executable === "codex"
      ? '#!/bin/sh\nif [ "$1" = "features" ]; then printf "hooks stable true\\n"; else printf "codex 1.0.0\\n"; fi\n'
      : `#!/bin/sh\nprintf "${executable} 1.0.0\\n"\n`;
    fs.writeFileSync(pathname, body, { encoding: "utf8", mode: 0o755 });
  }
  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  process.env.PATH = autoBin;
  process.chdir(autoDir);
  try {
    const auto = await capture(() => main(["init", "--project", "--config", path.join(autoDir, "cca.json"), "--json"]));
    assert.strictEqual(auto.code, 0);
    const initialized = JSON.parse(auto.out);
    assert.deepStrictEqual(Object.keys(initialized.agents).sort(), ["claude-code", "codex", "opencode", "pi"]);
    assert(fs.existsSync(path.join(autoDir, ".codex", "hooks.json")));
    assert(fs.existsSync(path.join(autoDir, ".opencode", "plugins", "command-compressor-agent.js")));
    assert(fs.existsSync(path.join(autoDir, ".pi", "extensions", "command-compressor-agent.ts")));
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
  }

  console.log("cli tests passed");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
