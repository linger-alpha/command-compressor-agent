# Agent hook container probes

This repository-only directory verifies CCA against real released Agent CLIs.
It is excluded from the npm package.

The image pins the versions used by the 0.2.0 feasibility run:

- Claude Code 2.1.212 (`stable` tag on 2026-07-29)
- Codex CLI 0.146.0
- OpenCode 1.18.9 (stable 1.x; v2 beta is intentionally excluded)
- Pi 0.82.1 (`@earendil-works/pi-coding-agent`)

Build the isolated toolchain:

```bash
docker build -t cca-agent-hook-smoke research/integration/agent-hooks
```

The default command prints all four installed versions. Run the complete
isolated smoke from the repository root:

```bash
docker run --rm \
  -v "$PWD:/workspace:ro" \
  cca-agent-hook-smoke \
  node research/integration/agent-hooks/smoke.mjs
```

The smoke uses an empty container home and checks:

- automatic detection and installation for all four supported CLIs;
- Codex installation with an explicit blocked-feedback warning;
- repeat-install idempotency;
- Claude Code settings validation through `claude doctor`;
- Codex's released hooks feature and generated command-hook response;
- a real OpenCode 1.x server bootstrap plus its stable
  `tool.execute.after` output shape;
- Pi's published extension loader and `ExtensionRunner.emitToolResult`;
- actual compression of a bounded repetitive output for every adapter;
- preservation of OpenCode metadata and Pi `details`/`isError`;
- uninstall behavior without deleting Claude/Codex settings files.

This smoke makes no model calls. Codex's full model → Bash → PostToolUse path
is exercised separately by the bounded Harbor probes described in
`research/benchmark/README.md`.
