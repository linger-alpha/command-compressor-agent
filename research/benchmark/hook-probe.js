#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const {
  readCodeModeExecCalls,
  readGainFacts,
  readModelVisibleCompressionFacts,
} = require("./cli");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ARMS = new Set(["none", "legacy", "current"]);
const FEEDBACK_MODES = new Set(["replacement", "block", "block-explained"]);
const FIXTURES = new Set([
  "hook-probe",
  "hook-block-probe-implicit",
  "hook-block-probe-explained",
  "hook-splitter-merge-probe",
]);

function buildProbeConfig(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const arm = String(options.arm || "current");
  if (!ARMS.has(arm)) throw new Error(`Unknown probe arm: ${arm}`);
  const feedbackMode = String(options.feedbackMode || "replacement");
  if (!FEEDBACK_MODES.has(feedbackMode)) {
    throw new Error(`Unknown Codex feedback mode: ${feedbackMode}`);
  }
  const fixture = String(options.fixture || "hook-probe");
  if (!FIXTURES.has(fixture)) throw new Error(`Unknown hook probe fixture: ${fixture}`);
  const currentCommit = childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const suffix = String(options.suffix || Date.now());
  return {
    job_name: options.jobName ||
      `cca-codex-hook-probe-${arm}-${feedbackMode}-${fixture}-${suffix}`,
    jobs_dir: path.resolve(
      options.jobsDir || path.join(repoRoot, "research", "jobs", "hook-probe")
    ),
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: false,
    retry: { max_retries: 0 },
    environment: {
      type: "docker",
      force_build: false,
      delete: true,
    },
    agents: [{
      import_path: "research.benchmark.cca_codex_agent:CcaCodex",
      model_name: "gpt-5.6-luna",
      kwargs: {
        arm,
        repo_root: repoRoot,
        baseline_commit: "7830b17",
        current_commit: currentCommit,
        reasoning_effort: "max",
        feedback_mode: feedbackMode,
      },
    }],
    tasks: [{
      path: path.join(repoRoot, "research", "benchmark", "fixtures", fixture),
    }],
  };
}

function buildProbeReport(jobDir) {
  const trialDir = findTrialDir(path.resolve(jobDir));
  if (!trialDir) throw new Error(`No completed probe trial found under ${jobDir}`);
  const artifactsDir = path.join(trialDir, "artifacts");
  const gain = readGainFacts(path.join(artifactsDir, "cca-gain.jsonl"));
  const result = readJson(path.join(trialDir, "result.json"), {});
  const reward = preferredReward(result);
  const visible = readModelVisibleCompressionFacts(trialDir);
  const changed = gain.cca_hook_changed_observations;
  const checks = {
    task_completed: reward >= 1 && !result.exception_info,
    compressible_output_exercised: changed > 0,
    every_hook_replacement_model_visible: changed > 0 && visible === changed,
  };
  return {
    schema_version: 1,
    job_dir: path.resolve(jobDir),
    trial_dir: trialDir,
    reward,
    exception: result.exception_info || null,
    hook_changed_observations: changed,
    hook_raw_tokens_est: gain.cca_hook_raw_tokens_est,
    hook_compressed_tokens_est: gain.cca_hook_compressed_tokens_est,
    model_visible_compressed_observations: visible,
    code_mode_exec_calls: readCodeModeExecCalls(trialDir),
    passed: Object.values(checks).every(Boolean),
    checks,
  };
}

function findTrialDir(jobDir) {
  if (!fs.existsSync(jobDir)) return null;
  return fs.readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(jobDir, entry.name))
    .find((pathname) => fs.existsSync(path.join(pathname, "result.json"))) || null;
}

function preferredReward(result) {
  const rewards = result && result.verifier_result && result.verifier_result.rewards;
  if (!rewards || typeof rewards !== "object") return null;
  const value = rewards.reward != null
    ? rewards.reward
    : rewards.overall != null
      ? rewards.overall
      : Object.values(rewards)[0];
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[index + 1];
    flags[key] = next && !next.startsWith("--") ? next : true;
    if (flags[key] !== true) index += 1;
  }
  return flags;
}

function readJson(pathname, fallback) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const flags = parseFlags(argv.slice(1));
  if (command === "config") {
    const config = buildProbeConfig({
      arm: flags.arm,
      feedbackMode: flags["feedback-mode"],
      fixture: flags.fixture,
      jobsDir: flags["jobs-dir"],
      jobName: flags["job-name"],
    });
    if (flags.out) writeJson(path.resolve(flags.out), config);
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }
  if (command === "report") {
    if (!flags["job-dir"]) throw new Error("--job-dir is required");
    const report = buildProbeReport(flags["job-dir"]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 2;
  }
  process.stdout.write([
    "Codex model-visible hook probe (repository-only)",
    "",
    "Usage:",
    "  node research/benchmark/hook-probe.js config --arm current [--feedback-mode replacement|block|block-explained] [--fixture FIXTURE] --out CONFIG.json",
    "  node research/benchmark/hook-probe.js report --job-dir JOB_DIR",
    "",
  ].join("\n"));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`cca hook probe: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildProbeConfig,
  buildProbeReport,
  findTrialDir,
};
