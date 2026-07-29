# Terminal-Bench 2.1 benchmark

This directory is repository-only and never enters the npm package.

## Fixed 10 × 3 experiment

The release experiment is fixed at:

- official Harbor Hub dataset
  `terminal-bench/terminal-bench-2-1@latest`;
- ten tasks: `build-cython-ext`, `pypi-server`, `sqlite-with-gcov`,
  `log-summary-date-ranges`, `regex-log`, `nginx-request-logging`,
  `extract-elf`, `sqlite-db-truncate`, `code-from-image`, and
  `count-dataset-tokens`;
- three arms: no compression, Git `7830b17` (0.1.4), and the current
  production runtime pinned by commit;
- three repeats per task and arm, for 90 dynamic trials;
- Codex CLI with `gpt-5.6-luna`, `max` reasoning, seed `20260729`, and one
  trial at a time.

Every arm records all Bash Tool Results. The primary fixed-input corpus is
formed only from no-compression trajectories, then the exact same records are
replayed through 0.1.4 and the current compressor. The union of all three arms
is reported only as a diagnostic because compression can change the Agent
trajectory.

Generate the plan:

```sh
node research/benchmark/cli.js plan \
  --out research/artifacts/tb21-10x3-plan.json
```

Inspect or run one trial:

```sh
node research/benchmark/cli.js config \
  --plan research/artifacts/tb21-10x3-plan.json \
  --trial regex-log--current--r1

node research/benchmark/cli.js run \
  --plan research/artifacts/tb21-10x3-plan.json \
  --trial regex-log--current--r1
```

The runner also accepts `--arm`, `--task`, `--max-trials`, and `--force`.
For example, `--arm none` collects only the unbiased static-replay corpus.
State is persisted after every sequential trial under `research/jobs/`.

## Model-visible replacement gate

A hook process returning compressed text is not sufficient evidence that the
Agent received it. The report audits Codex rollout JSONL and requires:

1. both compression arms actually produce at least one changed result;
2. every changed hook result appears as compressed text in the corresponding
   model-visible tool result;
3. all Tool Results are captured and task revisions have consistent checksums.

This gate corrected an earlier interpretation of the benchmark.

On 2026-07-29, a dedicated Docker/Harbor probe used Codex CLI 0.146.0 and
`gpt-5.6-luna` max. The task forced one deterministic 120-line download result.
The task passed with reward 1 and no exception. CCA compressed the result from
about 928 to 85 estimated tokens, but the rollout still contained all 120
original lines and no compressed marker:

| Probe fact | Value |
| --- | ---: |
| Hook changed results | 1 |
| Hook raw tokens | 928 |
| Hook compressed tokens | 85 |
| Model-visible compressed results | 0 |
| Code-mode `exec` calls | 2 |
| Task reward | 1 |

Explicitly disabling `unified_exec`, `code_mode`, and `code_mode_only` changed
the inner shell API but did not remove Luna's outer code-mode `exec` call.
Codex did execute the trusted `PostToolUse` hook without an error; it ignored
the replacement when constructing the code-mode result.

This matches the released Codex source: `PostToolUseFeedbackOutput` substitutes
the ordinary `to_response_item`, while its `code_mode_result` delegates to the
original output:

- [Codex 0.146.0 tool registry](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/core/src/tools/registry.rs)
- [Codex 0.146.0 PostToolUse parser](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/hooks/src/events/post_tool_use.rs)

Therefore the earlier three-arm `build-cython-ext` runs do prove that the hook
installed, ran without crashing, and coexisted with successful tasks. They do
not prove that compression affected the model input. Their cross-arm token
differences are trajectory variance, not valid compression-effect estimates.

The complete 90-trial dynamic experiment is intentionally paused until the
probe's model-visible replacement check passes. Running it now would spend
substantial compute on three nominal arms whose model-visible Tool Results are
actually unchanged.

## Reproduce the hook probe

Generate an absolute, commit-pinned Harbor config:

```sh
node research/benchmark/hook-probe.js config \
  --arm current \
  --out research/artifacts/hook-probe-current.json
```

Run it with the same Harbor environment used by the benchmark, then audit the
job:

```sh
node research/benchmark/hook-probe.js report \
  --job-dir research/jobs/hook-probe/JOB_NAME
```

The report fails unless the task completes, a compressible output is exercised,
and every hook replacement is present in the model-visible rollout.

## Fixed-input static replay

Generate the static report from all captured results:

```sh
node research/benchmark/cli.js static-report \
  --plan research/artifacts/tb21-10x3-plan.json \
  --out research/artifacts/tb21-10x3-static-report.json
```

The current partial corpus contains three clean no-compression `regex-log`
trajectories with thirteen Tool Results:

| Same-input replay | Raw | 0.1.4 | Current | Current vs 0.1.4 |
| --- | ---: | ---: | ---: | ---: |
| All thirteen outputs | 1,358 | 1,358 | 913 | 32.77% fewer |
| Ten general commands | 1,038 | 1,038 | 593 | 42.87% fewer |

The trajectory-level result explains the spread:

| Repeat | Tool Results | Raw/0.1.4 | Current | Current vs 0.1.4 |
| --- | ---: | ---: | ---: | ---: |
| r1, all output | 2 | 267 | 171 | 35.96% fewer |
| r2, all output | 10 | 985 | 636 | 35.43% fewer |
| r3, all output | 1 | 106 | 106 | unchanged |
| r1, general commands | 1 | 148 | 52 | 64.86% fewer |
| r2, general commands | 9 | 890 | 541 | 39.21% fewer |

The single r3 Tool Result was a command-policy passthrough, so no general
command row exists for r3. Its zero reduction is intentional, not a compressor
failure. The 0.1.4 core changed none of the thirteen observations.

The deterministic download probe provides a second output class:

| Same-input replay | Raw | 0.1.4 | Current | Current vs 0.1.4 |
| --- | ---: | ---: | ---: | ---: |
| 120 progress lines | 928 | 185 | 102 | 44.86% fewer |

These results verify that the current deterministic compressor beats 0.1.4 on
the currently observed ordinary and progress-heavy fixed inputs. They are not
yet a general result: the primary corpus covers only one of ten tasks and has
zero critical lines and zero encoded/protected blocks. Static release checks
now require positive critical and protected coverage, so a vacuous retention
ratio cannot pass.

## Release gates

The dynamic report is generated with:

```sh
node research/benchmark/cli.js report \
  --plan research/artifacts/tb21-10x3-plan.json \
  --out research/artifacts/tb21-10x3-report.json
```

It requires all 90 results, current task passes no lower than legacy and no
more than one below no compression, matched-success input-token medians at
least 10% below no compression and 5% below legacy, working capture and hook
coverage, consistent task revisions, and verified model-visible replacements.

The static report separately requires all ten tasks, non-empty critical and
protected samples, 100% retention of both, and at least 5% fewer tokens than
0.1.4 on general commands. Version 0.2.0 must not be released until both sets
of gates pass.
