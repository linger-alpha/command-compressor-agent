#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

if (Object.keys(packageJson.dependencies || {}).length) {
  throw new Error("The runtime package must have zero third-party dependencies");
}

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-npm-pack-cache-"));
let packed;
try {
  packed = childProcess.spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      npm_config_cache: cacheDir,
      npm_config_update_notifier: "false",
    },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  });
} finally {
  fs.rmSync(cacheDir, { recursive: true, force: true });
}
if (packed.error || packed.status !== 0) {
  throw new Error(`npm pack --dry-run failed: ${packed.stderr || packed.stdout || packed.error}`);
}

let report;
try {
  report = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack --dry-run did not return JSON: ${error.message}`);
}

const files = new Set((report[0] && report[0].files || []).map((entry) => entry.path));
const allowedRoots = ["bin/", "src/", "rules/"];
const allowedFiles = new Set(["package.json", "README.md", "LICENSE"]);
const suspicious = /(^|\/)(?:research|tests?|fixtures?|harbor|benchmarks?|datasets?|artifacts?|jobs?)(\/|$)|\.(?:py|pyc|ipynb|jsonl|tgz|tar|zip)$/i;
const rejected = [];

for (const pathname of files) {
  const allowed = allowedFiles.has(pathname) || allowedRoots.some((root) => pathname.startsWith(root));
  if (!allowed || suspicious.test(pathname) || pathname.endsWith(".DS_Store")) rejected.push(pathname);
}

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/cca.js",
  "bin/cca-hook.js",
  "rules/default-rules.json",
  "src/cli.js",
  "src/compression/compressor.js",
  "src/takeover/claude-code.js",
  "src/takeover/codex.js",
  "src/takeover/opencode.js",
  "src/takeover/pi.js",
];
const missing = required.filter((pathname) => !files.has(pathname));

if (rejected.length || missing.length) {
  const details = [
    rejected.length ? `unexpected package files:\n${rejected.map((item) => `  - ${item}`).join("\n")}` : "",
    missing.length ? `missing runtime files:\n${missing.map((item) => `  - ${item}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
  throw new Error(`npm package boundary check failed\n${details}`);
}

process.stdout.write(`package boundary passed: ${files.size} files, runtime-only contents\n`);
