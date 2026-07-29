# CCA offline research

This directory is open-source research tooling. It is deliberately excluded from the npm package and is never imported by `bin/`, `src/`, or `rules/`.

The workflow is:

1. Stream Codex rollouts and public TerminalTraj observations into a locally redacted, bounded corpus.
2. Split by source and session into deterministic 70/15/15 train, validation, and test groups.
3. Select bounded blocks only. Complete trajectories are never sent to a remote model.
4. Balance the remote sample across corpus sources and structural block classes.
5. Ask `gpt-5.6-luna` with `max` reasoning for strict-JSON candidate rules.
6. Replay candidates locally, three times, against Git baseline `7830b17`.
7. Ask the independent `gpt-5.6-sol` judge with `high` reasoning to inspect bounded original/compressed pairs.
8. Freeze rejected candidates and feed complaints into at most three rounds.
9. Run a separate, untouched test-split gate. Promotion is a separate explicit command.

The production package remains deterministic: accepted rules become static JSON only.

## Import

Paths containing spaces, including the historical `h800 ` directory whose name ends in a space, must be shell-quoted:

```sh
node research/cli.js import \
  --codex-source 'rtx=/path/to/codex 历史记录 rtx' \
  --codex-source 'h800=/path/to/codex 历史记录 h800 ' \
  --public-source terminaltraj=/path/to/terminaltraj_observations.jsonl \
  --out research/artifacts/corpus.jsonl
```

Only `exec_command`, `shell`, and `Bash` calls paired by `call_id` are imported. `write_stdin` is skipped unless a future importer can prove the originating process association.

Audit the bounded corpus before any model call:

```sh
node research/cli.js audit --corpus research/artifacts/corpus.jsonl
```

Evolution should not proceed unless this reports `"ok": true`.

## Plan or run block-policy evolution

```sh
node research/cli.js policy-evolve \
  --corpus research/artifacts/corpus.jsonl \
  --generator-model gpt-5.6-luna \
  --generator-effort max \
  --judge-model gpt-5.6-sol \
  --judge-effort high \
  --generator-samples 32 \
  --validation-samples 300 \
  --repetitions 3 \
  --dry-run
```

Remove `--dry-run` to make the bounded model calls. `--judge-effort medium` is available for manual diagnostics; fixed experiments use `high`.

If a model call or a one-round smoke stops before the three-round ceiling, resume
the exact experiment instead of starting over:

```sh
node research/cli.js policy-evolve \
  --corpus research/artifacts/corpus.jsonl \
  --resume research/artifacts/block-policy-evolution.json \
  --rounds 3 \
  --generator-samples 32 \
  --validation-samples 300 \
  --repetitions 3
```

Resume refuses changes to the generator, judge, baseline, or bounded block count.
`--rounds` is the total ceiling, not the number of additional rounds.

Replay and judge an individual candidate when diagnosing an experiment:

```sh
node research/cli.js policy-replay \
  --corpus research/artifacts/corpus.jsonl \
  --candidate research/artifacts/block-policy-evolution.json \
  --policy-id candidate_id \
  --repetitions 3

node research/cli.js policy-judge \
  --corpus research/artifacts/corpus.jsonl \
  --candidate research/artifacts/block-policy-evolution.json \
  --policy-id candidate_id \
  --judge-model gpt-5.6-sol \
  --judge-effort high
```

`policy-judge` exits before any model call unless the local replay has matched held-out
records, retained every critical fact, and improved estimated tokens over the
0.1.4 baseline by at least 5%.

Finalize on the untouched test split:

```sh
node research/cli.js policy-finalize \
  --corpus research/artifacts/corpus.jsonl \
  --state research/artifacts/block-policy-evolution.json \
  --policy-id candidate_id \
  --repetitions 3 \
  --out research/artifacts/block-policy-final.json
```

Promotion refuses any rule that did not pass regex safety, 100% critical-fact
and protected-block retention, at least 99% validation judge approval, and at
least 5% estimated token reduction over the 0.1.4 baseline in every validation
and test repetition:

```sh
node research/cli.js policy-promote \
  --state research/artifacts/block-policy-final.json \
  --rules rules/default-rules.json
```
