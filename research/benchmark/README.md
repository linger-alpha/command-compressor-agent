# Terminal-Bench 2.1 benchmark

This repository-only harness fixes the release experiment at:

- dataset: the official Harbor Hub package
  `terminal-bench/terminal-bench-2-1@latest`;
- tasks: `build-cython-ext`, `pypi-server`, `sqlite-with-gcov`, and
  `log-summary-date-ranges`;
- arms: no compression, Git `7830b17` (the 0.1.4 core), and the current core;
- the current arm is pinned to the Git commit recorded in the generated plan;
- four repeats per task and arm, for 48 trials total;
- Codex CLI with `gpt-5.6-luna`, `max` reasoning, seed `20260729`, and one
  trial at a time.

The harness uses the same current Codex hook adapter for both compression arms.
The legacy arm swaps only the compression core and rules to the exact Git
baseline. The controlled Harbor runner passes
`--dangerously-bypass-hook-trust` because the hook bundle was assembled locally
from the checked-out repository. Normal `cca install --codex` never bypasses
trust and still requires review through `/hooks`.

## Generate and inspect the fixed plan

```sh
node research/benchmark/cli.js plan \
  --out research/artifacts/tb21-plan.json

node research/benchmark/cli.js config \
  --plan research/artifacts/tb21-plan.json \
  --trial build-cython-ext--current--r1
```

## Run

Harbor 0.4 and Docker must be available. Override the auto-detected local
development paths when needed:

```sh
HARBOR_PYTHON=/path/to/python \
HARBOR_LAUNCHER=/path/to/harbor \
HARBOR_SOURCE=/path/to/harbor/src \
node research/benchmark/cli.js run \
  --plan research/artifacts/tb21-plan.json
```

For a real but bounded infrastructure smoke test, append `--max-trials 1`.
Use `--trial build-cython-ext--current--r1` to select the current-hook arm
explicitly.
The runner persists state after every sequential trial. Results and temporary
configs live under `research/jobs/`, which is excluded from Git and npm.
If the current runtime commit differs from the plan, or `bin/`, `src/`,
`rules/`, or `package.json` has uncommitted changes, the current arm refuses
to run. Reports also reject older current-arm artifacts whose commit metadata
does not match the plan.

## Report and release gate

```sh
node research/benchmark/cli.js report \
  --plan research/artifacts/tb21-plan.json \
  --out research/artifacts/tb21-report.json
```

The report fails the release gate unless all 48 results exist, the current arm
passes at least as often as the legacy arm and is within one pass of the
no-compression arm, matched successful triples reduce median input tokens by
at least 10% versus no compression and 5% versus legacy, and every completed
compression-arm trial contains actual CCA hook observations.

## Bounded feasibility result

On 2026-07-29, three `build-cython-ext` repeats produced nine result artifacts
with Codex CLI 0.146.0. Every verifier returned reward 1, but one result in each
arm also carried an agent exception. A reward-positive result with
`exception_info` is reported as passed but is excluded from matched token
metrics. Only repeat 1 is therefore a clean matched triplet:

| Arm | Reward | Exceptions | Input tokens | Hook observations | Hook-local output |
| --- | ---: | ---: | ---: | ---: | ---: |
| no compression | 1.0 | 0 | 3,556,308 | 0 | n/a |
| Git `7830b17` | 1.0 | 0 | 2,262,527 | 46 | 37,018 → 31,678 |
| current pipeline | 1.0 | 0 | 5,601,872 | 58 | 55,637 → 55,014 |

The current hook fired in the real model → Bash → PostToolUse path. A package
install observation changed from an estimated 969 tokens to 640 tokens and
recorded the splitter, scorer, planner, and static-rule path. No hook error was
recorded in either compression arm.

All three agents solved the task, but their command trajectories differed
substantially. The current arm used more total input tokens in this single
triplet and its hook-local reduction was more conservative than the legacy
arm. One sample cannot separate compression effects from trajectory variance,
so it is evidence of hook feasibility rather than a compression win.

Across all three reward-positive results per arm, the input-token medians were
3,556,308 for no compression, 2,459,443 for legacy, and 3,638,176 for the
current pipeline. Those all-result medians are diagnostic only: repeat 2 had
timeouts in the no-compression and current arms, while repeat 3 had a non-zero
agent exit in the legacy arm. The report records two reward triplets as
excluded by exceptions.

Only 9 of the required 48 results exist, and only one triplet is cleanly
matched. The report therefore fails the token checks and the complete-trial
check, and version 0.2.0 must not be released from this result.
