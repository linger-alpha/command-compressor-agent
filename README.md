# Command Compressor for Agent

Command Compressor for Agent (`cca`) is an experimental command-output
compression layer for coding agents. The project is inspired by RTK and
[TACO](https://arxiv.org/abs/2604.19572): it treats command-output compression
as an agent-context optimization problem, then implements a conservative
offline-rule runtime for stability. The current version supports Claude Code,
stable OpenCode, and Pi. A conditional Codex CLI adapter is available for
explicit installation, but it is not auto-installed because current Codex
code mode ignores model-visible `PostToolUse` replacements.

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

The current runtime therefore prioritizes recoverability and block-level safety:

- use post-tool replacement instead of command rewriting,
- compress only when the result is shorter,
- keep a `raw_ref` fallback,
- preserve encoded, visual, dense-semantic, traceback, and failure blocks,
- exempt RTK and inspection/read commands,
- expose local savings through `cca gain`.

We welcome issue reports, benchmark reproductions, and rule-design discussion,
especially for cases where compression changes task success or causes extra raw
fallback reads.

## Install

Install from npm:

```bash
npm install -g @linger-alpha/cca
```

Auto-detect all installed fully supported agents and install their integrations
globally. Codex is currently skipped because its mainstream code-mode path
does not expose a reliable replacement surface:

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
Explicit Codex installation is conditional: the hook works only when Codex
uses its ordinary function-tool result path. Codex code mode executes the hook
but returns the original result to the model. The installer reports this
limitation, and hooks still require an explicit review in `/hooks`; CCA never
bypasses that trust step during a normal install. OpenCode v2 beta is not
supported by this release.

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
Code receives `updatedToolOutput`; the conditional Codex adapter returns
`continue: false` with compressed `stopReason` feedback; stable OpenCode mutates the
`tool.execute.after` output; and Pi replaces `tool_result.content` while
preserving `details` and `isError`. Every adapter normalizes to the same
`{command, stdout, stderr, exitCode, agent, toolName}` shape and fails open on
an exception. A real Codex 0.146.0 + Luna probe confirmed that code mode ignores
the returned `stopReason`, so Codex is not counted as fully supported.

The compression layer first exempts RTK, inspection/read commands, and raw
fallback reads. It removes ANSI control sequences, splits the remaining output
into coarse rule-based blocks, classifies each block as `preserve`, `light`, or
`aggressive`, and then applies the existing static rules at that tier. Encoded,
binary-looking, dense-semantic, visual, traceback, and real failure blocks are
retained losslessly. Progress and duplicate blocks can be compressed strongly.
There is no whole-output token threshold or global token budget. The output
header only says that compression occurred and gives a `raw_ref` path; scores,
tiers, and rule diagnostics are not shown to the coding agent.

The evaluation layer appends local JSONL events and powers `cca gain`, which reports estimated raw tokens, effective tokens, compressed observations, and estimated saved tokens.

## Legacy Strength Setting

`low`, `default`, `high`, and `xhigh` remain accepted so existing configuration
files and scripts do not break. They are compatibility labels in the new
pipeline and no longer select token thresholds, budgets, or different rule
sets. Compression strength is chosen independently for each block by the static
block policy.

## Rules

Rules are stored in a user-editable JSON file copied during `cca init`.

```bash
cca rules
```

The v3 default rule file contains:

- `command_policy`: RTK compatibility plus inspection/read commands such as
  `cat`, `ls`, `rg`, `grep`, `find`, `head`, and `tail`.
- `splitter` and `block_policy`: coarse linear-time boundaries and auditable
  `preserve`/`light`/`aggressive` signals. Visual and encoded data are protected
  at block level rather than bypassing the entire observation.
- `strong_rules`: progress bars, ANSI/status noise, package install chatter,
  Docker layer progress, and high-repetition logs.
- `weak_rules`: longer TACO-inspired learned rules distilled from offline traces.
  They keep head/tail plus important lines. The release runtime does not do
  online learning.
- `planner`: separate light and aggressive static retention strategies. Existing
  v1/v2 user rule files inherit built-in block defaults and are not overwritten.

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

The current pipeline responds with concrete mitigations:

- visual, board, pixel, contour, OCR, silhouette, encoded, and dense matrix-like
  blocks are retained losslessly,
- raw fallback reads pass through and are not compressed again,
- real failure and traceback blocks are retained losslessly,
- package smoke tests verify progress compression, protected blocks, and
  raw fallback passthrough.

See [docs/technical-report.md](docs/technical-report.md) for the experiment
summary and case analysis. A Chinese counterpart is available at
[docs/technical-report.zh-CN.md](docs/technical-report.zh-CN.md).

## Current Conclusion

`cca` is a promising but still experimental compression layer. The safest
current use is command-observation compression for noisy outputs, with local
rules kept visible and editable. The old strength labels no longer change
runtime behavior.

The project needs more repeated end-to-end A/B tests across TerminalBench,
DeepSWE-style tasks, and other coding agents, plus a model-visible output
replacement surface for Codex code mode. If you find a task where
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
