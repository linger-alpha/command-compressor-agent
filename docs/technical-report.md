# Technical Report: Command Compressor for Agent

Chinese version: [technical-report.zh-CN.md](technical-report.zh-CN.md).

## Summary

Command Compressor for Agent is an experimental command-output compression
system for coding agents. It is inspired by RTK and based on
[JACO](https://arxiv.org/abs/2209.07775): by removing low-value information
from command output, such as progress bars, it saves token cost and helps the
model stay more focused. Unlike JACO, our learning process is offline, which
makes the system more stable while still keeping the useful effect.

The current version focuses on Claude Code and uses a `PostToolUse:Bash` hook:
it intercepts command output and compresses the output when CCA decides that
compression is both useful and relatively safe.

## Rule Sources

The rule generation process follows the idea of JACO: first collect raw
observations from coding-agent command-output trajectories, then identify
frequent low-value patterns offline, generate candidate rules, and finally
filter them into release rules through replay and end-to-end A/B results. The
rules in this round mainly come from two training/mining data sources:

- the external public command-trajectory dataset TerminalTraj;
- historical conversations with coding agents.

The rules are divided into three groups. The first group is whitelist and
passthrough rules, which protect inspection commands such as `cat`, `ls`, `rg`,
`grep`, `find`, `head`, and `tail`, as well as visual, board, pixel, OCR,
contour, silhouette, dense matrix, and raw fallback read outputs. These outputs
may be highly repetitive while still carrying valuable information. The second
group is strong rules, mainly targeting progress bars, ANSI/status noise,
package install chatter, Docker layer progress, and high-repetition logs. The
third group is weak rules, which come from JACO-style offline learning and
mainly preserve head/tail plus important lines for long training logs and
progress-heavy output from unknown scripts.

## Experiment

The experiment was fully based on rules learned through the JACO-style process
and did not separate strong and weak rules. The release rules include
improvements made for problems encountered during the experiment.

The main end-to-end experiment used TerminalBench 2.0 tasks in a TACO-style
paired A/B setup with Claude Code and `deepseek-v4-pro`. We tracked validation
score, estimated input tokens, cache-read input tokens, output tokens
(reasoning counted as output), custom cost with input=3, output=6,
cache-read=0.025, hook responses, actual `updatedToolOutput` events, raw
fallback reads, and tool-call differences.

The first comparable 20-task sample had one benchmark infrastructure failure
before the agent entered the task, leaving 19 valid paired runs. The 19 valid
pairs produced the following result:

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Mean validation score | 0.4737 | 0.4737 |
| Mean custom cost | 5.9809 | 6.6527 |
| Compression-hit pairs | - | 14 / 19 |
| Raw-fallback-read delta pairs | - | 3 |
| Mean Read tool-call delta | - | +2.32 |

The mean score was unchanged: one negative case was offset by one positive
case. This is not enough evidence to claim stable benchmark improvement, but it
does show that Claude Code observation takeover works, local observation
compression can produce meaningful savings, and score preservation must be
validated end to end rather than inferred from local token savings.

In the original compressed observations, the observed compression rate was
high. Across 159 unique Bash observations where the benchmark hook actually
returned `updatedToolOutput`, the raw observations contained 123,572 estimated
tokens. The compressed observations contained 41,161 estimated tokens, saving
82,411 tokens, or about **66.7%** at the Bash-observation level.

These are observation-level savings, not full billing savings. Full cost also
depends on the model trajectory: different commands, extra self-tests, cache
reads, reasoning tokens, and output tokens can dominate local savings.

## Cases

### chess-best-move

`chess-best-move` was the clearest negative signal in the first sample. The
task provides `chess_board.png` and asks the agent to write all best white moves
to `/app/move.txt`. The official verifier expects:

```text
g2g4
e2e4
```

Baseline succeeded. The compressed run failed after constructing a wrong FEN.
This does not mean the baseline model had native vision. In the successful
path, the agent can use Python, PIL, or OpenCV to inspect the image, cut the
board into squares, sample pixels, identify contours or silhouettes, emit
textual diagnostics, construct a candidate FEN, and then use chess logic or
`python-chess` to find the best moves.

Correct baseline FEN:

```text
r1bq1r2/1p3pp1/p1n1p3/3nPkbP/8/P1N5/1P2QPP1/R1B1K2R w - - 0 1
```

Compressed trajectory FEN:

```text
r1bk1r2/1p3pp1/p1n1p3/3nPqbP/8/P1N5/1P2QPP1/R1B1K2R w - - 0 1
```

The black king and queen were swapped. The compressor did not directly
fabricate this wrong FEN; the wrong FEN had already appeared in the agent's own
raw command output before later compression preserved it. The more plausible
risk was earlier visual diagnostic compression. Dense binary silhouettes and
piece-shape outputs can look repetitive, but in image-derived symbolic
reasoning the layout and repetition may be the evidence.

The current CCA runtime mitigates this by passing through visual, board, pixel,
contour, OCR, silhouette, and dense matrix-like diagnostic outputs. Replay on
the original failing chess diagnostics showed that the outputs previously
compressed by the old hook now hit `visual_diagnostic_passthrough` and pass
through. This means the compressor-layer risk has been mitigated.

### bn-fit-modify

`bn-fit-modify` asks the agent to recover a Bayesian Network DAG from
`/app/bn_sample_10k.csv`, fit the BN, perform an intervention `Y=0`, and write
`learned_dag.csv`, `intervened_dag.csv`, and `final_bn_sample.csv`.

In the main run, neither side passed validation:

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 0 | 0 |
| Custom cost | 1.299 | 5.370 |
| Tool calls | 19 | 51 |
| Bash calls | 13 | 32 |
| Read calls | 3 | 7 |
| Raw fallback reads | 0 | 0 |

Local command-output compression still saved observation tokens: 13,981 raw
observation tokens became 2,476 compressed tokens, saving 11,505 tokens. Full
cost rose because the compressed trajectory became much longer.

A targeted repeat did not reproduce the regression:

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 1 | 1 |
| Custom cost | 3.961 | 3.761 |
| Read calls | 4 | 1 |
| Raw fallback reads | 0 | 0 |

This case appears dominated by model trajectory variability and library/API
exploration rather than stable compression-induced information loss.

### custom-memory-heap-crash

`custom-memory-heap-crash` was important because the first run preserved score
but showed a large cost increase:

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 1 | 1 |
| Custom cost | 2.936 | 19.541 |
| Tool calls | 32 | 99 |
| Bash calls | 20 | 74 |
| Read calls | 6 | 17 |
| Raw fallback reads | 0 | 1 |
| Updated hook outputs | 0 | 3 |

The relevant ASan segmentation output was small: about 653 estimated raw tokens
and about 490 compressed tokens. Critical ASan facts were retained. This case
looked more like a long debugging trajectory than a large missing-information
case.

We retested this case end to end with the current Node/npm CCA runtime and the
current conservative default strength. Both sides passed:

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 1 | 1 |
| Custom cost | 2.404 | 4.703 |
| Tool calls | 29 | 43 |
| Bash calls | 19 | 31 |
| Read calls | 6 | 7 |
| Raw fallback reads | 0 | 0 |
| Hook responses | 0 | 30 |
| Updated hook outputs | 0 | 0 |

This retest confirms that the task can pass with the final hook runtime active.
It also confirms that the current default policy did not compress any Bash
observations in this run; the hook only performed takeover, stored raw files,
and passed observations through. The remaining cost increase is therefore more
consistent with trajectory variance and a different agent path.

### Positive Cases

The benchmark also included positive signals:

| Case | Signal |
| --- | --- |
| `crack-7z-hash` | Score improved from 0 to 1, and cost fell from 5.619 to 1.871. |
| `fix-ocaml-gc` | Score was preserved, and cost fell from about 13.05 to 5.02. |
| `kv-store-grpc` | Score was preserved, and cost fell from about 1.412 to 1.019. |

These cases show that compression can sometimes improve an agent path, likely
by reducing distracting output or shortening context. They are encouraging, but
they do not remove the need for conservative defaults.

## Mitigation

The current release policy is deliberately more conservative than the original
aggressive benchmark hook. The main safety changes are:

- visual, board, pixel, contour, OCR, silhouette, and image diagnostic outputs
  pass through;
- dense matrix-like outputs pass through;
- raw fallback reads pass through, so commands that inspect saved raw output are
  not compressed;
- small outputs pass through by default;
- `low` strength applies only strong rules, while `default`, `high`, and
  `xhigh` progressively increase compression;
- raw output references are retained so the model can recover more context when
  necessary.

Applying the current release policy to the same 159 stored Bash observations
from the original experiment gives the following estimated effective savings:

| Strength | Changed observations | Passthrough observations | Raw tokens | Effective tokens | Saved vs raw | Effective reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `default` | 2 | 157 | 123,572 | 113,349 | 10,223 | 8.3% |
| `high` | 5 | 154 | 123,572 | 111,073 | 12,499 | 10.1% |
| `xhigh` | 27 | 132 | 123,572 | 104,431 | 19,141 | 15.5% |
| `low` | 2 | 157 | 123,572 | 116,708 | 6,864 | 5.5% |

These numbers are not the compression rate actually observed in the original
experiment. They are estimates for the safer release policy after case
analysis. The observed aggressive compression was about 66.7%; the release
default estimate is about 8.3%. The drop is an intentional cost paid for a
safer boundary.

Negative-case replay supports this tradeoff:

| Case | Original compressed outputs | Current `default` replay | Interpretation |
| --- | ---: | --- | --- |
| `chess-best-move` | 18 | 18 passthrough, 0 compressed | Previously compressed chess diagnostics now hit `visual_diagnostic_passthrough`. |
| `custom-memory-heap-crash` | 3 | 3 passthrough, 0 compressed | Small ASan/segmentation outputs now pass through by default; the end-to-end retest passed with no updated tool outputs. |
| `bn-fit-modify` | 6 | 1 compressed, 5 passthrough | Earlier suspicious head/tail compression now passes through; targeted A/B did not reproduce the cost regression. |

The current default posture is therefore: preserve task performance first,
compress only when the output class appears low-risk, and keep raw fallback
available when the model needs more detail.

## Limitations

The data is still limited. The TerminalBench sample is small, and model
behavior is stochastic: a single task can change because the model chooses a
different debug path, runs stricter self-tests, or spends more reasoning
tokens. This randomness appeared often in testing and had a major impact on the
experimental results, which means the current small-sample test has limited
statistical significance.

The current result is best understood as an early but useful signal:

- takeover via Claude Code `PostToolUse:Bash` works;
- local command-observation compression can be large;
- conservative safety rules reduce obvious information-loss risks.

CCA should therefore be treated as experimental infrastructure. The default
configuration prioritizes safety over maximum compression, and the project
welcomes benchmark traces, case reports, and discussion about rule boundaries.
