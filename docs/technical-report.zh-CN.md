# 技术报告：Command Compressor for Agent

English version: [technical-report.md](technical-report.md).

## 概要

Command Compressor for Agent 是一个面向 coding agents 的实验性命令输出压缩系统，受 RTK 启发，基于[JACO](https://arxiv.org/abs/2209.07775)：通过删减命令输出中的无效信息（如进度条），节省 token 开销并让模型更“专注”，与 JACO 不同的是，我们的学习是离线的，这样更稳定也仍然有效。

当前版本聚焦 Claude Code，使用 `PostToolUse:Bash` hook：截流命令输出，当 CCA 判断压缩既有收益又相对安全时对输出进行压缩。

## 规则来源

规则生成流程参考 JACO 的思路：先从 coding-agent 命令输出轨迹中收集 raw observations，再离线识别高频低价值模式，生成 candidate rules，最后通过 replay 和端到端 A/B 结果筛选进入 release rules。本轮规则主要来自两类训练/挖掘数据：

- 外部公开命令轨迹数据集 TerminalTraj；
- 与 coding Agent 的历史对话。

规则被分为三类。第一类是白名单和透传规则，用来保护 `cat`、`ls`、`rg`、`grep`、`find`、`head`、`tail` 等查询命令，以及 visual、board、pixel、OCR、contour、silhouette、dense matrix 和 raw fallback read 这类高度重复但仍有价值的信息。第二类是强规则，主要面向进度条、ANSI/status 噪声、package install chatter、Docker layer progress 和高重复日志。第三类是弱规则，来自 JACO-style offline learning，主要对长训练日志和未知脚本中的进度型输出做 head/tail + important lines 保留。

## 实验

实验完全基于 JACO 训练得出，没有分强弱规则，release 的规则包含针对实验中遇到问题进行的改进。

主要端到端实验使用 TerminalBench 2.0 tasks，采用 TACO-style paired A/B 设置，agent 为 Claude Code，模型为 `deepseek-v4-pro`。指标包括 validation score、estimated input tokens、cache-read input tokens、output tokens（reasoning 计入 output）、custom cost（价格口径为 input=3、output=6、cache-read=0.025）、hook responses、实际 `updatedToolOutput` events、raw fallback reads 和 tool-call differences。

首个 comparable 20-task 样本中，有一个 benchmark infrastructure failure 发生在 agent 进入任务之前，因此剩余 19 个 valid paired runs。19 个 valid pairs 的结果如下：

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Mean validation score | 0.4737 | 0.4737 |
| Mean custom cost | 5.9809 | 6.6527 |
| Compression-hit pairs | - | 14 / 19 |
| Raw-fallback-read delta pairs | - | 3 |
| Mean Read tool-call delta | - | +2.32 |

平均分保持不变：一个负向案例被一个正向案例抵消。这不足以宣称 benchmark 稳定提升，但足以说明 Claude Code observation takeover 可以工作、本地 observation compression 可以产生显著节省，并且 score preservation 必须通过端到端实验验证，不能只从本地 token savings 推断。

在原始 compressed observations 中，实际观察到的压缩率较高。统计 benchmark hook 实际返回过 `updatedToolOutput` 的 159 条 unique Bash observations，原始 observations 共 123,572 estimated tokens；压缩后为 41,161 estimated tokens，节省 82,411 tokens，Bash-observation level 压缩率约 **66.7%**。

这些是 observation-level savings，不是完整账单 savings。完整 cost 还取决于模型轨迹：不同命令、额外自测、cache reads、reasoning tokens 和 output tokens 都可能盖过本地节省。

## 案例

### chess-best-move

`chess-best-move` 是首个样本中最明确的负向信号。任务提供 `chess_board.png`，要求 agent 把所有白方最佳走法写入 `/app/move.txt`。官方 verifier 期望：

```text
g2g4
e2e4
```

baseline 成功。compressed run 在构造错误 FEN 后失败。这不意味着 baseline 模型具备原生视觉能力。成功路径中，agent 可以使用 Python、PIL 或 OpenCV 检查图片，将棋盘切成格子，采样像素，识别 contours 或 silhouettes，输出文本诊断，构造 candidate FEN，然后用棋理或 `python-chess` 求最佳走法。

正确 baseline FEN：

```text
r1bq1r2/1p3pp1/p1n1p3/3nPkbP/8/P1N5/1P2QPP1/R1B1K2R w - - 0 1
```

compressed trajectory 中的错误 FEN：

```text
r1bk1r2/1p3pp1/p1n1p3/3nPqbP/8/P1N5/1P2QPP1/R1B1K2R w - - 0 1
```

错误是黑王和黑后被交换。compressor 并没有直接编造这个错误 FEN；错误 FEN 在后续压缩前已经出现在 agent 自己的 raw command output 中，压缩只是保留了这个错误事实。更可能的风险来自更早的视觉诊断压缩。dense binary silhouettes 和 piece-shape outputs 看起来可能重复，但在 image-derived symbolic reasoning 中，布局和重复本身可能就是证据。

当前 CCA runtime 通过透传 visual、board、pixel、contour、OCR、silhouette 和 dense matrix-like diagnostic outputs 来缓解这个问题。针对原始失败 chess diagnostics 的 replay 显示，旧 hook 曾经压缩的 outputs 现在都会命中 `visual_diagnostic_passthrough` 并透传。这说明 compressor-layer risk 已经缓解。

### bn-fit-modify

`bn-fit-modify` 要求 agent 从 `/app/bn_sample_10k.csv` 恢复 Bayesian Network DAG，拟合 BN，执行 `Y=0` intervention，并写出 `learned_dag.csv`、`intervened_dag.csv` 和 `final_bn_sample.csv`。

主跑中两边都没有通过验证：

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 0 | 0 |
| Custom cost | 1.299 | 5.370 |
| Tool calls | 19 | 51 |
| Bash calls | 13 | 32 |
| Read calls | 3 | 7 |
| Raw fallback reads | 0 | 0 |

本地 command-output compression 仍节省了 observation tokens：13,981 raw observation tokens 被压到 2,476 compressed tokens，节省 11,505 tokens。完整 cost 上升，是因为 compressed trajectory 明显更长。

一次 targeted repeat 没有复现这个回归：

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 1 | 1 |
| Custom cost | 3.961 | 3.761 |
| Read calls | 4 | 1 |
| Raw fallback reads | 0 | 0 |

这个案例更像是受模型轨迹随机性和 library/API exploration 主导，而不是稳定的 compression-induced information loss。

### custom-memory-heap-crash

`custom-memory-heap-crash` 很重要，因为首轮实验分数保持，但 cost 大幅上升：

| Metric | Baseline | Compressed |
| --- | ---: | ---: |
| Score | 1 | 1 |
| Custom cost | 2.936 | 19.541 |
| Tool calls | 32 | 99 |
| Bash calls | 20 | 74 |
| Read calls | 6 | 17 |
| Raw fallback reads | 0 | 1 |
| Updated hook outputs | 0 | 3 |

相关 ASan segmentation output 很小：raw 约 653 estimated tokens，compressed 约 490 tokens。关键 ASan facts 被保留。这个案例不像是大量信息缺失，更像是一次较长 debug trajectory。

我们使用当前 Node/npm CCA runtime 和当前保守 default strength 对这个案例做了端到端复测。两边都通过：

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

这次复测确认：final hook runtime 激活时，该任务仍可通过。同时，当前 default policy 在这次运行中**没有**压缩任何 Bash observations；hook 只完成 takeover、保存 raw files 并透传 observation。因此 cost 上升更符合轨迹随机性和不同 agent path 的开销。

### 正向案例

benchmark 中也出现了正向信号：

| Case | Signal |
| --- | --- |
| `crack-7z-hash` | Score 从 0 提升到 1，cost 从 5.619 降到 1.871。 |
| `fix-ocaml-gc` | Score 保持，cost 从约 13.05 降到 5.02。 |
| `kv-store-grpc` | Score 保持，cost 从约 1.412 降到 1.019。 |

这些案例说明 compression 有时可能改善 agent path，可能是因为减少了干扰性输出或缩短了上下文。它们是积极信号，但不能替代保守默认策略。

## 修复策略

当前 release policy 明显比原始 aggressive benchmark hook 更保守。主要安全策略包括：

- visual、board、pixel、contour、OCR、silhouette 和 image diagnostic outputs 透传；
- dense matrix-like outputs 透传；
- raw fallback reads 透传，因此读取已保存原始输出的命令不会被压缩；
- default 下小输出透传；
- `low` strength 只应用 strong rules，`default`、`high` 和 `xhigh` 逐步增强压缩；
- 保留 raw output references，使模型在必要时可以恢复更多上下文。

把当前 release policy 应用到原始实验中同一批 159 条 stored Bash observations 上，得到以下 estimated effective savings：

| Strength | Changed observations | Passthrough observations | Raw tokens | Effective tokens | Saved vs raw | Effective reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `default` | 2 | 157 | 123,572 | 113,349 | 10,223 | 8.3% |
| `high` | 5 | 154 | 123,572 | 111,073 | 12,499 | 10.1% |
| `xhigh` | 27 | 132 | 123,572 | 104,431 | 19,141 | 15.5% |
| `low` | 2 | 157 | 123,572 | 116,708 | 6,864 | 5.5% |

这些数字不是原始实验实际观察到的压缩率，而是案例分析后更安全 release policy 的估计。observed aggressive compression 约 66.7%，release default 估计约 8.3%；压缩率下降是为了安全边界主动付出的代价。

负向案例 replay 支持这个取舍：

| Case | Original compressed outputs | Current `default` replay | Interpretation |
| --- | ---: | --- | --- |
| `chess-best-move` | 18 | 18 passthrough, 0 compressed | 此前被压缩的 chess diagnostics 现在都会命中 `visual_diagnostic_passthrough`。 |
| `custom-memory-heap-crash` | 3 | 3 passthrough, 0 compressed | 小型 ASan/segmentation outputs 现在 default 透传；端到端复测通过，且没有 updated tool outputs。 |
| `bn-fit-modify` | 6 | 1 compressed, 5 passthrough | 此前可疑的 head/tail compression 现在透传；targeted A/B 没有复现 cost regression。 |

因此当前默认姿态是：优先保持任务表现；只在输出类型看起来低风险时压缩；当模型确实需要更多细节时，保留 raw fallback。

## 局限

数据仍然有限。TerminalBench 样本较小，模型行为具有随机性：单个任务的变化可能来自模型选择了不同 debug path、运行了更严格自测，或消耗了更多 reasoning tokens，这种随机性大量的存在于测试中并且对实验结果产生重大影响，使当前的小样本测试失去了统计学意义。

当前结果更适合被理解为早期但有价值的信号：

- 通过 Claude Code `PostToolUse:Bash` takeover 可以工作；
- 本地 command-observation compression 可以很大；
- 保守安全规则减少了明显的信息损失风险；

CCA 因此应被视为实验性基础设施。默认配置优先安全而不是最大压缩率；项目也欢迎 benchmark traces、case reports 和关于规则边界的讨论。
