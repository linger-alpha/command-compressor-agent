# CCA offline research

This directory is open-source research tooling. It is deliberately excluded from the npm package and is never imported by `bin/`, `src/`, or `rules/`.

The workflow is:

1. Stream Codex rollouts and public TerminalTraj observations into a locally redacted, bounded corpus.
2. Split by source and session into deterministic 70/15/15 train, validation, and test groups.
3. Select bounded blocks only. Complete trajectories are never sent to a remote model.
4. Ask `gpt-5.6-luna` with `max` reasoning for strict-JSON candidate rules.
5. Replay candidates locally against Git baseline `7830b17`.
6. Ask the independent `gpt-5.6-sol` judge with `high` reasoning to inspect bounded original/compressed pairs.
7. Freeze rejected candidates and feed complaints into at most three rounds. Promotion is a separate explicit command.

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

## Plan or run evolution

```sh
node research/cli.js evolve \
  --corpus research/artifacts/corpus.jsonl \
  --generator-model gpt-5.6-luna \
  --generator-effort max \
  --judge-model gpt-5.6-sol \
  --judge-effort high \
  --dry-run
```

Remove `--dry-run` to make the bounded model calls. `--judge-effort medium` is available for manual diagnostics; fixed experiments use `high`.

Replay scans the complete selected split for matching records instead of assuming
that a candidate applies to its first records. A research-only smoke candidate is
included to exercise the same deterministic gate and independent Sol judge:

```sh
node research/cli.js replay \
  --corpus research/artifacts/corpus.jsonl \
  --candidate research/fixtures/judge-smoke-candidate.json

node research/cli.js judge \
  --corpus research/artifacts/corpus.jsonl \
  --candidate research/fixtures/judge-smoke-candidate.json \
  --judge-model gpt-5.6-sol \
  --judge-effort high
```

`judge` exits before any model call unless the local replay has matched held-out
records, retained every critical fact, and improved estimated tokens over the
0.1.4 baseline by at least 5%.

Promotion refuses any rule that did not pass regex safety, 100% critical-fact retention, at least 99% held-out judge approval, and at least 5% estimated token reduction over the 0.1.4 baseline:

```sh
node research/cli.js promote \
  --state research/artifacts/evolution.json \
  --rules rules/default-rules.json
```
