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

On 2026-07-30, two follow-up Docker/Harbor probes tested the parser's
`decision: "block"` path with unified exec left enabled. Codex treats this as
an error result, but the command has already executed. Both probes passed:

| Probe | Raw → compressed | Result |
| --- | ---: | --- |
| No semantic explanation; retained target | 978 → 91 tokens | target used, producer ran once |
| Hook explanation; target omitted from compressed output | 1,143 → 245 tokens across two replacements | task passed, but target was visible in command source |
| Production adapter wording; target omitted from compressed output | 1,075 → 174 tokens across two replacements | task passed, but target was visible in command source |
| Corrected black-box producer; production adapter | 919 → 85 tokens for the changed result | `raw_ref` read, producer ran once, reward 1 |

The rollout contained the compressed text instead of the original 120 lines.
One run followed the hook's explanation and searched the raw file, but the
original fixture also exposed the target literal in the command source. That
fixture is retained as model-visible replacement evidence but rejected as
conclusive fallback evidence. The corrected fixture uses a container-provided
producer whose target is absent from the instruction and command. The corrected
probe passed: its rollout shows one `block-producer` call, one subsequent
`sed` read of the supplied raw path, and the recovered target. CCA uses blocked
feedback only when compression actually changes the result, and explains that
the command already ran. Whitelisted, unchanged, and fail-open results return
no block decision.

The production replay also exposed a one-word follow-up result that the core
had classified as changed because its raw archive includes the command text.
The Codex adapter now applies an additional model-visible savings gate: the
complete explanation plus compressed result must be shorter than the actual
stdout/stderr, otherwise it returns no block decision.

The dynamic experiment can now measure real model-visible compression. The
blocked/failed presentation remains a known Codex UI semantic cost and should
be monitored for unnecessary retries in broader trials.

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

The completed fixed-input corpus contains all 30 no-compression trajectories:
ten tasks with three repeats each. All 30 executions ended without an
exception; 28 received reward 1 and two received reward 0. The hook captured
336 Bash Tool Results from all ten tasks.

| Same-input replay | Raw | 0.1.4 | Current | Current vs 0.1.4 |
| --- | ---: | ---: | ---: | ---: |
| All 336 outputs | 291,507 | 255,964 | 261,006 | 1.97% more |
| 224 general-command outputs | 153,643 | 126,618 | 123,142 | 2.75% fewer |

The all-output row includes command-policy passthroughs. The current runtime
keeps RTK, fallback reads, and inspection/read commands unchanged, as required
by the production policy. The 0.1.4 core did not consistently have that
boundary. For example, it reduced one 6,219-token `rg`/`sed` inspection result
to 641 tokens while the current runtime correctly kept all 6,219. Therefore the
all-output regression is primarily a policy-boundary difference, not a valid
reason to start compressing read commands again.

On general commands, the current runtime beat 0.1.4 in eight of ten tasks:

| Task | 0.1.4 | Current | Current vs 0.1.4 |
| --- | ---: | ---: | ---: |
| `regex-log` | 1,038 | 593 | 42.87% fewer |
| `code-from-image` | 687 | 505 | 26.49% fewer |
| `pypi-server` | 4,645 | 3,907 | 15.89% fewer |
| `nginx-request-logging` | 7,637 | 6,887 | 9.82% fewer |
| `sqlite-with-gcov` | 29,682 | 27,383 | 7.75% fewer |
| `build-cython-ext` | 28,442 | 27,247 | 4.20% fewer |
| `extract-elf` | 30,202 | 29,289 | 3.02% fewer |
| `count-dataset-tokens` | 19,232 | 19,042 | 0.99% fewer |
| `log-summary-date-ranges` | 1,777 | 1,886 | 6.13% more |
| `sqlite-db-truncate` | 3,276 | 6,403 | 95.45% more |

The current runtime retained all 62 critical lines and all 74 protected blocks.
The legacy core retained all critical lines but only 71.62% of protected blocks.
Within general commands, both retained all 24 critical lines, while current
retained all 41 protected blocks and legacy retained only 48.78%.

The largest general-command regression is safety-related. One
`sqlite-db-truncate` observation contained a 256-line opaque/hex block. The
current splitter assigned that block to lossless `opaque_encoded` preservation;
0.1.4 reduced the full observation from 4,943 to 365 estimated tokens. Removing
only the `sqlite-db-truncate` task from the aggregate makes current 5.35% smaller
than legacy, but the release calculation intentionally keeps the task. Safety
coverage cannot be discarded to make the ratio pass.

The corpus also exposed a separate, actionable splitter problem. One
437-line `build-cython-ext` output became 74 planned blocks: 72 short `light`
blocks, one `aggressive` block, and one preserved failure block. Because
head/tail and maximum-line limits operate inside each block, most short blocks
never reached a compression limit. A similar pattern appeared in a
182-line `count-dataset-tokens` output split into 30 blocks. The next policy
iteration should use this held-out corpus to reduce over-segmentation or
coalesce adjacent low-signal blocks without weakening encoded and error
preservation.

The deterministic 120-line download probe remains a useful second output
class: 928 raw tokens became 185 with 0.1.4 and 102 with current, or 44.86%
fewer than legacy. It does not contain critical or protected material.

The static gate correctly fails: current meets task coverage and 100% critical
and protected retention, but its 2.75% general-command improvement is below the
required 5%.

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
