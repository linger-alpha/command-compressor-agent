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
  assert.strictEqual(JSON.parse(first.out).strength, "high");

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
  const fourth = await capture(() => main(["init", "--global", "--settings", settings, "--config", config, "--json"]));
  assert.strictEqual(fourth.code, 0);
  const installed = JSON.parse(fourth.out);
  assert(installed.command.includes(process.execPath), "hook command should use the absolute Node executable");
  assert(installed.command.includes("cca-hook.js"), "hook command should call the bundled hook script");

  console.log("cli tests passed");
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
