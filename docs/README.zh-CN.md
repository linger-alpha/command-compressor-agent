# Command Compressor for Agent 中文说明

Command Compressor for Agent（`CCA`）是一个面向 coding agent 的实验性命令输出压缩层，本项目受到 RTK 以及 [TACO](https://arxiv.org/abs/2604.19572) 启发：它将命令输出压缩视为 agent context optimization 问题，并采用保守的离线规则 runtime 来提高稳定性。当前版本只做了 claude code 适配。

注：本项目与 RTK 兼容，RTK 在于优化高频命令，CCA 是压缩长输出命令。

## 当前状态

本项目仍处于实验阶段。当前证据是积极但不充分的：我们已经观察到真实的 command-observation token 节省，并且在一个较小的 TerminalBench 2/TACO-style 样本中保持了平均分；但也观察到风险案例，即压缩可能改变 agent 轨迹，或暴露某些不适合压缩的输出类型。

TACO 是本项目的主要参考思想，也启发了这里使用的 TerminalBench-style paired A/B 评测方式。CCA 没有复用 TACO 的完整自动进化 runtime，而是将其思想收敛为可编辑的本地规则和 Claude Code hook，优先保证稳定性。

因此当前默认发布策略优先保守和稳定，而不是追求最大压缩率：

- 使用 `PostToolUse`，不重写命令；
- 只在压缩结果更短时替换输出；
- 保留 `raw_ref` 作为原始输出 fallback；
- 不压缩视觉、像素、棋盘、OCR、轮廓、silhouette 等诊断输出；
- 默认豁免较短输出；
- 通过 `cca gain` 暴露本地节省统计。

欢迎大家提交 issue、复现实验、讨论规则设计，尤其是那些压缩改变任务成功率或导致额外 raw fallback read 的案例。

## 安装

从 npm 安装：

```bash
npm install -g @linger-alpha/cca
```

全局安装 Claude Code hook：

```bash
cca init --global
```

查看当前配置：

```bash
cca status
```

查看估算 token 节省：

```bash
cca gain
```

调节压缩强度：

```bash
cca strength default
cca strength high
cca strength xhigh
cca strength low
```

卸载 hook：

```bash
cca uninstall --global
```

## 工作原理

`cca` 的发布 runtime 分为三层。

takeover layer 注册 Claude Code `PostToolUse:Bash` hook。Claude Code 先执行原始 Bash 命令；hook 在命令完成后收到工具返回值，并且可以用压缩后的观察值返回 `updatedToolOutput`。如果 hook 崩溃，或无法产生更短且安全的结果，它会 fail open。安装后的 hook 命令会使用 `cca init` 进程里的绝对 Node 路径，因此不依赖 Claude Code hook shell 里是否能通过 `PATH` 找到 npm 的 `node`。

compression layer 保存原始输出，应用本地静态规则，并且只在 net-positive 时返回压缩观察值。输出 header 中包含 `raw_ref` 路径，agent 在必要事实缺失时可以回读原始输出。读取已配置 raw-output 目录的命令会直接透传，不会被二次压缩。

evaluation layer 追加本地 JSONL 事件，并驱动 `cca gain`。它会报告估算 raw tokens、effective tokens、压缩观察次数和估算节省 tokens。

## 压缩强度

| 强度 | 行为 | Bash observation token 约略压缩率 |
| --- | --- | ---: |
| `default` | 默认档。豁免 2k estimated tokens 以下输出；超过阈值后使用强规则和弱规则。 | 8.3% |
| `high` | 豁免 1k estimated tokens 以下输出；比 default 更激进。 | 10.1% |
| `xhigh` | 无长度豁免。适合实验和 benchmark，但不建议用于分数敏感任务的默认设置。 | 15.5% |
| `low` | 只压缩 2k estimated tokens 以上输出，并且只使用 strong rules。 | 5.5% |

上表中的压缩率是 observation-level replay 估计，来自 TerminalBench 2.0 中随机抽取的 20 个任务，实际压缩率受任务本身影响，例如在深度学习或带有其他长输出的场景下会有更高的压缩率。

压缩刻意保守，我们的实验显示，低 token 输出通常节省不多，有时还会诱发额外读取或轨迹分叉，2k 豁免是一个简单的安全护栏。

## 规则

规则存储在用户可编辑的 JSON 文件中，`cca init` 时会复制一份默认规则。

```bash
cca rules
```

默认规则文件有四个部分：

- `whitelist`：不应压缩的命令，包括 RTK、`cat`、`ls`、`rg`、`grep`、`find`、`head`、`tail` 等 inspection 命令。
- `visual_diagnostic_passthrough`：image、chess-board、pixel、OCR、contour、silhouette 和 visual-classification 诊断输出。它们会直接透传，因为布局和重复本身常常承载关键信息。即使命令失败，这类输出也会透传，因为失败态视觉诊断可能正是恢复判断所需证据。
- `strong_rules`：进度条、ANSI/status 噪声、包安装 chatter、Docker layer progress 和高重复日志。这些规则避免语义性的 head/tail 裁剪。
- `weak_rules`：来自离线轨迹的 TACO-inspired 学习规则，会保留 head/tail
  和重要行。`low` 强度会禁用这些规则。发布 runtime 默认不做在线学习。

raw fallback read 也会被白名单保护。读取已配置 raw 目录的命令，通常是 `.command-compressor-agent/raw`，不会被再次压缩。

## 证据、风险与应对

TerminalBench/TACO-style A/B 测试给出了积极信号：在排除一个 infrastructure failure 后，首个 comparable 20-task 样本保持了平均分，并且许多命令观察值显著变短。同时它也暴露了风险。尤其是 `chess-best-move`，baseline 成功而 compressed 失败，原因与视觉诊断输出被过度压缩有关。

`chess-best-move` 更准确地说是 image-derived symbolic reasoning，而不是证明模型具有原生视觉能力。agent 可以用 Python、PIL 或 OpenCV 读取 `chess_board.png`，输出 occupied squares、pixel grids、silhouettes、contours、candidate FEN 等文本诊断，再基于这些文本做棋理推断。因此这类文本诊断是安全关键输出：重复的点阵、方块和矩阵行可能正是证据，而不是噪声。

当前发布版针对这些风险做了具体修复：

- 视觉、棋盘、像素、轮廓、OCR、silhouette 诊断输出全部透传，包括失败态诊断；
- dense matrix-like 输出透传；
- raw fallback read 透传，不二次压缩；
- `default` 豁免 2k estimated tokens 以下输出；
- `low` 禁用 weak head/tail 规则；
- package smoke tests 覆盖进度条压缩、视觉透传和 raw fallback 透传。

详细实验分析见 [technical-report.zh-CN.md](technical-report.zh-CN.md)。英文版本见 [technical-report.md](technical-report.md)。

## 当前结论

`cca` 是一个有潜力但仍处于实验阶段的压缩层。当前最安全的用法是：对 noisy outputs 做保守的 command-observation 压缩，同时保持本地规则可见、可编辑。我们不建议把 `xhigh` 作为分数敏感任务的默认设置。

项目还需要在 TerminalBench、DeepSWE-style tasks 和其他 coding agents 上做更多重复端到端 A/B 测试。如果你发现某个任务中压缩带来了提升、损害或明显改变 agent 轨迹，欢迎分享 trace 和规则上下文，一起把安全边界做得更清楚。

## License

MIT
