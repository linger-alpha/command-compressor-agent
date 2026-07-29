#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TASKS = [
  "build-cython-ext",
  "pypi-server",
  "sqlite-with-gcov",
  "log-summary-date-ranges",
];
const ARMS = ["none", "legacy", "current"];
const ARM_LABELS = {
  none: "no-compression",
  legacy: "cca-0.1.4-7830b17",
  current: "cca-current",
};
const DEFAULT_SEED = 20260729;
const DEFAULT_REPEATS = 4;

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const flags = parseFlags(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "plan") {
    const manifest = createManifest({
      seed: numberFlag(flags.seed, DEFAULT_SEED),
      repeats: numberFlag(flags.repeats, DEFAULT_REPEATS),
    });
    const outPath = path.resolve(flags.out || path.join(REPO_ROOT, "research", "artifacts", "tb21-plan.json"));
    writeJson(outPath, manifest);
    print({ out: outPath, trials: manifest.trials.length, seed: manifest.seed });
    return 0;
  }
  if (command === "config") {
    if (!flags.plan || !flags.trial) throw new Error("--plan and --trial are required");
    const manifest = readJson(path.resolve(flags.plan));
    const trial = manifest.trials.find((entry) => entry.id === flags.trial);
    if (!trial) throw new Error(`Unknown trial id: ${flags.trial}`);
    print(makeJobConfig(trial, {
      jobsDir: path.resolve(flags["jobs-dir"] || defaultJobsDir()),
      repoRoot: REPO_ROOT,
      baselineCommit: manifest.baseline_commit,
      currentCommit: manifest.current_commit,
    }));
    return 0;
  }
  if (command === "run") {
    if (!flags.plan) throw new Error("--plan is required");
    return runManifest(path.resolve(flags.plan), flags);
  }
  if (command === "report") {
    if (!flags.plan) throw new Error("--plan is required");
    const manifest = readJson(path.resolve(flags.plan));
    const report = reportFromJobs(manifest, path.resolve(flags["jobs-dir"] || defaultJobsDir()));
    if (flags.out) writeJson(path.resolve(flags.out), report);
    print(report);
    return report.release_gate.passed === false ? 2 : 0;
  }
  throw new Error(`Unknown benchmark command: ${command}`);
}

function createManifest(options = {}) {
  const seed = Number(options.seed == null ? DEFAULT_SEED : options.seed);
  const repeats = Number(options.repeats == null ? DEFAULT_REPEATS : options.repeats);
  const currentCommit = String(options.currentCommit || currentRepoCommit(REPO_ROOT));
  if (!Number.isInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  const trials = [];
  for (const task of TASKS) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const arm of ARMS) {
        trials.push({
          id: `${task}--${arm}--r${repeat}`,
          task,
          arm,
          arm_label: ARM_LABELS[arm],
          repeat,
        });
      }
    }
  }
  shuffle(trials, seed);
  trials.forEach((trial, index) => {
    trial.order = index + 1;
  });
  return {
    schema_version: 2,
    dataset: "terminal-bench/terminal-bench-2-1@latest",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    baseline_commit: "7830b17",
    current_commit: currentCommit,
    seed,
    repeats,
    concurrency: 1,
    tasks: [...TASKS],
    arms: ARMS.map((arm) => ({ id: arm, label: ARM_LABELS[arm] })),
    trials,
  };
}

function makeJobConfig(trial, options = {}) {
  if (!trial || !TASKS.includes(trial.task) || !ARMS.includes(trial.arm)) {
    throw new Error("Invalid benchmark trial");
  }
  const jobsDir = path.resolve(options.jobsDir || defaultJobsDir());
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  return {
    job_name: jobName(trial),
    jobs_dir: jobsDir,
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
        arm: trial.arm,
        repo_root: repoRoot,
        baseline_commit: options.baselineCommit || "7830b17",
        current_commit: options.currentCommit || currentRepoCommit(repoRoot),
        reasoning_effort: "max",
      },
    }],
    datasets: [{
      name: "terminal-bench/terminal-bench-2-1",
      ref: "latest",
      task_names: [`terminal-bench/${trial.task}`],
    }],
  };
}

function runManifest(planPath, flags = {}) {
  const manifest = readJson(planPath);
  validateManifest(manifest);
  const jobsDir = path.resolve(flags["jobs-dir"] || defaultJobsDir());
  const configDir = path.join(jobsDir, "configs");
  const statePath = path.resolve(flags.state || path.join(jobsDir, "run-state.json"));
  const state = fs.existsSync(statePath)
    ? readJson(statePath)
    : { schema_version: 1, plan: planPath, trials: {} };
  const python = path.resolve(flags.python || process.env.HARBOR_PYTHON || path.join(REPO_ROOT, "..", ".venv", "bin", "python"));
  const launcher = path.resolve(flags["harbor-launcher"] || process.env.HARBOR_LAUNCHER || path.join(REPO_ROOT, "..", ".venv", "bin", "harbor"));
  const harborSource = path.resolve(flags["harbor-source"] || process.env.HARBOR_SOURCE || path.join(REPO_ROOT, "..", "external", "taco", "src"));
  for (const pathname of [python, launcher, harborSource]) {
    if (!fs.existsSync(pathname)) throw new Error(`Missing Harbor runtime path: ${pathname}`);
  }
  fs.mkdirSync(configDir, { recursive: true });
  const maxTrials = numberFlag(flags["max-trials"], Infinity);
  const selectedTrial = flags.trial ? String(flags.trial) : null;
  if (selectedTrial && !manifest.trials.some((trial) => trial.id === selectedTrial)) {
    throw new Error(`Unknown trial id: ${selectedTrial}`);
  }
  let attempted = 0;
  for (const trial of manifest.trials) {
    if (selectedTrial && trial.id !== selectedTrial) continue;
    const previous = state.trials[trial.id];
    if (
      previous &&
      previous.status === "completed" &&
      harborJobSucceeded(path.join(jobsDir, previous.job_name)) &&
      jobMatchesManifest(path.join(jobsDir, previous.job_name), trial, manifest)
    ) {
      continue;
    }
    if (attempted >= maxTrials) break;
    const config = makeJobConfig(trial, {
      jobsDir,
      repoRoot: REPO_ROOT,
      baselineCommit: manifest.baseline_commit,
      currentCommit: manifest.current_commit,
    });
    const priorAttempt = previous ? numberOr(previous.attempt, 1) : 0;
    const attempt = priorAttempt + 1;
    config.job_name = retryJobName(trial, attempt);
    const configPath = path.join(configDir, `${String(trial.order).padStart(2, "0")}-${trial.id}.json`);
    writeJson(configPath, config);
    state.trials[trial.id] = {
      status: "running",
      order: trial.order,
      attempt,
      job_name: config.job_name,
      config: configPath,
      started_at: new Date().toISOString(),
    };
    writeJson(statePath, state);
    const pythonPath = [REPO_ROOT, harborSource, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const result = childProcess.spawnSync(python, [launcher, "run", "--config", configPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: "utf8",
      stdio: "inherit",
      shell: false,
    });
    const processExitCode = result.error || !Number.isInteger(result.status) ? 1 : result.status;
    const jobSucceeded = processExitCode === 0 &&
      harborJobSucceeded(path.join(jobsDir, config.job_name));
    const exitCode = processExitCode || (jobSucceeded ? 0 : 2);
    state.trials[trial.id] = {
      ...state.trials[trial.id],
      status: exitCode === 0 ? "completed" : "failed",
      exit_code: exitCode,
      harbor_process_exit_code: processExitCode,
      finished_at: new Date().toISOString(),
    };
    writeJson(statePath, state);
    attempted += 1;
    if (exitCode !== 0 && !flags["continue-on-error"]) return exitCode || 1;
  }
  return 0;
}

function reportFromJobs(manifest, jobsDir) {
  const results = new Map();
  const stale = [];
  for (const trial of manifest.trials) {
    const jobDir = latestJobDirectory(jobsDir, trial);
    if (!jobDir) continue;
    const result = loadTrialResult(jobDir);
    if (!result) continue;
    const enriched = withArtifactFacts(result, jobDir);
    const compatibility = resultMatchesManifest(trial, enriched, manifest);
    if (compatibility.matches) {
      results.set(trial.id, enriched);
    } else {
      stale.push({
        trial_id: trial.id,
        job_dir: jobDir,
        reason: compatibility.reason,
      });
    }
  }
  return {
    ...summarizeTrials(manifest, results),
    stale_results: stale.length,
    stale_result_details: stale,
  };
}

function summarizeTrials(manifest, results) {
  validateManifest(manifest);
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, {
    label: ARM_LABELS[arm],
    planned: manifest.trials.filter((trial) => trial.arm === arm).length,
    results: 0,
    errors: 0,
    passed: 0,
    completed: 0,
    input_tokens: [],
    hook_observations: 0,
    hook_trials: 0,
  }]));
  for (const trial of manifest.trials) {
    const result = results.get(trial.id);
    if (!result) continue;
    const stats = byArm[trial.arm];
    stats.results += 1;
    if (result.exception_info) stats.errors += 1;
    if (trialPassed(result)) stats.passed += 1;
    if (trialCompleted(result)) stats.completed += 1;
    const tokens = Number(result.agent_result && result.agent_result.n_input_tokens);
    if (Number.isFinite(tokens) && tokens > 0) stats.input_tokens.push(tokens);
    const observations = Number(result.cca_hook_observations || 0);
    stats.hook_observations += observations;
    if (observations > 0) stats.hook_trials += 1;
  }
  for (const stats of Object.values(byArm)) {
    stats.input_token_median = median(stats.input_tokens);
    delete stats.input_tokens;
  }

  const matched = [];
  let matchedExcludedByException = 0;
  for (const task of TASKS) {
    for (let repeat = 1; repeat <= manifest.repeats; repeat += 1) {
      const group = Object.fromEntries(ARMS.map((arm) => {
        const id = `${task}--${arm}--r${repeat}`;
        return [arm, results.get(id)];
      }));
      if (!ARMS.every((arm) => group[arm] && trialPassed(group[arm]))) continue;
      if (!ARMS.every((arm) => trialCompleted(group[arm]))) {
        matchedExcludedByException += 1;
        continue;
      }
      const tokens = Object.fromEntries(ARMS.map((arm) => [
        arm,
        Number(group[arm].agent_result && group[arm].agent_result.n_input_tokens),
      ]));
      if (!ARMS.every((arm) => Number.isFinite(tokens[arm]) && tokens[arm] > 0)) continue;
      matched.push({ task, repeat, tokens });
    }
  }
  const matchedMedians = Object.fromEntries(ARMS.map((arm) => [
    arm,
    median(matched.map((entry) => entry.tokens[arm])),
  ]));
  const reductionVsNone = reduction(matchedMedians.none, matchedMedians.current);
  const reductionVsLegacy = reduction(matchedMedians.legacy, matchedMedians.current);
  const allResultsPresent = results.size === manifest.trials.length;
  const hooksEffective =
    byArm.legacy.hook_trials === byArm.legacy.results &&
    byArm.current.hook_trials === byArm.current.results;
  const gates = {
    all_48_trials_present: allResultsPresent,
    current_passes_at_least_legacy: byArm.current.passed >= byArm.legacy.passed,
    current_within_one_of_no_compression: byArm.current.passed >= byArm.none.passed - 1,
    matched_success_input_tokens_10pct_below_none:
      matched.length > 0 && reductionVsNone >= 0.1,
    matched_success_input_tokens_5pct_below_legacy:
      matched.length > 0 && reductionVsLegacy >= 0.05,
    compression_hooks_observed: hooksEffective,
  };
  return {
    schema_version: 1,
    dataset: manifest.dataset,
    model: manifest.model,
    reasoning_effort: manifest.reasoning_effort,
    baseline_commit: manifest.baseline_commit,
    current_commit: manifest.current_commit || null,
    seed: manifest.seed,
    planned_trials: manifest.trials.length,
    observed_results: results.size,
    by_arm: byArm,
    matched_successful_triplets: matched.length,
    matched_reward_triplets_excluded_by_exception: matchedExcludedByException,
    matched_input_token_medians: matchedMedians,
    input_token_reduction: {
      current_vs_none: reductionVsNone,
      current_vs_legacy: reductionVsLegacy,
    },
    release_gate: {
      passed: Object.values(gates).every(Boolean),
      checks: gates,
    },
  };
}

function withArtifactFacts(result, jobDir) {
  const copy = { ...result };
  const trialDir = firstTrialDirectory(jobDir);
  const gainPath = trialDir && path.join(trialDir, "artifacts", "cca-gain.jsonl");
  const armPath = trialDir && path.join(trialDir, "artifacts", "cca-arm.json");
  copy.cca_hook_observations = gainPath && fs.existsSync(gainPath)
    ? fs.readFileSync(gainPath, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  copy.cca_arm_metadata = armPath && fs.existsSync(armPath)
    ? readJson(armPath)
    : null;
  return copy;
}

function jobMatchesManifest(jobDir, trial, manifest) {
  const result = loadTrialResult(jobDir);
  if (!result) return false;
  return resultMatchesManifest(
    trial,
    withArtifactFacts(result, jobDir),
    manifest
  ).matches;
}

function resultMatchesManifest(trial, result, manifest) {
  const metadata = result && result.cca_arm_metadata;
  if (!metadata || metadata.arm !== trial.arm) {
    return { matches: false, reason: "missing-or-mismatched-arm-metadata" };
  }
  if (trial.arm === "legacy" && metadata.baseline_commit !== manifest.baseline_commit) {
    return { matches: false, reason: "baseline-commit-mismatch" };
  }
  if (trial.arm === "current") {
    if (!manifest.current_commit) {
      return { matches: false, reason: "manifest-missing-current-commit" };
    }
    if (metadata.current_commit !== manifest.current_commit) {
      return { matches: false, reason: "current-commit-mismatch" };
    }
  }
  return { matches: true, reason: null };
}

function loadTrialResult(jobDir) {
  const trialDir = firstTrialDirectory(jobDir);
  if (!trialDir) return null;
  const resultPath = path.join(trialDir, "result.json");
  if (!fs.existsSync(resultPath)) return null;
  try {
    return readJson(resultPath);
  } catch {
    return null;
  }
}

function harborJobSucceeded(jobDir) {
  const resultPath = path.join(jobDir, "result.json");
  if (!fs.existsSync(resultPath)) return false;
  try {
    return harborResultSucceeded(readJson(resultPath));
  } catch {
    return false;
  }
}

function harborResultSucceeded(result) {
  if (!result || !result.stats) return false;
  const trials = numberOr(result.stats.n_trials, result.n_total_trials);
  const errors = numberOr(result.stats.n_errors, 0);
  return Number.isFinite(trials) && trials >= 1 && errors === 0;
}

function latestJobDirectory(jobsDir, trial) {
  const base = jobName(trial);
  if (!fs.existsSync(jobsDir)) return null;
  let latest = null;
  let latestAttempt = -1;
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attempt = entry.name === base
      ? 1
      : entry.name.startsWith(`${base}-retry`)
        ? Number(entry.name.slice(`${base}-retry`.length)) + 1
        : NaN;
    if (Number.isInteger(attempt) && attempt > latestAttempt) {
      latest = path.join(jobsDir, entry.name);
      latestAttempt = attempt;
    }
  }
  return latest;
}

function firstTrialDirectory(jobDir) {
  if (!fs.existsSync(jobDir)) return null;
  return fs.readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "configs")
    .map((entry) => path.join(jobDir, entry.name))
    .find((directory) => fs.existsSync(path.join(directory, "result.json"))) || null;
}

function trialPassed(result) {
  const rewards = result && result.verifier_result && result.verifier_result.rewards;
  if (!rewards || typeof rewards !== "object") return false;
  const preferred = rewards.reward != null ? rewards.reward
    : rewards.overall != null ? rewards.overall
      : Object.values(rewards)[0];
  return Number(preferred) >= 1;
}

function trialCompleted(result) {
  return trialPassed(result) && !result.exception_info;
}

function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.trials)) throw new Error("Invalid benchmark manifest");
  if (!/^[a-f0-9]{40}$/.test(String(manifest.current_commit || ""))) {
    throw new Error("Benchmark manifest must pin current_commit; regenerate the plan");
  }
  const expected = TASKS.length * ARMS.length * Number(manifest.repeats);
  if (manifest.trials.length !== expected) {
    throw new Error(`Expected ${expected} trials, found ${manifest.trials.length}`);
  }
  if (manifest.concurrency !== 1) throw new Error("Benchmark concurrency must remain 1");
}

function shuffle(items, seed) {
  const random = xorshift32(seed || 1);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
}

function xorshift32(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reduction(baseline, current) {
  return Number.isFinite(baseline) && baseline > 0 && Number.isFinite(current)
    ? (baseline - current) / baseline
    : null;
}

function currentRepoCommit(repoRoot) {
  return childProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function jobName(trial) {
  return [
    "cca-tb21",
    String(trial.order).padStart(2, "0"),
    trial.task,
    trial.arm,
    `r${trial.repeat}`,
  ].join("-");
}

function retryJobName(trial, attempt) {
  const base = jobName(trial);
  return attempt <= 1 ? base : `${base}-retry${attempt - 1}`;
}

function defaultJobsDir() {
  return path.join(REPO_ROOT, "research", "jobs", "terminal-bench-2.1");
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

function numberFlag(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) && number !== Infinity) throw new Error(`Expected number, received ${value}`);
  return number;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback);
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function writeJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  process.stdout.write([
    "CCA Terminal-Bench 2.1 research harness (excluded from npm)",
    "",
    "Usage:",
    "  node research/benchmark/cli.js plan [--out research/artifacts/tb21-plan.json]",
    "  node research/benchmark/cli.js config --plan PLAN --trial TRIAL_ID",
    "  node research/benchmark/cli.js run --plan PLAN [--trial TRIAL_ID] [--max-trials 1]",
    "  node research/benchmark/cli.js report --plan PLAN [--out REPORT.json]",
    "",
  ].join("\n"));
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`cca benchmark: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  ARMS,
  ARM_LABELS,
  DEFAULT_SEED,
  TASKS,
  createManifest,
  harborResultSucceeded,
  jobName,
  latestJobDirectory,
  makeJobConfig,
  median,
  reportFromJobs,
  resultMatchesManifest,
  retryJobName,
  summarizeTrials,
  trialCompleted,
  trialPassed,
};
