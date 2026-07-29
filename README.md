# Command Compressor for Agent

Command Compressor for Agent (`cca`) is an experimental command-output
compression layer for coding agents. The project is inspired by RTK and
[TACO](https://arxiv.org/abs/2604.19572): it treats command-output compression
as an agent-context optimization problem, then implements a conservative
offline-rule runtime for stability. The current version supports Claude Code,
Codex CLI, stable OpenCode, and Pi.

Note: this project is compatible with RTK. RTK focuses on optimizing frequent
commands; CCA focuses on compressing commands with long outputs.

中文说明见 [docs/README.zh-CN.md](docs/README.zh-CN.md).

## Current Status

This project is experimental. The current evidence is encouraging but not final:
we have seen real command-observation token savings and preserved mean score in
a small TerminalBench 2/TACO-style sample, but we have also seen risk cases where
compression changed the agent trajectory or exposed unsafe output classes.
TACO is the main reference idea for this project and also motivates the
TerminalBench-style paired A/B evaluation used here. CCA does not reuse TACO's
full evolutionary runtime; it distills the idea into editable local rules and a
Claude Code hook that favors stability.

The default release therefore prioritizes safety over maximum compression:

- use `PostToolUse` instead of command rewriting,
- compress only when the result is shorter,
- keep a `raw_ref` fallback,
- avoid compressing visual, pixel, board, OCR, contour, and silhouette
  diagnostics,
- exempt small outputs by default,
- expose local savings through `cca gain`.

We welcome issue reports, benchmark reproductions, and rule-design discussion,
especially for cases where compression changes task success or causes extra raw
fallback reads.

## Install

Install from npm:

```bash
npm install -g @linger-alpha/cca
```

Auto-detect all installed supported agents and install their integrations
globally:

```bash
cca init --global
```

Or install one integration explicitly:

```bash
cca install --claude-code --global
cca install --codex --global
cca install --opencode --global
cca install --pi --global
```

Use `--project` instead of `--global` for a repository-local installation.
Codex hooks require an explicit review in `/hooks`; CCA never bypasses that
trust step during a normal install. OpenCode v2 beta is not supported by this
release.

Check the current configuration:

```bash
cca status --json
```

Show estimated token savings:

```bash
cca gain
```

Change compression strength:

```bash
cca strength default
cca strength high
cca strength xhigh
cca strength low
```

Uninstall selected integrations, or omit the agent flags to remove every
CCA-managed integration in that scope:

```bash
cca uninstall --codex --global
cca uninstall --global
```

## How It Works

`cca` has three release-runtime layers and performs no network or model calls.

The takeover layer integrates with each agent's post-tool lifecycle. Claude
Code receives `updatedToolOutput`; Codex receives `continue: false` with
compressed `stopReason` feedback; stable OpenCode mutates the
`tool.execute.after` output; and Pi replaces `tool_result.content` while
preserving `details` and `isError`. Every adapter normalizes to the same
`{command, stdout, stderr, exitCode, agent, toolName}` shape and fails open on
an exception.

The compression layer stores the raw output, applies the Critical Gate, splits
continuous text into rule-based blocks, scores block importance, plans the
available token budget, and then applies static compression rules. High
importance blocks are retained losslessly; medium and low blocks receive
progressively stronger duplicate, progress, and head/tail treatment. The
output header contains a `raw_ref` path, so the agent can recover the original
output when a required fact is missing. Commands that read the configured
raw-output directory are passed through and are not compressed again.

The evaluation layer appends local JSONL events and powers `cca gain`, which reports estimated raw tokens, effective tokens, compressed observations, and estimated saved tokens.

## Compression Strength

| Strength | Behavior | Approx. Bash observation token reduction |
| --- | --- | ---: |
| `default` | Default. Exempt outputs below 2k estimated tokens. Use strong and weak rules above the threshold. | 8.3% |
| `high` | Exempt outputs below 1k estimated tokens. More aggressive than default. | 10.1% |
| `xhigh` | No length exemption. Experimental; useful for benchmarks, risky for score-sensitive work. | 15.5% |
| `low` | Only compress outputs above 2k estimated tokens and only with strong rules. | 5.5% |

The reduction estimates above are observation-level replay estimates from 20 randomly sampled TerminalBench 2.0 tasks. Actual compression rate depends on the task. For example, deep-learning runs and other workloads with long noisy output
can see much higher compression.

Compression is intentionally conservative. In our experiments, low-token outputs often saved little and sometimes encouraged extra reading or trajectory divergence. The 2k exemption is a simple guardrail.

## Rules

Rules are stored in a user-editable JSON file copied during `cca init`.

```bash
cca rules
```

The v2 default rule file contains:

- `whitelist`: commands that should not be compressed. This includes RTK, `cat`,
  `ls`, `rg`, `grep`, `find`, `head`, `tail`, and similar inspection commands.
- `visual_diagnostic_passthrough`: image, chess-board, pixel, OCR, contour,
  silhouette, and visual-classification diagnostics. These are passed through
  because their layout and repetition often carry the important evidence. This
  passthrough applies even when the command failed, because failed visual
  diagnostics can contain the evidence needed to recover.
- `strong_rules`: progress bars, ANSI/status noise, package install chatter,
  Docker layer progress, and high-repetition logs. These rules avoid semantic
  head/tail cutting.
- `weak_rules`: longer TACO-inspired learned rules distilled from offline traces.
  They keep head/tail plus important lines and are disabled by `low` strength.
  The release runtime does not do online learning by default.
- `splitter`, `importance`, and `planner`: auditable block boundaries, bounded
  `[-100, 100]` importance weights, and soft budget settings. Existing v1 user
  rule files inherit these built-in defaults and are not overwritten.

Raw fallback reads are also whitelisted. Commands that read the configured raw
directory, normally `.command-compressor-agent/raw`, are not compressed again.

## Evidence, Risks, And Mitigations

TerminalBench/TACO-style A/B tests showed positive signs: the first comparable
20-task sample preserved mean score after excluding one infrastructure failure,
and many command observations shrank substantially. They also exposed risks. In
particular, `chess-best-move` succeeded in baseline but failed in compressed
mode after visual diagnostic output had been compressed too aggressively.

`chess-best-move` is image-derived symbolic reasoning, not proof that the model
had native vision. The agent can inspect `chess_board.png` with Python, PIL, or
OpenCV, emit textual diagnostics such as occupied squares, pixel grids,
silhouettes, contours, and candidate FEN strings, and then reason over that text.
That makes the textual diagnostic output safety-critical: repeated dots, blocks,
and matrix-like rows can be evidence rather than noise.

The current release responds with concrete mitigations:

- visual, board, pixel, contour, OCR, and silhouette diagnostics now pass
  through, including failed diagnostics,
- dense matrix-like outputs pass through,
- raw fallback reads pass through and are not compressed again,
- `default` exempts outputs below 2k estimated tokens,
- `low` disables weak head/tail rules,
- package smoke tests verify progress compression, visual passthrough, and
  raw fallback passthrough.

See [docs/technical-report.md](docs/technical-report.md) for the experiment
summary and case analysis. A Chinese counterpart is available at
[docs/technical-report.zh-CN.md](docs/technical-report.zh-CN.md).

## Current Conclusion

`cca` is a promising but still experimental compression layer. The safest
current use is conservative command-observation compression for noisy outputs,
with local rules kept visible and editable. We do not recommend using `xhigh`
as the default for score-sensitive work.

The project needs more repeated end-to-end A/B tests across TerminalBench,
DeepSWE-style tasks, and other coding agents. If you find a task where
compression improves, hurts, or changes the agent trajectory, please share the
trace and rule context so the community can improve the safety boundary.

## Research and npm package boundary

The open-source repository contains the offline TACO-style importer, local
redaction and auditing, Luna candidate generation, Sol independent judging,
rule replay, and Harbor/Terminal-Bench tooling under `research/`. None of that
is published to npm or imported by production code. The npm tarball contains
only `bin/`, `src/`, `rules/`, and npm's automatic package metadata, README,
and license. `npm run check:package` enforces this boundary.

## Community

Thanks to the [LINUX DO](https://linux.do/) community for providing a platform
for communication and sharing.

## License

MIT
