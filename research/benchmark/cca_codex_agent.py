"""Harbor Codex agent with an isolated CCA benchmark arm.

This module is repository-only. It is never shipped in the npm package.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


ARMS = {"none", "legacy", "current"}
CONTAINER_ROOT = Path("/opt/command-compressor-agent")


class CcaCodex(Codex):
    """Codex with no compression, the 0.1.4 core, or the current core."""

    def __init__(
        self,
        *args,
        arm: str = "none",
        repo_root: str | None = None,
        baseline_commit: str = "7830b17",
        current_commit: str | None = None,
        **kwargs,
    ):
        if arm not in ARMS:
            raise ValueError(f"Unknown benchmark arm: {arm}")
        if not repo_root:
            raise ValueError("repo_root is required for the CCA benchmark agent")
        self._cca_arm = arm
        self._cca_repo_root = Path(repo_root).expanduser().resolve()
        self._cca_baseline_commit = baseline_commit
        self._cca_current_commit = current_commit
        super().__init__(*args, **kwargs)

    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {EnvironmentPaths.artifacts_dir} "
                f"{EnvironmentPaths.agent_dir}/cca"
            ),
        )
        await self._write_arm_metadata(environment)

        with tempfile.TemporaryDirectory(prefix=f"cca-harbor-{self._cca_arm}-") as root:
            bundle = Path(root) / "bundle"
            self._prepare_bundle(bundle)
            await environment.upload_dir(bundle, CONTAINER_ROOT.as_posix())

        hooks_target = EnvironmentPaths.agent_dir / "hooks.json"
        ownership = (
            f"chown -R {environment.default_user} "
            f"{EnvironmentPaths.agent_dir}/cca {hooks_target} && "
            if environment.default_user is not None
            else ""
        )
        await self.exec_as_root(
            environment,
            command=(
                f"cp {CONTAINER_ROOT}/runtime-hooks.json {hooks_target} && "
                f"{ownership}"
                f"chmod 0755 {CONTAINER_ROOT}/bin/cca-benchmark-hook.sh "
                f"{CONTAINER_ROOT}/bin/cca-benchmark-hook.js "
                f"{CONTAINER_ROOT}/codex-benchmark-wrapper.sh"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                'CODEX_BIN="$(command -v codex)"; '
                'test -n "$CODEX_BIN"; '
                'if [ ! -e "${CODEX_BIN}-cca-real" ]; then '
                'mv "$CODEX_BIN" "${CODEX_BIN}-cca-real"; '
                "fi; "
                f"cp {CONTAINER_ROOT}/codex-benchmark-wrapper.sh \"$CODEX_BIN\"; "
                'chmod 0755 "$CODEX_BIN"'
            ),
        )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        try:
            await super().run(instruction, environment, context)
        finally:
            await self.exec_as_agent(
                environment,
                command=(
                    f"if [ -f {EnvironmentPaths.agent_dir}/cca/gain.jsonl ]; then "
                    f"cp {EnvironmentPaths.agent_dir}/cca/gain.jsonl "
                    f"{EnvironmentPaths.artifacts_dir}/cca-gain.jsonl; "
                    "fi; "
                    f"if [ -f {EnvironmentPaths.agent_dir}/cca/observations.jsonl ]; then "
                    f"cp {EnvironmentPaths.agent_dir}/cca/observations.jsonl "
                    f"{EnvironmentPaths.artifacts_dir}/cca-observations.jsonl; "
                    "fi"
                ),
            )

    def _prepare_bundle(self, bundle: Path) -> None:
        if not (self._cca_repo_root / ".git").exists():
            raise ValueError(f"Not a Git repository: {self._cca_repo_root}")
        if self._cca_arm == "current":
            if not self._cca_current_commit:
                raise ValueError("current_commit is required for the current benchmark arm")
            runtime_diff = subprocess.run(
                [
                    "git",
                    "diff",
                    "--quiet",
                    self._cca_current_commit,
                    "--",
                    "bin",
                    "src",
                    "rules",
                    "package.json",
                ],
                cwd=self._cca_repo_root,
                check=False,
            )
            if runtime_diff.returncode not in (0, 1):
                raise ValueError("Could not compare the current benchmark runtime")
            if runtime_diff.returncode == 1:
                raise ValueError(
                    "Current benchmark runtime differs from pinned commit "
                    f"{self._cca_current_commit}"
                )
            runtime_changes = subprocess.run(
                [
                    "git",
                    "status",
                    "--porcelain",
                    "--untracked-files=all",
                    "--",
                    "bin",
                    "src",
                    "rules",
                    "package.json",
                ],
                cwd=self._cca_repo_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            if runtime_changes:
                raise ValueError(
                    "Current benchmark runtime has untracked or uncommitted changes:\n"
                    f"{runtime_changes}"
                )
            bundle.mkdir(parents=True)
            for name in ("bin", "src", "rules"):
                shutil.copytree(self._cca_repo_root / name, bundle / name)
            shutil.copy2(self._cca_repo_root / "package.json", bundle / "package.json")
        elif self._cca_arm == "legacy":
            self._extract_baseline(bundle)
            for relative in (
                Path("bin/cca-hook.js"),
                Path("src/takeover/common.js"),
                Path("src/takeover/codex.js"),
            ):
                target = bundle / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self._cca_repo_root / relative, target)
        else:
            (bundle / "bin").mkdir(parents=True)

        shutil.copy2(
            self._cca_repo_root / "research" / "benchmark" / "hook-runner.js",
            bundle / "bin" / "cca-benchmark-hook.js",
        )

        config = {
            "version": 1,
            "strength": "xhigh",
            "rulesPath": f"{CONTAINER_ROOT}/rules/default-rules.json",
            "rawDir": f"{EnvironmentPaths.agent_dir}/cca/raw",
            "metricsPath": f"{EnvironmentPaths.agent_dir}/cca/gain.jsonl",
        }
        hook_command = (
            f"{CONTAINER_ROOT}/bin/cca-benchmark-hook.sh"
        )
        hooks = {
            "description": f"CCA Terminal-Bench arm: {self._cca_arm}",
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "^Bash$",
                        "hooks": [
                            {
                                "type": "command",
                                "command": hook_command,
                                "timeout": 30,
                                "statusMessage": "Compressing command output",
                            }
                        ],
                    }
                ]
            },
        }
        (bundle / "runtime-config.json").write_text(
            json.dumps(config, indent=2) + "\n", encoding="utf-8"
        )
        (bundle / "runtime-hooks.json").write_text(
            json.dumps(hooks, indent=2) + "\n", encoding="utf-8"
        )
        hook_runner = bundle / "bin" / "cca-benchmark-hook.sh"
        hook_runner.write_text(
            "#!/bin/sh\n"
            'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi\n'
            f"export CCA_CONFIG_PATH='{CONTAINER_ROOT}/runtime-config.json'\n"
            f"export CCA_RUNTIME_ROOT='{CONTAINER_ROOT}'\n"
            f"export CCA_BENCHMARK_ARM='{self._cca_arm}'\n"
            f"export CCA_OBSERVATIONS_PATH='{EnvironmentPaths.agent_dir}/cca/observations.jsonl'\n"
            f"exec node '{CONTAINER_ROOT}/bin/cca-benchmark-hook.js'\n",
            encoding="utf-8",
        )
        hook_runner.chmod(0o755)
        codex_wrapper = bundle / "codex-benchmark-wrapper.sh"
        codex_wrapper.write_text(
            "#!/bin/bash\n"
            'wrapper_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n'
            'real_codex="$wrapper_dir/codex-cca-real"\n'
            'if [ "${1:-}" = "exec" ]; then\n'
            "  shift\n"
            "  args=()\n"
            '  while [ "$#" -gt 0 ]; do\n'
            '    if [ "$1" = "--enable" ]; then\n'
            '      case "${2:-}" in\n'
            "        unified_exec|code_mode|code_mode_only)\n"
            "          shift 2\n"
            "          continue\n"
            "          ;;\n"
            "      esac\n"
            "    fi\n"
            '    args+=("$1")\n'
            "    shift\n"
            "  done\n"
            '  exec "$real_codex" exec --dangerously-bypass-hook-trust '
            "--disable unified_exec --disable code_mode "
            '--disable code_mode_only "${args[@]}"\n'
            "fi\n"
            'exec "$real_codex" "$@"\n',
            encoding="utf-8",
        )
        codex_wrapper.chmod(0o755)

    def _extract_baseline(self, bundle: Path) -> None:
        bundle.mkdir(parents=True)
        archive = bundle.parent / "baseline.tar"
        subprocess.run(
            [
                "git",
                "archive",
                "--format=tar",
                "-o",
                str(archive),
                self._cca_baseline_commit,
            ],
            cwd=self._cca_repo_root,
            check=True,
            capture_output=True,
        )
        with tarfile.open(archive) as source:
            source.extractall(bundle, filter="data")

    async def _write_arm_metadata(self, environment: BaseEnvironment) -> None:
        metadata = json.dumps(
            {
                "arm": self._cca_arm,
                "baseline_commit": self._cca_baseline_commit
                if self._cca_arm == "legacy"
                else None,
                "current_commit": self._cca_current_commit
                if self._cca_arm == "current"
                else None,
                "strength": "xhigh" if self._cca_arm != "none" else None,
                "unified_exec": False,
                # This records the requested CLI override only. The rollout
                # audit separately verifies whether the model still used code
                # mode despite the override.
                "requested_code_mode": False,
            },
            sort_keys=True,
        )
        escaped = metadata.replace("'", "'\"'\"'")
        await self.exec_as_root(
            environment,
            command=(
                f"printf '%s\\n' '{escaped}' > "
                f"{EnvironmentPaths.artifacts_dir}/cca-arm.json"
            ),
        )
