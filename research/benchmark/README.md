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
The current arm refuses to run if `bin/`, `src/`, `rules/`, or `package.json`
differs from the commit pinned by the plan. Research-only commits are allowed
when those production paths are still byte-for-byte equivalent to the pinned
commit. Reports reject current-arm artifacts whose pinned runtime metadata
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

On 2026-07-29, three clean `build-cython-ext` repeats were completed with Codex
CLI 0.146.0. Earlier timeout, non-zero-exit, stale-runtime, Docker credential,
and missing-Compose attempts remain diagnostic artifacts but are not included.
Every result below has verifier reward 1 and no `exception_info`:

| Repeat | No compression | Git `7830b17` | Current pipeline |
| --- | ---: | ---: | ---: |
| r1 input tokens | 3,556,308 | 2,262,527 | 3,135,255 |
| r2 input tokens | 2,377,144 | 3,053,293 | 2,048,410 |
| r3 input tokens | 3,397,416 | 2,256,770 | 3,123,450 |
| median | 3,397,416 | 2,262,527 | 3,123,450 |

The current arm used fewer input tokens than no compression in every repeat:
11.84%, 13.83%, and 8.06% respectively. The fixed release calculation compares
arm medians, producing an 8.06% reduction, below the required 10%. Results
against the legacy arm were unstable: current was 38.57% worse in r1, 32.91%
better in r2, and 38.40% worse in r3. The median comparison is therefore
38.05% worse than legacy and fails the 5% improvement gate.

The local hook measurements tell a different and narrower story:

| Measurement over three repeats | Git `7830b17` | Current pipeline |
| --- | ---: | ---: |
| Hook observations | 129 | 156 |
| Changed observations | 19 | 80 |
| Raw output estimate | 147,060 | 136,425 |
| Output after hook | 137,874 | 127,720 |
| Command-policy passthrough output | 102,350 | 104,983 |
| Processable output | 44,710 | 31,442 |
| Total hook-local reduction | 6.25% | 6.38% |
| Reduction of processable output | 20.55% | 27.69% |
| Raw fallback reads | 0 | 0 |

Thus the current block pipeline was not more conservative on output that
reached it: it changed more observations and reduced the processable portion
more than the old core. It also delivered about 10,000 fewer estimated tool
output tokens in aggregate. The end-to-end input-token regression versus
legacy came from different Agent trajectories, not from a larger post-hook
output stream. Current made 27 more tool calls, mostly additional source
inspection, and used 135 distinct commands versus legacy's 110. Exact repeated
calls were similar (21 versus 19), so this was not a simple retry loop.

This does not prove that compression caused the longer trajectories, nor that
they were random. Model execution was nondeterministic and the three arms did
not share a controllable model seed. Because input usage re-counts accumulated
context across turns, call count and when large reads occur can dominate the
few thousand tokens directly saved by a hook. The planned four tasks and 48
trials remain necessary before drawing a general performance conclusion.

The current model-facing prefix is a single line containing only
`compressed output` and the fallback path; no score, tier, or strategy is
shown. Across the 80 changed outputs, that required prefix accounted for an
estimated 1,920 direct tokens before context replay. No fallback was read.
These three task trajectories contained no Base64, PEM, hex-dump, or other
encoded block, so real-task encoded preservation remains untested here even
though deterministic unit tests cover it.

The real model → Bash → PostToolUse replacement path worked in all three
current repeats, and all observed task-success checks pass. Only 9 of the
required 48 clean results exist, however, and both token gates fail. Version
0.2.0 must not be released from this result.
