# WB-C1：Claude 独立设计的世界观 benchmark（进行中）

状态：**进行中**，任务入口 [#33](https://github.com/StellarEchoesGame/worldbuilding/issues/33)。本目录是 2026-09-24 从任务工作树原样收入仓库的快照；除本 README 外没有改写任何文件。它是一套**评测方法**，尚未对世界正文运行，也没有产生任何分数。

## 目录

| 路径 | 内容 |
|---|---|
| `inputs/` | 系统提示 `system.txt`、独立设计简报 `independent-design-brief.md`（`stage-a-freeze.json` 记录其哈希）、各轮修订简报 `revision-N-brief.md`；`revision-brief.md` 是调用脚本反复覆盖的工作副本，最终内容与 `revision-4-brief.md` 相同 |
| `calls/<stage>/` | 每次真实调用的原始 stdout、`response.json`、正文 `claude-output.md` 与 `request-metadata.json`（模型标识、哈希、用量）。`revision-1` 至 `revision-4` 另存该轮实际发送的提示为 `input.md`；`independent` 阶段没有 `input.md`，其输入就是 `inputs/independent-design-brief.md` |
| `review/` | 协调方（Codex 根智能体）写的对照说明 `comparison.md`、出处记录 `provenance.md`、失败记录 `revision-1-failure.md`。`b1-observed-limitations.md` 由独立 Codex 任务实例 `claude_benchmark_baseline_inventory` 仅依据 WB-B1 的 `PROTOCOL.md`、`REPORT.md`、`runs/initial/adjudication.md` 三份记录写成（它读了这三份 WB-B1 记录，未读世界正文，未评 WB-C1）。`executability-*.md` 由另一独立任务实例 `claude_benchmark_executability` 写成，它未读世界正文也未读 WB-B1；`provenance.md` 里“审查者未读世界正文或 WB-B1”一句指的是后者 |

核对提示哈希时注意：`revision-1` 至 `revision-3` 的 `request-metadata.json` 里 `prompt_file` 指向工作副本 `inputs/revision-brief.md`，该文件后来已被覆盖；`prompt_sha256` 应对照同目录 `input.md`（或 `inputs/revision-N-brief.md`）校验。调用脚本 `run_claude.py` 与打包脚本 `finalize.py` 不在本快照内（它们读取本机 Claude Code 配置），是否入库由 #33 决定。

## 调用与版本

| 阶段 | 结果 | 产物 |
|---|---|---|
| `independent` | 成功 | v0 方法（只收到产品简报，未见原稿、旧题库、旧分数） |
| `revision-1` | 失败，`max_tokens` 空返回 | 见 `review/revision-1-failure.md` |
| `revision-2` | 成功 | **v1 协议全文**（对应 `review/executability-v0.md` 六项审查） |
| `revision-3` | 成功 | **v1.1 勘误及执行补充**（对应 `review/executability-v1.md` 三项阻断） |
| `revision-4` | 成功 | **v1.2 判定勘误**，整体替换 v1.1 的 G1.1（对应 `review/executability-v1.1.md` 唯一阻断） |

所有调用均为 Claude Code CLI 显式指定 `claude-code/claude-opus-5-5[1M]`，响应规范模型标识 `claude-opus-5-5`；网关与独立性限制见 `review/provenance.md`。

## 尚未完成

- v1.2 尚无可执行性复核；v1 + v1.1 + v1.2 尚未合并成一份可直接执行的协议文本。
- #33 尚未交付和关闭。
- `review/b1-observed-limitations.md` 引用的三个绝对本地路径对应仓内 `../WB-B1/PROTOCOL.md`、`../WB-B1/REPORT.md`、`../WB-B1/runs/initial/adjudication.md`；原文按出处记录保留。
