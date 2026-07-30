#!/usr/bin/env node
"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const { buildStaticReplayReport } = require("./static-replay");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TASKS = [
  "build-cython-ext",
  "pypi-server",
  "sqlite-with-gcov",
  "log-summary-date-ranges",
  "regex-log",
  "nginx-request-logging",
  "extract-elf",
  "sqlite-db-truncate",
  "code-from-image",
  "count-dataset-tokens",
];
const EXPERIMENT_ID = "terminal-bench-2.1-10x3-block-v1";
const ARMS = ["none", "legacy", "current"];
const SUPPORTED_ARMS = new Set(ARMS);
const ARM_LABELS = {
  none: "no-compression",
  legacy: "cca-0.1.4-7830b17",
  current: "cca-current",
};
const DEFAULT_SEED = 20260729;
const DEFAULT_REPEATS = 3;
const DEFAULT_CODEX_FEEDBACK_MODE = "block-explained";
const CODEX_FEEDBACK_MODES = new Set(["replacement", "block", "block-explained"]);

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const flags = parseFlags(argv.slice(1));
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "plan") {
    const manifest = createManifest({
      seed: numberFlag(flags.seed, DEFAULT_SEED),
      repeats: numberFlag(flags.repeats, DEFAULT_REPEATS),
      concurrency: numberFlag(flags.concurrency, 1),
      arms: flags.arms ? String(flags.arms).split(",") : ARMS,
      experimentId: flags["experiment-id"] || EXPERIMENT_ID,
      currentLabel: flags["current-label"],
    });
    const outPath = path.resolve(flags.out || path.join(REPO_ROOT, "research", "artifacts", "tb21-10x3-plan.json"));
    writeJson(outPath, manifest);
    print({
      out: outPath,
      experiment_id: manifest.experiment_id,
      arms: manifest.arms.map((arm) => arm.id),
      trials: manifest.trials.length,
      seed: manifest.seed,
    });
    return 0;
  }
  if (command === "config") {
    if (!flags.plan || !flags.trial) throw new Error("--plan and --trial are required");
    const manifest = readJson(path.resolve(flags.plan));
    const trial = manifest.trials.find((entry) => entry.id === flags.trial);
    if (!trial) throw new Error(`Unknown trial id: ${flags.trial}`);
    print(makeJobConfig(trial, {
      jobsDir: path.resolve(flags["jobs-dir"] || defaultJobsDir(manifest.experiment_id)),
      repoRoot: REPO_ROOT,
      baselineCommit: manifest.baseline_commit,
      currentCommit: manifest.current_commit,
      feedbackMode: manifest.codex_feedback_mode,
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
    const report = reportFromJobs(
      manifest,
      path.resolve(flags["jobs-dir"] || defaultJobsDir(manifest.experiment_id))
    );
    if (flags.out) writeJson(path.resolve(flags.out), report);
    print(report);
    return report.release_gate.passed === false ? 2 : 0;
  }
  if (command === "static-report") {
    if (!flags.plan) throw new Error("--plan is required");
    const manifest = readJson(path.resolve(flags.plan));
    const jobsDir = path.resolve(
      flags["jobs-dir"] || defaultJobsDir(manifest.experiment_id)
    );
    const corpora = observationCorporaFromJobs(manifest, jobsDir);
    const report = buildStaticReplayReport({
      repoRoot: REPO_ROOT,
      experimentId: manifest.experiment_id,
      baselineCommit: manifest.baseline_commit,
      currentCommit: manifest.current_commit,
      expectedTasks: manifest.tasks,
      primaryRecords: corpora.primary,
      unionRecords: corpora.union,
      corpusStats: corpora.stats,
    });
    if (flags.out) writeJson(path.resolve(flags.out), report);
    print(report);
    return report.static_checks.passed ? 0 : 2;
  }
  throw new Error(`Unknown benchmark command: ${command}`);
}

function createManifest(options = {}) {
  const seed = Number(options.seed == null ? DEFAULT_SEED : options.seed);
  const repeats = Number(options.repeats == null ? DEFAULT_REPEATS : options.repeats);
  const concurrency = Number(options.concurrency == null ? 1 : options.concurrency);
  const currentCommit = String(options.currentCommit || currentRepoCommit(REPO_ROOT));
  const arms = normalizeArms(options.arms);
  const armLabels = {
    ...ARM_LABELS,
    ...(options.currentLabel ? { current: String(options.currentLabel) } : {}),
  };
  const experimentId = String(options.experimentId || EXPERIMENT_ID);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("concurrency must be an integer between 1 and 4");
  }
  const trials = [];
  for (const task of TASKS) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const arm of arms) {
        trials.push({
          id: `${task}--${arm}--r${repeat}`,
          task,
          arm,
          arm_label: armLabels[arm],
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
    schema_version: 4,
    experiment_id: experimentId,
    dataset: "terminal-bench/terminal-bench-2-1@latest",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    codex_feedback_mode: DEFAULT_CODEX_FEEDBACK_MODE,
    baseline_commit: "7830b17",
    current_commit: currentCommit,
    seed,
    repeats,
    concurrency,
    tasks: [...TASKS],
    arms: arms.map((arm) => ({ id: arm, label: armLabels[arm] })),
    trials,
  };
}

function makeJobConfig(trial, options = {}) {
  if (!trial || !TASKS.includes(trial.task) || !ARMS.includes(trial.arm)) {
    throw new Error("Invalid benchmark trial");
  }
  const jobsDir = path.resolve(options.jobsDir || defaultJobsDir(EXPERIMENT_ID));
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
        feedback_mode: options.feedbackMode || DEFAULT_CODEX_FEEDBACK_MODE,
      },
    }],
    datasets: [{
      name: "terminal-bench/terminal-bench-2-1",
      ref: "latest",
      task_names: [`terminal-bench/${trial.task}`],
    }],
  };
}

async function runManifest(planPath, flags = {}) {
  const manifest = readJson(planPath);
  validateManifest(manifest);
  const activeArms = manifestArmIds(manifest);
  const jobsDir = path.resolve(flags["jobs-dir"] || defaultJobsDir(manifest.experiment_id));
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
  const selectedArm = flags.arm ? String(flags.arm) : null;
  const selectedTask = flags.task ? String(flags.task) : null;
  const concurrency = numberFlag(flags.concurrency, manifest.concurrency || 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("--concurrency must be an integer between 1 and 4");
  }
  state.concurrency = concurrency;
  state.concurrency_history = Array.isArray(state.concurrency_history)
    ? state.concurrency_history
    : [];
  state.concurrency_history.push({
    started_at: new Date().toISOString(),
    concurrency,
  });
  writeJson(statePath, state);
  if (selectedTrial && !manifest.trials.some((trial) => trial.id === selectedTrial)) {
    throw new Error(`Unknown trial id: ${selectedTrial}`);
  }
  if (selectedArm && !activeArms.includes(selectedArm)) {
    throw new Error(`Unknown arm: ${selectedArm}`);
  }
  if (selectedTask && !manifest.tasks.includes(selectedTask)) {
    throw new Error(`Unknown task: ${selectedTask}`);
  }
  const pending = [];
  for (const trial of manifest.trials) {
    if (selectedTrial && trial.id !== selectedTrial) continue;
    if (selectedArm && trial.arm !== selectedArm) continue;
    if (selectedTask && trial.task !== selectedTask) continue;
    const previous = state.trials[trial.id];
    if (
      !flags.force &&
      previous &&
      previous.status === "completed" &&
      harborJobSucceeded(path.join(jobsDir, previous.job_name)) &&
      jobMatchesManifest(path.join(jobsDir, previous.job_name), trial, manifest)
    ) {
      continue;
    }
    if (pending.length >= maxTrials) break;
    pending.push(trial);
  }

  let nextIndex = 0;
  let stop = false;
  let firstFailure = 0;
  const pythonPath = [REPO_ROOT, harborSource, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);

  async function runNext() {
    while (!stop) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;
      const trial = pending[index];
      const previous = state.trials[trial.id];
      const config = makeJobConfig(trial, {
        jobsDir,
        repoRoot: REPO_ROOT,
        baselineCommit: manifest.baseline_commit,
        currentCommit: manifest.current_commit,
        feedbackMode: manifest.codex_feedback_mode,
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
      const processExitCode = await new Promise((resolve) => {
        const child = childProcess.spawn(python, [launcher, "run", "--config", configPath], {
          cwd: REPO_ROOT,
          env: { ...process.env, PYTHONPATH: pythonPath },
          stdio: "inherit",
          shell: false,
        });
        child.once("error", () => resolve(1));
        child.once("exit", (code) => resolve(Number.isInteger(code) ? code : 1));
      });
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
      if (exitCode !== 0 && !flags["continue-on-error"]) {
        firstFailure ||= exitCode || 1;
        stop = true;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(concurrency, pending.length) },
    () => runNext()
  ));
  return firstFailure;
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
  const activeArms = manifestArmIds(manifest);
  const compressedArms = activeArms.filter((arm) => arm !== "none");
  const armLabels = Object.fromEntries(
    manifest.arms.map((arm) => typeof arm === "string"
      ? [arm, ARM_LABELS[arm]]
      : [arm.id, arm.label || ARM_LABELS[arm.id]])
  );
  const byArm = Object.fromEntries(activeArms.map((arm) => [arm, {
    label: armLabels[arm],
    planned: manifest.trials.filter((trial) => trial.arm === arm).length,
    results: 0,
    errors: 0,
    passed: 0,
    completed: 0,
    input_tokens: [],
    hook_observations: 0,
    hook_trials: 0,
    hook_changed_observations: 0,
    hook_raw_tokens_est: 0,
    hook_compressed_tokens_est: 0,
    hook_saved_tokens_est: 0,
    hook_command_passthrough_observations: 0,
    hook_command_passthrough_raw_tokens_est: 0,
    hook_fallback_observations: 0,
    captured_observations: 0,
    captured_output_observations: 0,
    capture_trials: 0,
    capture_output_trials: 0,
    model_visible_compressed_observations: 0,
    code_mode_exec_calls: 0,
  }]));
  const taskChecksums = Object.fromEntries(manifest.tasks.map((task) => [task, new Set()]));
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
    for (const field of [
      "changed_observations",
      "raw_tokens_est",
      "compressed_tokens_est",
      "saved_tokens_est",
      "command_passthrough_observations",
      "command_passthrough_raw_tokens_est",
      "fallback_observations",
    ]) {
      stats[`hook_${field}`] += Number(result[`cca_hook_${field}`] || 0);
    }
    stats.captured_observations += Number(result.cca_captured_observations || 0);
    stats.captured_output_observations += Number(
      result.cca_captured_output_observations || 0
    );
    if (result.cca_observation_artifact) stats.capture_trials += 1;
    if (Number(result.cca_captured_output_observations || 0) > 0) {
      stats.capture_output_trials += 1;
    }
    stats.model_visible_compressed_observations += Number(
      result.cca_model_visible_compressed_observations || 0
    );
    stats.code_mode_exec_calls += Number(result.cca_code_mode_exec_calls || 0);
    if (result.task_checksum) taskChecksums[trial.task].add(String(result.task_checksum));
  }
  for (const stats of Object.values(byArm)) {
    stats.input_token_median = median(stats.input_tokens);
    stats.hook_local_reduction = reduction(
      stats.hook_raw_tokens_est,
      stats.hook_compressed_tokens_est
    );
    stats.hook_processable_raw_tokens_est =
      stats.hook_raw_tokens_est - stats.hook_command_passthrough_raw_tokens_est;
    stats.hook_processable_reduction = reduction(
      stats.hook_processable_raw_tokens_est,
      stats.hook_processable_raw_tokens_est - stats.hook_saved_tokens_est
    );
    delete stats.input_tokens;
  }

  const matched = [];
  let matchedExcludedByException = 0;
  for (const task of manifest.tasks) {
    for (let repeat = 1; repeat <= manifest.repeats; repeat += 1) {
      const group = Object.fromEntries(activeArms.map((arm) => {
        const id = `${task}--${arm}--r${repeat}`;
        return [arm, results.get(id)];
      }));
      if (!activeArms.every((arm) => group[arm] && trialPassed(group[arm]))) continue;
      if (!activeArms.every((arm) => trialCompleted(group[arm]))) {
        matchedExcludedByException += 1;
        continue;
      }
      const tokens = Object.fromEntries(activeArms.map((arm) => [
        arm,
        Number(group[arm].agent_result && group[arm].agent_result.n_input_tokens),
      ]));
      if (!activeArms.every((arm) => Number.isFinite(tokens[arm]) && tokens[arm] > 0)) {
        continue;
      }
      matched.push({ task, repeat, tokens });
    }
  }
  const matchedMedians = Object.fromEntries(activeArms.map((arm) => [
    arm,
    median(matched.map((entry) => entry.tokens[arm])),
  ]));
  const reductionVsNone = reduction(matchedMedians.none, matchedMedians.current);
  const reductionVsLegacy = activeArms.includes("legacy")
    ? reduction(matchedMedians.legacy, matchedMedians.current)
    : null;
  const allResultsPresent = results.size === manifest.trials.length;
  const hooksEffective = compressedArms.every((arm) =>
    byArm[arm].hook_trials === byArm[arm].results
  );
  const captureEffective = Object.values(byArm).every((stats) =>
    stats.capture_trials === stats.results &&
    stats.capture_output_trials === stats.results
  );
  const taskChecksumValues = Object.fromEntries(
    Object.entries(taskChecksums).map(([task, values]) => [task, Array.from(values).sort()])
  );
  const taskVersionsConsistent =
    results.size > 0 &&
    Object.values(taskChecksumValues).every((values) => values.length === 1);
  const replacementsVisible =
    byArm.none.model_visible_compressed_observations === 0 &&
    compressedArms.every((arm) =>
      byArm[arm].model_visible_compressed_observations ===
      byArm[arm].hook_changed_observations
    );
  const replacementsExercised = compressedArms.every((arm) =>
    byArm[arm].hook_changed_observations > 0
  );
  const gates = {
    all_planned_trials_present: allResultsPresent,
    current_within_one_of_no_compression: byArm.current.passed >= byArm.none.passed - 1,
    matched_success_input_tokens_10pct_below_none:
      matched.length > 0 && reductionVsNone >= 0.1,
    compression_hooks_observed: hooksEffective,
    tool_results_captured: captureEffective,
    task_versions_consistent: taskVersionsConsistent,
    compression_replacements_exercised: replacementsExercised,
    compression_replacements_model_visible: replacementsVisible,
  };
  if (activeArms.includes("legacy")) {
    gates.current_passes_at_least_legacy =
      byArm.current.passed >= byArm.legacy.passed;
    gates.matched_success_input_tokens_5pct_below_legacy =
      matched.length > 0 && reductionVsLegacy >= 0.05;
  }
  const inputTokenReduction = {
    current_vs_none: reductionVsNone,
  };
  if (activeArms.includes("legacy")) {
    inputTokenReduction.current_vs_legacy = reductionVsLegacy;
  }
  return {
    schema_version: 3,
    experiment_id: manifest.experiment_id || null,
    dataset: manifest.dataset,
    model: manifest.model,
    reasoning_effort: manifest.reasoning_effort,
    baseline_commit: manifest.baseline_commit,
    current_commit: manifest.current_commit || null,
    seed: manifest.seed,
    planned_trials: manifest.trials.length,
    observed_results: results.size,
    by_arm: byArm,
    matched_successful_groups: matched.length,
    matched_reward_groups_excluded_by_exception: matchedExcludedByException,
    matched_input_token_medians: matchedMedians,
    input_token_reduction: inputTokenReduction,
    task_checksums: taskChecksumValues,
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
  const observationsPath = trialDir &&
    path.join(trialDir, "artifacts", "cca-observations.jsonl");
  const armPath = trialDir && path.join(trialDir, "artifacts", "cca-arm.json");
  Object.assign(copy, readGainFacts(gainPath));
  copy.cca_observation_artifact = Boolean(
    observationsPath && fs.existsSync(observationsPath)
  );
  copy.cca_captured_observations = copy.cca_observation_artifact
    ? readJsonLines(observationsPath).length
    : 0;
  copy.cca_captured_output_observations = copy.cca_observation_artifact
    ? readJsonLines(observationsPath).filter((record) =>
      String(record.stdout || "").length > 0 ||
      String(record.stderr || "").length > 0
    ).length
    : 0;
  copy.cca_arm_metadata = armPath && fs.existsSync(armPath)
    ? readJson(armPath)
    : null;
  copy.cca_model_visible_compressed_observations =
    readModelVisibleCompressionFacts(trialDir);
  copy.cca_code_mode_exec_calls = readCodeModeExecCalls(trialDir);
  return copy;
}

function readModelVisibleCompressionFacts(trialDir) {
  const sessionsDir = trialDir && path.join(trialDir, "agent", "sessions");
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return 0;
  const replacements = new Set();
  for (const pathname of filesUnder(sessionsDir)) {
    if (!pathname.endsWith(".jsonl")) continue;
    for (const [index, event] of readJsonLines(pathname).entries()) {
      if (event.type !== "response_item") continue;
      const payload = event.payload;
      if (!payload || ![
        "function_call_output",
        "custom_tool_call_output",
      ].includes(payload.type)) continue;
      const output = typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output || "");
      if (
        output.includes("[compressed output") ||
        output.includes("[command-compressor]")
      ) {
        const rawRefs = Array.from(
          output.matchAll(/raw_ref:\s*(\/[^\\\]\s"]+\.log)/g),
          (match) => match[1]
        );
        if (rawRefs.length) {
          for (const rawRef of rawRefs) replacements.add(`raw:${rawRef}`);
        } else {
          replacements.add(`event:${pathname}:${payload.call_id || index}`);
        }
      }
    }
  }
  return replacements.size;
}

function readCodeModeExecCalls(trialDir) {
  const sessionsDir = trialDir && path.join(trialDir, "agent", "sessions");
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return 0;
  let count = 0;
  for (const pathname of filesUnder(sessionsDir)) {
    if (!pathname.endsWith(".jsonl")) continue;
    for (const event of readJsonLines(pathname)) {
      if (event.type !== "response_item") continue;
      const payload = event.payload;
      if (
        payload &&
        payload.type === "custom_tool_call" &&
        payload.name === "exec"
      ) count += 1;
    }
  }
  return count;
}

function filesUnder(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const pathname = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(pathname));
    else if (entry.isFile()) output.push(pathname);
  }
  return output;
}

function readGainFacts(gainPath) {
  const facts = {
    cca_hook_observations: 0,
    cca_hook_changed_observations: 0,
    cca_hook_raw_tokens_est: 0,
    cca_hook_compressed_tokens_est: 0,
    cca_hook_saved_tokens_est: 0,
    cca_hook_command_passthrough_observations: 0,
    cca_hook_command_passthrough_raw_tokens_est: 0,
    cca_hook_fallback_observations: 0,
  };
  if (!gainPath || !fs.existsSync(gainPath)) return facts;
  for (const line of fs.readFileSync(gainPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const rules = Array.isArray(row.rules) ? row.rules : [];
    const raw = numberOr(row.raw_tokens_est, 0);
    facts.cca_hook_observations += 1;
    facts.cca_hook_changed_observations += row.changed ? 1 : 0;
    facts.cca_hook_raw_tokens_est += raw;
    facts.cca_hook_compressed_tokens_est += numberOr(row.compressed_tokens_est, raw);
    facts.cca_hook_saved_tokens_est += numberOr(row.saved_tokens_est, 0);
    const commandPassthrough = rules.some((rule) => [
      "whitelist_passthrough",
      "read_only_passthrough",
      "raw_fallback_read_passthrough",
      "rtk_passthrough",
      "command_compatibility_passthrough",
    ].includes(rule));
    if (commandPassthrough) {
      facts.cca_hook_command_passthrough_observations += 1;
      facts.cca_hook_command_passthrough_raw_tokens_est += raw;
    }
    if (rules.includes("raw_fallback_read_passthrough")) {
      facts.cca_hook_fallback_observations += 1;
    }
  }
  return facts;
}

function readJsonLines(pathname) {
  if (!pathname || !fs.existsSync(pathname)) return [];
  const records = [];
  for (const line of fs.readFileSync(pathname, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function observationCorporaFromJobs(manifest, jobsDir) {
  validateManifest(manifest);
  const activeArms = manifestArmIds(manifest);
  const primary = [];
  const union = [];
  const stats = {
    planned_trials: manifest.trials.length,
    trials_with_results: 0,
    trials_with_capture: 0,
    clean_success_trials: 0,
    observations: 0,
    primary_observations: 0,
    by_arm: Object.fromEntries(activeArms.map((arm) => [arm, {
      trials_with_capture: 0,
      observations: 0,
    }])),
    primary_tasks: [],
    stale_results: [],
  };
  const primaryTasks = new Set();
  for (const trial of manifest.trials) {
    const jobDir = latestJobDirectory(jobsDir, trial);
    if (!jobDir) continue;
    const result = loadTrialResult(jobDir);
    if (!result) continue;
    stats.trials_with_results += 1;
    const enriched = withArtifactFacts(result, jobDir);
    const compatibility = captureMatchesManifest(trial, enriched, manifest);
    if (!compatibility.matches) {
      stats.stale_results.push({
        trial_id: trial.id,
        job_dir: jobDir,
        reason: compatibility.reason,
      });
      continue;
    }
    if (trialCompleted(result)) stats.clean_success_trials += 1;
    const trialDir = firstTrialDirectory(jobDir);
    const observationsPath = trialDir &&
      path.join(trialDir, "artifacts", "cca-observations.jsonl");
    if (!observationsPath || !fs.existsSync(observationsPath)) continue;
    const observations = readJsonLines(observationsPath);
    stats.trials_with_capture += 1;
    stats.by_arm[trial.arm].trials_with_capture += 1;
    stats.by_arm[trial.arm].observations += observations.length;
    stats.observations += observations.length;
    for (const [index, observation] of observations.entries()) {
      const record = {
        id: `${trial.id}:${index + 1}`,
        source: trial.task,
        task: trial.task,
        arm: trial.arm,
        repeat: trial.repeat,
        trial_id: trial.id,
        command: String(observation.command || ""),
        stdout: String(observation.stdout || ""),
        stderr: String(observation.stderr || ""),
        exit_code: observation.exit_code == null
          ? null
          : Number(observation.exit_code),
      };
      union.push(record);
      if (trial.arm === "none") {
        primary.push(record);
        primaryTasks.add(trial.task);
      }
    }
  }
  stats.primary_observations = primary.length;
  stats.primary_tasks = Array.from(primaryTasks).sort();
  return { primary, union, stats };
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
  const runtimeCompatibility = captureMatchesManifest(trial, result, manifest);
  if (!runtimeCompatibility.matches) return runtimeCompatibility;
  const metadata = result && result.cca_arm_metadata;
  if (Number(manifest.schema_version || 0) >= 4) {
    const expectedFeedbackMode = String(manifest.codex_feedback_mode || "");
    if (metadata.feedback_mode !== expectedFeedbackMode) {
      return { matches: false, reason: "codex-feedback-mode-mismatch" };
    }
    const expectsCodeMode = expectedFeedbackMode !== "replacement";
    if (metadata.unified_exec !== expectsCodeMode) {
      return { matches: false, reason: "unified-exec-mode-mismatch" };
    }
    if (metadata.requested_code_mode !== expectsCodeMode) {
      return { matches: false, reason: "code-mode-request-mismatch" };
    }
  } else if (Number(manifest.schema_version || 0) >= 3) {
    if (metadata.unified_exec !== false) {
      return { matches: false, reason: "unified-exec-must-be-disabled" };
    }
    if (metadata.requested_code_mode !== false) {
      return { matches: false, reason: "code-mode-disable-must-be-requested" };
    }
  }
  return { matches: true, reason: null };
}

function captureMatchesManifest(trial, result, manifest) {
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
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) {
    throw new Error("Benchmark manifest must include tasks");
  }
  const activeArms = manifestArmIds(manifest);
  const expected = manifest.tasks.length * activeArms.length * Number(manifest.repeats);
  if (manifest.trials.length !== expected) {
    throw new Error(`Expected ${expected} trials, found ${manifest.trials.length}`);
  }
  const expectedIds = new Set();
  for (const task of manifest.tasks) {
    for (let repeat = 1; repeat <= Number(manifest.repeats); repeat += 1) {
      for (const arm of activeArms) {
        expectedIds.add(`${task}--${arm}--r${repeat}`);
      }
    }
  }
  const observedIds = new Set();
  for (const trial of manifest.trials) {
    if (
      !trial ||
      !manifest.tasks.includes(trial.task) ||
      !activeArms.includes(trial.arm) ||
      !Number.isInteger(Number(trial.repeat)) ||
      trial.id !== `${trial.task}--${trial.arm}--r${trial.repeat}` ||
      !expectedIds.has(trial.id) ||
      observedIds.has(trial.id)
    ) {
      throw new Error(`Invalid benchmark trial: ${trial && trial.id}`);
    }
    observedIds.add(trial.id);
  }
  if (
    !Number.isInteger(Number(manifest.concurrency)) ||
    Number(manifest.concurrency) < 1 ||
    Number(manifest.concurrency) > 4
  ) {
    throw new Error("Benchmark concurrency must be an integer between 1 and 4");
  }
  if (
    Number(manifest.schema_version || 0) >= 4 &&
    !CODEX_FEEDBACK_MODES.has(String(manifest.codex_feedback_mode || ""))
  ) {
    throw new Error("Benchmark manifest must pin codex_feedback_mode");
  }
}

function normalizeArms(value) {
  const arms = Array.isArray(value) ? value.map(String) : [...ARMS];
  if (!arms.length || new Set(arms).size !== arms.length) {
    throw new Error("Benchmark arms must be a non-empty unique list");
  }
  for (const arm of arms) {
    if (!SUPPORTED_ARMS.has(arm)) throw new Error(`Unsupported benchmark arm: ${arm}`);
  }
  if (!arms.includes("none") || !arms.includes("current")) {
    throw new Error("Benchmark arms must include none and current");
  }
  return arms;
}

function manifestArmIds(manifest) {
  const configured = Array.isArray(manifest && manifest.arms)
    ? manifest.arms.map((arm) => typeof arm === "string" ? arm : arm && arm.id)
    : ARMS;
  return normalizeArms(configured);
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

function defaultJobsDir(experimentId) {
  return path.join(
    REPO_ROOT,
    "research",
    "jobs",
    String(experimentId || "terminal-bench-2.1")
  );
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
    "  node research/benchmark/cli.js plan [--arms none,current] [--repeats 4] [--concurrency 1-4] [--experiment-id ID] [--out PLAN.json]",
    "  node research/benchmark/cli.js config --plan PLAN --trial TRIAL_ID",
    "  node research/benchmark/cli.js run --plan PLAN [--concurrency 1-4] [--trial TRIAL_ID] [--arm ARM] [--task TASK] [--max-trials N] [--force]",
    "  node research/benchmark/cli.js report --plan PLAN [--out REPORT.json]",
    "  node research/benchmark/cli.js static-report --plan PLAN [--out STATIC_REPORT.json]",
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
  DEFAULT_CODEX_FEEDBACK_MODE,
  EXPERIMENT_ID,
  TASKS,
  createManifest,
  harborResultSucceeded,
  jobName,
  latestJobDirectory,
  makeJobConfig,
  median,
  reportFromJobs,
  readGainFacts,
  readJsonLines,
  readModelVisibleCompressionFacts,
  observationCorporaFromJobs,
  captureMatchesManifest,
  readCodeModeExecCalls,
  resultMatchesManifest,
  retryJobName,
  summarizeTrials,
  trialCompleted,
  trialPassed,
};
