"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { handlePayload } = require("../hook-runner");
const { buildProbeConfig, buildProbeReport } = require("../hook-probe");
const { buildStaticReplayReport } = require("../static-replay");
const {
  codexVisibleFacts,
  selectCandidate,
  splitForRecord,
} = require("../splitter-merge-study");
const {
  ARMS,
  captureMatchesManifest,
  createManifest,
  harborResultSucceeded,
  jobName,
  latestJobDirectory,
  makeJobConfig,
  readGainFacts,
  readCodeModeExecCalls,
  readJsonLines,
  readModelVisibleCompressionFacts,
  resultMatchesManifest,
  retryJobName,
  summarizeTrials,
  trialCompleted,
} = require("../cli");

function successfulResult(inputTokens, hookObservations) {
  return {
    exception_info: null,
    agent_result: { n_input_tokens: inputTokens },
    verifier_result: { rewards: { reward: 1 } },
    cca_hook_observations: hookObservations,
    cca_hook_changed_observations: hookObservations,
    cca_hook_raw_tokens_est: hookObservations * 100,
    cca_hook_compressed_tokens_est: hookObservations * 75,
    cca_hook_saved_tokens_est: hookObservations * 25,
    cca_hook_command_passthrough_observations: 0,
    cca_hook_command_passthrough_raw_tokens_est: 0,
    cca_hook_fallback_observations: 0,
    cca_observation_artifact: true,
    cca_captured_observations: 2,
    cca_captured_output_observations: 2,
    cca_model_visible_compressed_observations: hookObservations,
    task_checksum: "fixture-checksum",
    cca_code_mode_exec_calls: 0,
  };
}

(() => {
  assert.deepStrictEqual(
    codexVisibleFacts(
      { stdout: "short", stderr: "" },
      { changed: true, text: "x" }
    ),
    { tokens: 2, changed: false },
    "Codex explanation overhead must cancel replacements without visible savings"
  );
  const visibleFacts = codexVisibleFacts(
    { stdout: "ordinary output ".repeat(1000), stderr: "" },
    { changed: true, text: "[compressed output]\nshort" }
  );
  assert.strictEqual(visibleFacts.changed, true);
  assert(visibleFacts.tokens < 100);

  assert.strictEqual(splitForRecord({ repeat: 1 }), "train");
  assert.strictEqual(splitForRecord({ repeat: 2 }), "validation");
  assert.strictEqual(splitForRecord({ repeat: 3 }), "test");
  const safeMetrics = (reduction, overrides = {}) => ({
    reduction_vs_current: reduction,
    critical_fact_retention: 1,
    protected_block_retention: 1,
    encoded_block_retention: 1,
    passthrough_violations: 0,
    ...overrides,
  });
  const selection = selectCandidate([
    {
      id: "validation-winner",
      merge: { max_separator_lines: 2 },
      metrics: {
        train_general: safeMetrics(0.1),
        validation_general: safeMetrics(0.2),
        test_general: safeMetrics(-0.5),
      },
    },
    {
      id: "test-winner",
      merge: { max_separator_lines: 1 },
      metrics: {
        train_general: safeMetrics(0.1),
        validation_general: safeMetrics(0.1),
        test_general: safeMetrics(0.9),
      },
    },
    {
      id: "unsafe-validation",
      merge: { max_separator_lines: 4 },
      metrics: {
        train_general: safeMetrics(0.3),
        validation_general: safeMetrics(0.3, { encoded_block_retention: 0.9 }),
        test_general: safeMetrics(0.3),
      },
    },
  ]);
  assert.strictEqual(
    selection.selected,
    "validation-winner",
    "held-out test metrics must not influence candidate selection"
  );
  assert.strictEqual(selection.accepted, false, "the held-out test remains an acceptance gate");

  const first = createManifest({ seed: 20260729, repeats: 3 });
  const second = createManifest({ seed: 20260729, repeats: 3 });
  assert.strictEqual(first.trials.length, 90);
  assert.match(first.current_commit, /^[a-f0-9]{40}$/);
  assert.deepStrictEqual(
    first.trials.map((trial) => trial.id),
    second.trials.map((trial) => trial.id),
    "the fixed seed must reproduce the same order"
  );
  for (const arm of ARMS) {
    assert.strictEqual(first.trials.filter((trial) => trial.arm === arm).length, 30);
  }
  const paired = createManifest({
    seed: 20260729,
    repeats: 4,
    arms: ["none", "current"],
    experimentId: "terminal-bench-2.1-10x4-rc1",
    currentLabel: "cca-0.2.0-rc.1",
  });
  assert.strictEqual(paired.trials.length, 80);
  assert.strictEqual(paired.experiment_id, "terminal-bench-2.1-10x4-rc1");
  assert.deepStrictEqual(paired.arms, [
    { id: "none", label: "no-compression" },
    { id: "current", label: "cca-0.2.0-rc.1" },
  ]);
  assert.throws(
    () => createManifest({ arms: ["current"] }),
    /must include none and current/
  );
  assert.strictEqual(createManifest({ concurrency: 2 }).concurrency, 2);
  assert.throws(
    () => createManifest({ concurrency: 5 }),
    /between 1 and 4/
  );
  const malformedPaired = structuredClone(paired);
  malformedPaired.trials[0].arm = "legacy";
  assert.throws(
    () => summarizeTrials(malformedPaired, new Map()),
    /Invalid benchmark trial/
  );
  assert.notDeepStrictEqual(
    first.trials.map((trial) => trial.id),
    createManifest({ seed: 1, repeats: 3 }).trials.map((trial) => trial.id)
  );

  const config = makeJobConfig(first.trials[0], {
    jobsDir: "/tmp/cca-jobs",
    repoRoot: "/tmp/cca-repo",
    currentCommit: first.current_commit,
  });
  assert.strictEqual(config.n_concurrent_trials, 1);
  assert.strictEqual(config.agents[0].model_name, "gpt-5.6-luna");
  assert.strictEqual(config.agents[0].kwargs.reasoning_effort, "max");
  assert.strictEqual(config.agents[0].kwargs.feedback_mode, "block-explained");
  assert.strictEqual(config.agents[0].kwargs.current_commit, first.current_commit);
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
  assert.strictEqual(resultMatchesManifest(
    { arm: "current" },
    {
      cca_arm_metadata: {
        arm: "current",
        current_commit: first.current_commit,
        unified_exec: true,
        requested_code_mode: true,
        feedback_mode: "block-explained",
      },
    },
    first
  ).matches, true);
  assert.strictEqual(resultMatchesManifest(
    { arm: "current" },
    {
      cca_arm_metadata: {
        arm: "current",
        current_commit: "0".repeat(40),
        unified_exec: true,
        requested_code_mode: true,
        feedback_mode: "block-explained",
      },
    },
    first
    ).matches, false);
  assert.strictEqual(resultMatchesManifest(
    { arm: "current" },
    {
      cca_arm_metadata: {
        arm: "current",
        current_commit: first.current_commit,
        unified_exec: false,
        requested_code_mode: false,
        feedback_mode: "replacement",
      },
    },
    first
  ).reason, "codex-feedback-mode-mismatch");
  assert.strictEqual(captureMatchesManifest(
    { arm: "none" },
    { cca_arm_metadata: { arm: "none" } },
    first
  ).matches, true, "static captures do not depend on Codex execution mode");

  const retryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cca-benchmark-test-"));
  try {
    const gainPath = path.join(retryRoot, "gain.jsonl");
    fs.writeFileSync(gainPath, [
      JSON.stringify({
        raw_tokens_est: 100,
        compressed_tokens_est: 100,
        saved_tokens_est: 0,
        changed: false,
        rules: ["read_only_passthrough"],
      }),
      "not json",
      JSON.stringify({
        raw_tokens_est: 80,
        compressed_tokens_est: 20,
        saved_tokens_est: 60,
        changed: true,
        rules: ["importance_light_compress"],
      }),
      JSON.stringify({
        raw_tokens_est: 40,
        compressed_tokens_est: 40,
        saved_tokens_est: 0,
        changed: false,
        rules: ["raw_fallback_read_passthrough"],
      }),
      "",
    ].join("\n"));
    assert.deepStrictEqual(readGainFacts(gainPath), {
      cca_hook_observations: 3,
      cca_hook_changed_observations: 1,
      cca_hook_raw_tokens_est: 220,
      cca_hook_compressed_tokens_est: 160,
      cca_hook_saved_tokens_est: 60,
      cca_hook_command_passthrough_observations: 2,
      cca_hook_command_passthrough_raw_tokens_est: 140,
      cca_hook_fallback_observations: 1,
    });

    const observationsPath = path.join(retryRoot, "observations.jsonl");
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "printf hello" },
      tool_response: { stdout: "hello\n", stderr: "warn\n", exit_code: 2 },
    };
    assert.deepStrictEqual(handlePayload(payload, {
      CCA_BENCHMARK_ARM: "none",
      CCA_OBSERVATIONS_PATH: observationsPath,
    }), {});
    assert.deepStrictEqual(readJsonLines(observationsPath), [{
      schema_version: 1,
      command: "printf hello",
      stdout: "hello\n",
      stderr: "warn\n",
      exit_code: 2,
      agent: "codex",
      tool_name: "Bash",
    }]);
    assert.deepStrictEqual(handlePayload({
      tool_name: "Bash",
      tool_input: { command: "printf string-result" },
      tool_response: "Chunk ID: abc\nProcess exited with code 0\nFinal output:\nstring-result",
    }, {
      CCA_BENCHMARK_ARM: "none",
      CCA_OBSERVATIONS_PATH: observationsPath,
    }), {});
    assert.strictEqual(
      readJsonLines(observationsPath)[1].stdout,
      "Chunk ID: abc\nProcess exited with code 0\nFinal output:\nstring-result"
    );
    assert.strictEqual(readJsonLines(observationsPath)[1].exit_code, null);
    const runtimeConfigPath = path.join(retryRoot, "runtime-config.json");
    fs.writeFileSync(runtimeConfigPath, JSON.stringify({
      version: 1,
      strength: "xhigh",
      rulesPath: path.resolve(__dirname, "..", "..", "..", "rules", "default-rules.json"),
      rawDir: path.join(retryRoot, "raw"),
      metricsPath: path.join(retryRoot, "gain-current.jsonl"),
    }));
    const currentPatch = handlePayload({
      tool_name: "Bash",
      tool_input: { command: "python -m pip install demo" },
      tool_response: {
        stdout: Array.from(
          { length: 80 },
          (_, index) => `Downloading demo ${index + 1}% 1MB/s`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
    }, {
      CCA_BENCHMARK_ARM: "current",
      CCA_OBSERVATIONS_PATH: observationsPath,
      CCA_CONFIG_PATH: runtimeConfigPath,
      CCA_RUNTIME_ROOT: path.resolve(__dirname, "..", "..", ".."),
    });
    assert.strictEqual(currentPatch.continue, false);
    assert.match(currentPatch.stopReason, /compressed output/);
    assert.strictEqual(readJsonLines(observationsPath).length, 3);
    const blockPatch = handlePayload({
      tool_name: "Bash",
      tool_input: { command: "python -m pip install demo" },
      tool_response: {
        stdout: Array.from(
          { length: 80 },
          (_, index) => `Downloading demo ${index + 1}% 1MB/s`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
    }, {
      CCA_BENCHMARK_ARM: "current",
      CCA_CODEX_FEEDBACK_MODE: "block",
      CCA_OBSERVATIONS_PATH: observationsPath,
      CCA_CONFIG_PATH: runtimeConfigPath,
      CCA_RUNTIME_ROOT: path.resolve(__dirname, "..", "..", ".."),
    });
    assert.strictEqual(blockPatch.decision, "block");
    assert.match(blockPatch.reason, /compressed output/);
    assert.match(blockPatch.reason, /fallback raw_ref/);
    assert.strictEqual(blockPatch.continue, undefined);
    assert.strictEqual(readJsonLines(observationsPath).length, 4);
    const explainedBlockPatch = handlePayload({
      tool_name: "Bash",
      tool_input: { command: "python -m pip install demo" },
      tool_response: {
        stdout: Array.from(
          { length: 80 },
          (_, index) => `Downloading demo ${index + 1}% 1MB/s`
        ).join("\n"),
        stderr: "",
        exit_code: 0,
      },
    }, {
      CCA_BENCHMARK_ARM: "current",
      CCA_CODEX_FEEDBACK_MODE: "block-explained",
      CCA_OBSERVATIONS_PATH: observationsPath,
      CCA_CONFIG_PATH: runtimeConfigPath,
      CCA_RUNTIME_ROOT: path.resolve(__dirname, "..", "..", ".."),
    });
    assert.strictEqual(explainedBlockPatch.decision, "block");
    assert.match(explainedBlockPatch.reason, /^The command already ran\./);
    assert.match(
      explainedBlockPatch.reason,
      /search the raw_ref below locally instead of rerunning/
    );
    assert.match(explainedBlockPatch.reason, /fallback raw_ref/);
    assert.strictEqual(readJsonLines(observationsPath).length, 5);

    const trialDir = path.join(retryRoot, "trial");
    const sessionDir = path.join(trialDir, "agent", "sessions", "2026", "07");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "rollout.jsonl"), [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: "[compressed output; fallback raw_ref: /tmp/raw]\nkept",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: [{ type: "input_text", text: "unchanged" }],
        },
      }),
      "",
    ].join("\n"));
    assert.strictEqual(readModelVisibleCompressionFacts(trialDir), 1);
    assert.strictEqual(readCodeModeExecCalls(trialDir), 0);
    fs.appendFileSync(path.join(sessionDir, "rollout.jsonl"), `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "text('probe')",
      },
    })}\n`);
    assert.strictEqual(readCodeModeExecCalls(trialDir), 1);
    const trialArtifacts = path.join(trialDir, "artifacts");
    fs.mkdirSync(trialArtifacts);
    fs.copyFileSync(gainPath, path.join(trialArtifacts, "cca-gain.jsonl"));
    fs.writeFileSync(path.join(trialDir, "result.json"), JSON.stringify({
      exception_info: null,
      verifier_result: { rewards: { reward: 1 } },
    }));
    const probeReport = buildProbeReport(retryRoot);
    assert.strictEqual(probeReport.passed, true);
    assert.strictEqual(probeReport.code_mode_exec_calls, 1);

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

  const probeConfig = buildProbeConfig({
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    suffix: "fixture",
  });
  assert.strictEqual(
    probeConfig.job_name,
    "cca-codex-hook-probe-current-replacement-hook-probe-fixture"
  );
  assert.strictEqual(probeConfig.n_concurrent_trials, 1);
  assert.match(
    probeConfig.agents[0].kwargs.current_commit,
    /^[a-f0-9]{40}$/
  );
  const blockProbeConfig = buildProbeConfig({
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    feedbackMode: "block-explained",
    fixture: "hook-block-probe-explained",
    suffix: "fixture",
  });
  assert.strictEqual(
    blockProbeConfig.agents[0].kwargs.feedback_mode,
    "block-explained"
  );
  assert.match(
    blockProbeConfig.tasks[0].path,
    /hook-block-probe-explained$/
  );
  const splitterProbeConfig = buildProbeConfig({
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    feedbackMode: "block-explained",
    fixture: "hook-splitter-merge-probe",
    suffix: "fixture",
  });
  assert.match(
    splitterProbeConfig.tasks[0].path,
    /hook-splitter-merge-probe$/
  );

  const results = new Map();
  for (const trial of first.trials) {
    const tokens = trial.arm === "none" ? 1000 : trial.arm === "legacy" ? 900 : 800;
    results.set(trial.id, successfulResult(tokens, trial.arm === "none" ? 0 : 2));
  }
  const report = summarizeTrials(first, results);
  assert.strictEqual(report.release_gate.passed, true);
  assert.strictEqual(report.matched_successful_groups, 30);
  assert.strictEqual(report.by_arm.current.passed, 30);
  assert.strictEqual(report.by_arm.current.completed, 30);
  assert.strictEqual(report.by_arm.current.hook_local_reduction, 0.25);
  assert.strictEqual(report.by_arm.current.hook_processable_reduction, 0.25);
  assert.strictEqual(report.release_gate.checks.tool_results_captured, true);
  assert.strictEqual(report.release_gate.checks.task_versions_consistent, true);
  assert.strictEqual(
    report.release_gate.checks.compression_replacements_model_visible,
    true
  );
  assert.strictEqual(report.release_gate.checks.compression_replacements_exercised, true);
  assert(report.input_token_reduction.current_vs_none >= 0.1);
  assert(report.input_token_reduction.current_vs_legacy >= 0.05);

  const pairedResults = new Map();
  for (const trial of paired.trials) {
    const tokens = trial.arm === "none" ? 1000 : 800;
    pairedResults.set(
      trial.id,
      successfulResult(tokens, trial.arm === "none" ? 0 : 2)
    );
  }
  const pairedReport = summarizeTrials(paired, pairedResults);
  assert.strictEqual(pairedReport.release_gate.passed, true);
  assert.strictEqual(pairedReport.planned_trials, 80);
  assert.strictEqual(pairedReport.matched_successful_groups, 40);
  assert.deepStrictEqual(Object.keys(pairedReport.by_arm), ["none", "current"]);
  assert.strictEqual(
    pairedReport.release_gate.checks.current_passes_at_least_legacy,
    undefined
  );
  assert.strictEqual(pairedReport.input_token_reduction.current_vs_legacy, undefined);

  const missingTrial = first.trials[0];
  results.delete(missingTrial.id);
  const partial = summarizeTrials(first, results);
  assert.strictEqual(partial.release_gate.passed, false);
  assert.strictEqual(partial.release_gate.checks.all_planned_trials_present, false);

  const erroredButRewarded = new Map(results);
  const completedTrial = first.trials.find((trial) =>
    erroredButRewarded.has(trial.id) &&
    (trial.task !== missingTrial.task || trial.repeat !== missingTrial.repeat)
  );
  erroredButRewarded.set(completedTrial.id, {
    ...erroredButRewarded.get(completedTrial.id),
    exception_info: { exception_type: "AgentTimeoutError" },
  });
  const erroredReport = summarizeTrials(first, erroredButRewarded);
  assert.strictEqual(trialCompleted(erroredButRewarded.get(completedTrial.id)), false);
  assert.strictEqual(
    erroredReport.matched_successful_groups,
    28,
    "the earlier deleted trial and the errored reward must not enter matched token metrics"
  );
  assert.strictEqual(erroredReport.matched_reward_groups_excluded_by_exception, 1);

  const repeatedProgress = Array.from(
    { length: 80 },
    (_, index) => `Downloading shard ${index + 1} ${index + 1}%`
  ).join("\n");
  const staticRecords = [{
    id: "fixture:1",
    source: "fixture",
    task: "fixture",
    trial_id: "fixture--none--r1",
    command: "python build.py",
    stdout: `${repeatedProgress}\nERROR: build failed at src/main.c:42\n`,
    stderr: "",
    exit_code: 1,
  }, {
    id: "fixture:2",
    source: "fixture",
    task: "fixture",
    trial_id: "fixture--none--r2",
    command: "python emit.py",
    stdout: `${"QUJD".repeat(80)}\n`,
    stderr: "",
    exit_code: 0,
  }];
  const staticReport = buildStaticReplayReport({
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    experimentId: "fixture",
    baselineCommit: "7830b17",
    currentCommit: first.current_commit,
    expectedTasks: ["fixture"],
    primaryRecords: staticRecords,
    unionRecords: staticRecords,
    corpusStats: { primary_observations: staticRecords.length },
  });
  assert.strictEqual(staticReport.primary_all_outputs.eligible_records, 2);
  assert.strictEqual(
    staticReport.primary_all_outputs_by_trial["fixture--none--r1"].records,
    1
  );
  assert.strictEqual(staticReport.primary_all_outputs.critical_fact_retention, 1);
  assert.strictEqual(staticReport.primary_all_outputs.protected_block_retention, 1);
  assert.strictEqual(staticReport.static_checks.checks.critical_fact_coverage_present, true);
  assert.strictEqual(staticReport.static_checks.checks.protected_block_coverage_present, true);
  assert.strictEqual(
    staticReport.static_checks.checks.all_selected_tasks_observed,
    true
  );

  process.stdout.write("benchmark tests passed\n");
})();
