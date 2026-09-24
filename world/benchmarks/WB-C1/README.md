# WB-C1：Claude 设计的世界观 benchmark

任务入口 [#33](https://github.com/StellarEchoesGame/worldbuilding/issues/33)。本目录交付的是一套**评测方法**，尚未对《群星回响》世界正文运行，也没有产生任何分数；它独立于旧 [WB-B1](../WB-B1/README.md)，旧成绩不转换为本协议结论。

## 当前有效版本

**[`PROTOCOL.md`](PROTOCOL.md) = v1.3 合并可执行版。** 它把 Claude Opus 5.5 的 v1 全文、v1.1 勘误、v1.2 判定勘误合并成一份可直接执行的协议。原文无法唯一执行之处由合并者做了编辑决定，正文以〔ED编号〕标注，§9 逐条列出问题、决定与依据，并列出逐节来源。执行时以它为准；三份原文原样保留在 `calls/`。

判定规则（子问状态 → 题目档位 → 维度 → 跨轮合成 → 最终结论）的可执行形式是 [`judgment.py`](judgment.py)；[`test_judgment.py`](test_judgment.py) 测试这些规则，协议 §8 逐例注明对应的测试名。抽样、检索、评委合并与校准是程序规则，代码不覆盖。运行：

```sh
python3 world/benchmarks/WB-C1/test_judgment.py
```

方法要点：九个维度、十三类题目、分项判定与硬失败条件、确定性抽样与实例选择、证据分层、虚构校准材料、文档审查轨（模型）与真人审读轨的边界。不设作品综合分数。阈值（30% 悬空率、样本量公式、150 条目阅读预算、2 家族 3 会话）是初始约定，尚未经实际作品样本验证。

## 目录

| 路径 | 内容 |
|---|---|
| `PROTOCOL.md` | v1.3 合并可执行版（当前有效） |
| `judgment.py` / `test_judgment.py` | 判定规则代码与测试 |
| `CALL-INDEX.json` | 五次真实 CLI 调用的索引：模型标识、状态、提示与输出哈希、费用估算 |
| `inputs/` | 系统提示 `system.txt`、独立设计简报 `independent-design-brief.md`（`stage-a-freeze.json` 记录其哈希）、各轮修订简报 `revision-N-brief.md`；`revision-brief.md` 是调用脚本反复覆盖的工作副本，最终内容与 `revision-4-brief.md` 相同 |
| `calls/<stage>/` | 每次真实调用的原始 stdout、`response.json`、正文 `claude-output.md` 与 `request-metadata.json`。`revision-1` 至 `revision-4` 另存该轮实际发送的提示为 `input.md`；`independent` 阶段的输入就是 `inputs/independent-design-brief.md` |
| `review/` | 见下表 |

核对提示哈希时注意：`revision-1` 至 `revision-3` 的 `request-metadata.json` 里 `prompt_file` 指向工作副本 `inputs/revision-brief.md`，该文件后来已被覆盖；`prompt_sha256` 应对照同目录 `input.md` 校验（`CALL-INDEX.json` 已代为核对）。调用脚本 `run_claude.py` 与 Codex 的打包脚本 `finalize.py` 不在仓库内（它们读取本机 Claude Code 配置）。

## 调用与版本

| 阶段 | 结果 | 产物 |
|---|---|---|
| `independent` | 成功 | v0 方法（只收到产品简报，未见原稿、旧题库、旧分数） |
| `revision-1` | 失败，`max_tokens` 空返回 | 见 `review/revision-1-failure.md` |
| `revision-2` | 成功 | **v1 协议全文**（回应 `review/executability-v0.md` 六项审查） |
| `revision-3` | 成功 | **v1.1 勘误及执行补充**（回应 `review/executability-v1.md` 三项阻断） |
| `revision-4` | 成功 | **v1.2 判定勘误**，整体替换 v1.1 的 G1.1（回应 `review/executability-v1.1.md` 唯一阻断） |
| 合并 | 会话内 | **v1.3** `PROTOCOL.md` + `judgment.py`，经两轮独立可执行性审查（`review/executability-v1.3.md`） |

所有 CLI 调用均显式指定 `claude-code/claude-opus-5-5[1M]`，响应规范模型标识 `claude-opus-5-5`，经本机既有第三方网关；这是配置与响应元数据证据，不是网关上游身份的独立证明（`review/provenance.md`）。

## 作者与审查分工

| 角色 | 执行者 | 说明 |
|---|---|---|
| 设计（v0–v1.2） | Claude Opus 5.5，CLI 调用 | 第一轮只收到产品目标；修订轮收到初稿与可执行性反馈，未见原稿、旧题库、旧成绩 |
| 协调、对照说明、出处记录（至 v1.2） | Codex 根智能体（本机 Codex 会话记录中的模型标识为 gpt-6-astra；该记录不在仓库内，标识未经核验） | `review/comparison.md`、`provenance.md`、`revision-1-failure.md` |
| 旧局限对照 | 独立 Codex 任务实例 `claude_benchmark_baseline_inventory` | `review/b1-observed-limitations.md`，仅依据 WB-B1 三份记录，未读世界正文 |
| 可执行性审查 v0–v1.1 | 独立 Codex 任务实例 `claude_benchmark_executability` | `review/executability-v0.md`、`-v1.md`、`-v1.1.md`，未读世界正文也未读 WB-B1 |
| 合并 v1.3 初稿、判定代码、本 README、`CALL-INDEX.json` | Claude Fable 5.1（协调会话内） | 不新增维度、题目、阈值或校准材料 |
| 按第一轮审查修订 v1.3 与判定代码 | Claude Opus 5.5（同一协调会话，中途切换模型） | 编辑决定 ED1–ED26 见协议 §9.2。与原设计调用是同一模型版本，因此不构成对原设计的独立复核 |
| 按第二轮审查修订 v1.3 与判定代码、撰写审查记录 | Claude Fable 5.1（同一协调会话，切回） | 编辑决定 ED27–ED33、ED35 及既有决定的扩展见协议 §9.2；代码新增 F0 登记入口与题号、封顶条款名校验 |
| 可执行性审查 v1.3（两轮） | 无继承上下文的独立 Claude 实例（工作流），两轮均为 Claude Fable 5.1 | `review/executability-v1.3.md`；与合并者同属 Claude 家族，不冒称另一家族 |

外部模型能增加方法来源差异，不能消除共享训练知识、相近审美和模型共同偏差；实际作品吸引力仍需真人与游戏体验验证。

## 下一步

- 第一轮实际执行（对冻结的参考集 8.1）另开 issue：需要至少 2 个模型家族的 3 个评委会话（5.4），以及抽样、实例化与记录工具。
- `review/b1-observed-limitations.md` 引用的三个绝对本地路径对应仓内 `../WB-B1/PROTOCOL.md`、`../WB-B1/REPORT.md`、`../WB-B1/runs/initial/adjudication.md`；原文按出处记录保留。
