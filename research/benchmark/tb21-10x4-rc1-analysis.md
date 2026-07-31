# Terminal-Bench 2.1: 0.2.0-rc.1 paired experiment

## Scope

This experiment compared no compression with commit-pinned
`0.2.0-rc.1` (`00e82faa58d1fcba18e96b9c911df88db249d411`) on ten
Terminal-Bench 2.1 tasks. Each task and arm ran four times with Codex CLI,
`gpt-5.6-luna`, `max` reasoning, and seed `20260729`.

All 80 planned trials produced valid Harbor results. Three early Agent setup
failures caused by transient apt mirror EOF responses were retried and are not
counted as task results. The first 37 valid trials ran sequentially. After
validating bounded worker state updates, the remaining queue ran with two
workers. No new infrastructure failure occurred under two-worker execution.

## Experiment configuration

| Setting | Value |
| --- | --- |
| Dataset | `terminal-bench/terminal-bench-2-1@latest` |
| Tasks | `build-cython-ext`, `pypi-server`, `sqlite-with-gcov`, `log-summary-date-ranges`, `regex-log`, `nginx-request-logging`, `extract-elf`, `sqlite-db-truncate`, `code-from-image`, `count-dataset-tokens` |
| Agent runtime | Codex CLI through Harbor, with each task running in its isolated Docker environment |
| Model | `gpt-5.6-luna` |
| Reasoning effort | `max` |
| Arms | `no-compression` and CCA 0.2.0-rc.1 (`00e82faa58d1fcba18e96b9c911df88db249d411`) |
| Repetitions | Four per task and arm, for 80 valid trials |
| Trial ordering | Randomized with seed `20260729`; this controls queue order, not model sampling |
| Concurrency | First 37 valid trials at one worker; remaining 43 at two workers |
| Infrastructure retries | Three transient apt-mirror EOF setup failures retried and excluded |
| Task identity | Revisions checked by per-task checksums in the generated dynamic report |

Dynamic model-input counts come from Codex and cover the complete Agent
trajectory, including any change in commands or reasoning path. Hook-level and
fixed-input counts use CCA's local token estimator and cover Tool Results only.
The fixed-input replay uses the 523 Tool Results captured from the 40
no-compression trials, comparing raw output, Git baseline `7830b17` (0.1.4),
and the post-experiment rc.2 candidate rules.

## Dynamic result

| Task | No compression | 0.2.0-rc.1 |
| --- | ---: | ---: |
| build-cython-ext | 4/4 | 4/4 |
| pypi-server | 0/4 | 0/4 |
| sqlite-with-gcov | 4/4 | 3/4 |
| log-summary-date-ranges | 4/4 | 4/4 |
| regex-log | 4/4 | 4/4 |
| nginx-request-logging | 4/4 | 4/4 |
| extract-elf | 3/4 | 4/4 |
| sqlite-db-truncate | 4/4 | 4/4 |
| code-from-image | 4/4 | 4/4 |
| count-dataset-tokens | 3/4 | 2/4 |
| **Total** | **34/40** | **33/40** |

Of the 40 strict task/repeat pairs, 32 passed in both arms, five failed in both,
one passed only with compression, and two passed only without compression.
The prerelease therefore meets the quality gate that allows at most one fewer
pass than no compression, but does not demonstrate a pass-rate improvement.

The 32 pairs where both arms passed had median model input counts of 198,703.5
without compression and 182,351.5 with compression, an 8.23% reduction. This
misses the prerelease plan's 10% dynamic target.

Dynamic input counts include the whole evolving Agent trajectory, not only Tool
Results. The current arm made 663 code-mode exec calls and captured 642 Tool
Results, compared with 632 calls and 523 captures in the no-compression arm.
This trajectory variance explains why fixed-output compression and end-to-end
model input do not have the same reduction.

## Hook behavior

The current arm recorded 639 hook observations. Twenty-nine were actually
replaced and all 29 replacements were visible in Codex rollouts. A report bug
initially counted 31 because searches over `/logs/agent` echoed two old
`[compressed output]` markers; model-visible accounting now deduplicates by
`raw_ref`.

| Hook measure | Result |
| --- | ---: |
| Raw Tool Result tokens (estimated) | 407,450 |
| Model-visible tokens after the adapter gate | 368,265 |
| Saved tokens (estimated) | 39,185 |
| Reduction across every current-arm Tool Result | 9.62% |
| Read/RTK/compatibility passthrough observations | 236 |
| Passthrough raw tokens | 229,648 |
| Reduction on processable Tool Results | 22.04% |
| Fallback reads in these 40 trials | 0 |

One changed install command was run again, but only after additional tests and
source fixes; it was a legitimate reinstall, not an immediate retry caused by
Codex's `decision: "block"` presentation.

## Unequal pairs

`extract-elf` repeat 2 passed with compression and failed without compression.
The compressed run replaced five long `nm`, `readelf`, and `objdump` results,
reducing their aggregate trajectory Tool Results from about 27,018 to 19,226
estimated tokens. No base64-like long encoded line was present. This is
evidence that long binary-analysis text can be compressed successfully, but a
single pair does not establish causality.

`sqlite-with-gcov` repeat 1 passed without compression and failed with
compression. The only replacement was apt installation noise (about 6,006 to
2,620 tokens). The Agent successfully built and ran SQLite, but left `.gcda`
files under a temporary build directory while the verifier required them
under `/app/sqlite`. The retained output showed successful installation; there
is no identified missing apt fact that explains the layout mistake.

`count-dataset-tokens` repeat 3 passed without compression and failed with
compression. Two read-only `curl GET README | sed` results were compressed from
about 2,150 to 753 tokens each. The Agent later performed narrower reads but
wrote `63841` instead of `79586`. Compression cannot be proven causal, but the
commands should have been protected by the stated “inspection does not
compress” boundary.

## Fixed-input replay and post-experiment fixes

The unbiased fixed corpus consists of 523 Tool Results captured from the
no-compression arm. Replaying the rc.1 policy reduced all outputs by 14.66% from
raw and general commands by 33.47%, but exposed one compound inspection command
that lost critical source lines. Encoded/protected block retention remained
100%.

The experiment produced two production fixes for `0.2.0-rc.2`:

1. protect compound `node --check + git status + source read` inspections;
2. protect safe stdout-only HTTP GETs while leaving curl output files, uploads,
   request bodies, and other mutating forms processable.

After these fixes, the same fixed corpus reports:

| Static replay measure | 0.2.0-rc.2 candidate |
| --- | ---: |
| Critical fact retention | 100% |
| Encoded/protected block retention | 100% |
| All-output reduction from raw | 13.78% |
| All-output reduction relative to 0.1.4 | 7.95% |
| General-command reduction from raw | 33.33% |
| General-command reduction relative to 0.1.4 | 28.37% |

The static release gate passes. The full dynamic experiment remains an rc.1
result; rc.2 has regression, package-boundary, and static replay coverage but
has not been rerun for another 80 dynamic trials.

## Decision

`0.2.0-rc.2` is suitable as a local prerelease for further testing, not as the
stable `0.2.0` release. The end-to-end pass-rate guard passed, but the planned
10% model-input reduction did not. The next optimization should target the
large share of outputs that are correctly protected, and should not weaken
read, encoded, visual, or critical-error preservation merely to cross the
headline token target.
