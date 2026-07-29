"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ARMS,
  createManifest,
  harborResultSucceeded,
  jobName,
  latestJobDirectory,
  makeJobConfig,
  retryJobName,
  summarizeTrials,
} = require("../cli");

function successfulResult(inputTokens, hookObservations) {
  return {
    exception_info: null,
    agent_result: { n_input_tokens: inputTokens },
    verifier_result: { rewards: { reward: 1 } },
    cca_hook_observations: hookObservations,
  };
}

(() => {
  const first = createManifest({ seed: 20260729, repeats: 4 });
  const second = createManifest({ seed: 20260729, repeats: 4 });
  assert.strictEqual(first.trials.length, 48);
  assert.deepStrictEqual(
    first.trials.map((trial) => trial.id),
    second.trials.map((trial) => trial.id),
    "the fixed seed must reproduce the same order"
  );
  for (const arm of ARMS) {
    assert.strictEqual(first.trials.filter((trial) => trial.arm === arm).length, 16);
  }
  assert.notDeepStrictEqual(
    first.trials.map((trial) => trial.id),
    createManifest({ seed: 1, repeats: 4 }).trials.map((trial) => trial.id)
  );

  const config = makeJobConfig(first.trials[0], {
    jobsDir: "/tmp/cca-jobs",
    repoRoot: "/tmp/cca-repo",
  });
  assert.strictEqual(config.n_concurrent_trials, 1);
  assert.strictEqual(config.agents[0].model_name, "gpt-5.6-luna");
  assert.strictEqual(config.agents[0].kwargs.reasoning_effort, "max");
  assert.strictEqual(config.datasets[0].name, "terminal-bench/terminal-bench-2-1");
  assert.strictEqual(config.datasets[0].ref, "latest");
  assert.deepStrictEqual(config.datasets[0].task_names, [
    `terminal-bench/${first.trials[0].task}`,
  ]);

  assert.strictEqual(harborResultSucceeded({
    n_total_trials: 1,
    stats: { n_trials: 1, n_errors: 0 },
  }), true);
  assert.strictEqual(harborResultSucceeded({
    n_total_trials: 1,
    stats: { n_trials: 1, n_errors: 1 },
  }), false, "an errored Harbor job must not be recorded as completed");
  assert.strictEqual(harborResultSucceeded(null), false);

  const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cca-benchmark-test-"));
  try {
    const trial = first.trials[0];
    fs.mkdirSync(path.join(retryRoot, jobName(trial)));
    fs.mkdirSync(path.join(retryRoot, retryJobName(trial, 2)));
    assert.strictEqual(
      latestJobDirectory(retryRoot, trial),
      path.join(retryRoot, retryJobName(trial, 2))
    );
  } finally {
    fs.rmSync(retryRoot, { recursive: true, force: true });
  }

  const results = new Map();
  for (const trial of first.trials) {
    const tokens = trial.arm === "none" ? 1000 : trial.arm === "legacy" ? 900 : 800;
    results.set(trial.id, successfulResult(tokens, trial.arm === "none" ? 0 : 2));
  }
  const report = summarizeTrials(first, results);
  assert.strictEqual(report.release_gate.passed, true);
  assert.strictEqual(report.matched_successful_triplets, 16);
  assert.strictEqual(report.by_arm.current.passed, 16);
  assert(report.input_token_reduction.current_vs_none >= 0.1);
  assert(report.input_token_reduction.current_vs_legacy >= 0.05);

  results.delete(first.trials[0].id);
  const partial = summarizeTrials(first, results);
  assert.strictEqual(partial.release_gate.passed, false);
  assert.strictEqual(partial.release_gate.checks.all_48_trials_present, false);

  process.stdout.write("benchmark tests passed\n");
})();
