# Command Compressor for Agent 中文说明

Command Compressor for Agent（`CCA`）是一个面向 coding agent 的实验性命令输出压缩层，本项目受到 RTK 以及 [TACO](https://arxiv.org/abs/2604.19572) 启发：它将命令输出压缩视为 agent context optimization 问题，并采用离线生成、运行时静态执行的规则。当前版本完整支持 Claude Code、OpenCode 稳定版和 Pi；Codex CLI adapter 可显式安装，但当前 Codex code mode 会忽略 `PostToolUse` 的模型可见替换，因此不会被 `cca init` 自动安装。

注：本项目与 RTK 兼容，RTK 在于优化高频命令，CCA 是压缩长输出命令。

## 当前状态

本项目仍处于实验阶段。当前证据是积极但不充分的：我们已经观察到真实的 command-observation token 节省，并且在一个较小的 TerminalBench 2/TACO-style 样本中保持了平均分；但也观察到风险案例，即压缩可能改变 agent 轨迹，或暴露某些不适合压缩的输出类型。

TACO 是本项目的主要参考思想，也启发了这里使用的 TerminalBench-style paired A/B 评测方式。CCA 没有复用 TACO 的完整自动进化 runtime，而是将其思想收敛为可编辑的本地规则和 Claude Code hook，优先保证稳定性。

当前 runtime 优先保证可恢复性和块级安全：

- 使用各 Agent 的工具调用后置替换接口，不重写命令；
- 只在压缩结果更短时替换输出；
- 保留 `raw_ref` 作为原始输出 fallback；
- 保留编码数据、视觉结构、密集语义、traceback 和真实失败块；
- 豁免 RTK、查阅命令和 raw fallback read；
- 通过 `cca gain` 暴露本地节省统计。

欢迎大家提交 issue、复现实验、讨论规则设计，尤其是那些压缩改变任务成功率或导致额外 raw fallback read 的案例。

## 安装

从 npm 安装：

```bash
npm install -g @linger-alpha/cca
```

自动检测并全局安装所有已存在且已验证完整可用的 Agent。Codex 当前会因
code-mode 替换限制而跳过：

```bash
cca init --global
```

也可以单独安装：

```bash
cca install --claude-code --global
cca install --codex --global
cca install --opencode --global
cca install --pi --global
```

将 `--global` 改为 `--project` 可进行项目级安装。Codex 只能显式安装，并且
目前仅在普通 function-tool result 路径下可替换输出；code mode 虽然会执行
hook，却仍把原始结果交给模型。安装器会明确给出这一限制。Codex 安装后仍需
在 `/hooks` 中人工审核信任；CCA 不会绕过这一环节。OpenCode v2 beta 暂不支持。

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

`cca` 的发布 runtime 分为三层，并且没有网络或模型调用。

takeover layer 统一将四种 Agent 的工具结果归一化。Claude Code 使用
`updatedToolOutput`；条件性 Codex adapter 使用
`continue:false + stopReason`；OpenCode
稳定版修改 `tool.execute.after` 的输出；Pi 替换 `tool_result.content`，
同时保留 `details/isError`。所有 adapter 异常时都会 fail open。真实的
Codex 0.146.0 + Luna 探针已经确认 code mode 会忽略返回的 `stopReason`，
所以目前不能把 Codex 算作完整支持。

compression layer 先豁免 RTK、查阅命令和 raw fallback read，再清除 ANSI，
用线性规则把输出分成较粗的块，将每块归为 `preserve`、`light` 或
`aggressive`，最后应用现有静态规则。编码/二进制样式、密集语义、视觉结构、
traceback 和真实失败块无损保留；进度和重复块可以高强度压缩。这里没有整段
token 门槛和全局 token budget。Agent 只会看到压缩文本和 `raw_ref`，不会看到
内部得分、档位或规则诊断。

evaluation layer 追加本地 JSONL 事件，并驱动 `cca gain`。它会报告估算 raw tokens、effective tokens、压缩观察次数和估算节省 tokens。

## 旧 strength 设置

`low`、`default`、`high` 和 `xhigh` 仍可读写，以免破坏旧配置和脚本。
在新管线中它们只是兼容标签，不再选择 token 门槛、budget 或不同规则集；
实际压缩强度由每个块的静态策略独立决定。

## 规则

规则存储在用户可编辑的 JSON 文件中，`cca init` 时会复制一份默认规则。

```bash
cca rules
```

v3 默认规则文件包括：

- `command_policy`：RTK 兼容，以及 `cat`、`ls`、`rg`、`grep`、`find`、
  `head`、`tail` 等查阅命令；
- `splitter` 和 `block_policy`：线性粗分块，以及可审计的
  `preserve`/`light`/`aggressive` 信号。视觉和编码数据在块级保护，不再令
  整段输出直接透传；
- `strong_rules`：进度条、ANSI/status 噪声、包安装 chatter、Docker layer
  progress 和高重复日志；
- `weak_rules`：来自离线轨迹的 TACO-inspired 静态规则，保留 head/tail 和
  重要行；发布 runtime 不做在线学习；
- `planner`：分别定义轻压缩和高压缩的静态保留策略。

raw fallback read 也会被白名单保护。读取已配置 raw 目录的命令，通常是 `.command-compressor-agent/raw`，不会被再次压缩。

## 证据、风险与应对

TerminalBench/TACO-style A/B 测试给出了积极信号：在排除一个 infrastructure failure 后，首个 comparable 20-task 样本保持了平均分，并且许多命令观察值显著变短。同时它也暴露了风险。尤其是 `chess-best-move`，baseline 成功而 compressed 失败，原因与视觉诊断输出被过度压缩有关。

`chess-best-move` 更准确地说是 image-derived symbolic reasoning，而不是证明模型具有原生视觉能力。agent 可以用 Python、PIL 或 OpenCV 读取 `chess_board.png`，输出 occupied squares、pixel grids、silhouettes、contours、candidate FEN 等文本诊断，再基于这些文本做棋理推断。因此这类文本诊断是安全关键输出：重复的点阵、方块和矩阵行可能正是证据，而不是噪声。

当前管线针对这些风险做了具体修复：

- 视觉、棋盘、像素、轮廓、OCR、silhouette、编码数据和 dense matrix-like
  块无损保留；
- raw fallback read 透传，不二次压缩；
- 真实失败和 traceback 块无损保留；
- package smoke tests 覆盖进度条压缩、受保护块和 raw fallback 透传。

详细实验分析见 [technical-report.zh-CN.md](technical-report.zh-CN.md)。英文版本见 [technical-report.md](technical-report.md)。

## 当前结论

`cca` 是一个有潜力但仍处于实验阶段的压缩层。当前最安全的用法是：
对 noisy outputs 做 command-observation 压缩，同时保持本地规则可见、可编辑。
旧 strength 标签已不再改变运行行为。

项目还需要在 TerminalBench、DeepSWE-style tasks 和其他 coding agents 上做更多重复端到端 A/B 测试，并等待或实现 Codex code mode 的可靠模型可见输出替换接口。如果你发现某个任务中压缩带来了提升、损害或明显改变 agent 轨迹，欢迎分享 trace 和规则上下文，一起把安全边界做得更清楚。

## Community

Thanks to the [LINUX DO](https://linux.do/) community for providing a platform
for communication and sharing.

## License

MIT
