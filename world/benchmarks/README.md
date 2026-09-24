# 世界观评测

本目录保存对《群星回响》现行世界设定的评测协议、快照与证据。它们记录"某个版本的正文在某套方法下表现如何"，不是设定本身；写作与制作以 [`world/current/`](../current/README.md) 为准，旧评测结果也不随正文修订自动失效或更新。

| 评测 | 状态 | 内容 |
|---|---|---|
| [WB-B1](WB-B1/README.md) | 已完成一轮（[#32](https://github.com/StellarEchoesGame/worldbuilding/issues/32)） | 对 reference 8.1 与 revision 8 总稿的评分快照：协议、题库、冻结记录、两位审读者的完整回答与报告 |
| [WB-C1](WB-C1/README.md) | 协议已交付，尚未运行（[#33](https://github.com/StellarEchoesGame/worldbuilding/issues/33)；首次运行 [#40](https://github.com/StellarEchoesGame/worldbuilding/issues/40)） | Claude 设计的评测方法：v1.3 合并可执行协议、判定规则代码与测试、五次真实调用的原始记录、两轮可执行性审查 |

两套评测相互独立：WB-C1 不转换 WB-B1 的成绩，WB-B1 的题目也不进入 WB-C1 的题库。目录内的 `.txt` 原始调用记录按哈希锁定，`.gitattributes` 固定为 LF 换行，以便在任何平台检出后哈希不变。
