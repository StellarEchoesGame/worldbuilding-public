# 群星回响 · 当前世界设定

当前查阅入口：[世界设定参考集 8.1](reference/README.md)，按空间、技术、制度、经济、战争、生态和文化组织；执行与评审见 [WB-D1 · #31](https://github.com/StellarEchoesGame/worldbuilding/issues/31)。

主线与共同底稿保留为 [revision 8 总稿：把家带向群星](BOOK.md)，原整合任务见 [WB-R8 · #30](https://github.com/StellarEchoesGame/worldbuilding/issues/30)。它提供概览，详细世界运作查上面的参考条目。

revision 8把已同意的战争开场、多文明接触、母舰命名、舰长身份与远征玩法整合为统一基线；8.1参考集进一步展开世界运作细节。旧文的原始内容和实际图像生成记录保留；发生冲突时，以本目录修订为当前写作依据，不能把历史稿与当前稿拼成一个同时存在的宇宙。

| 源章节 | 内容 |
|---|---|
| [宇宙与时代](01-universe.md) | 主题、规模、历史、航行通信与能力边界 |
| [文明及关系](02-civilizations.md) | 绮珀人、阈庭联政、回纹共同体与既有接触 |
| [战争与启航](03-war-and-departure.md) | 本地抵抗、息壤单程、回向接应和更名 |
| [生活与人物](04-life-and-people.md) | 人口、岗位权力、家户、日常及个人愿望 |
| [航程与玩家](05-voyage-and-play.md) | 舰长、五类玩法的共同循环、主线与分支 |
| [连续性和地图](06-continuity-and-map.md) | 时序、接应演绎、反例、首发范围与留白 |
| [修订对照](REVISION.md) | 接受、替换、保留和暂不决定的内容 |
| [来源清单](inputs.json) | 输入版本、SHA-256、原任务与采用范围；原文见 [history/inputs-revision-8](../history/inputs-revision-8/README.md) |
| [审读与验证](REVIEW.md) | 冻结版本、独立审读、修改与验证范围 |

总稿由六个源章节依序生成，编辑源文后运行 `python3 world/current/build_book.py`，同时更新 `manuscript-hashes.json`。它只整编文本，不生成宇宙、不定义游戏接口。

本版完成的是世界观文档。GitHub Issue 保存可读交付与证据；Git 提交、合并和线上 Wiki 发布分别有自己的状态，不能由本地文件存在推断已经发布。M1—M9制作继续暂停，没有生成新手稿、模型、视频或游戏功能。
