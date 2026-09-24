# 修订 8 的输入文件（哈希锁定，原样落地）

`world/current/inputs.json` 记录了修订 8（2026-09-24）整合时读取的七份输入文件及其 SHA-256。修订 7 的 BOOK 已随 #34 落地；其余六份此前只存在于任务工作树中，本目录按 #36 原样收入，不做任何改写。校验方法：对每个文件计算 SHA-256，须与 `inputs.json` 中同 id 的值一致（`index.json` 复制了这些值）。

| id | 文件（相对本目录） | 来源任务 | SHA-256（前 16 位） | 修订 8 的使用说明（摘自 `inputs.json`） |
|---|---|---|---|---|
| `world-book-revision-7` | `../revision-7/BOOK.md`（#34 已落地） | #16 | `3f15735dacb4e498…` | 只继承未被新版战争/文明/主线替换的规则与人物；原文已归档 |
| `mainline-framework` | `mainline-framework/FRAMEWORK.md` | #27 | `eb926d6ddd1ba03a…` | 主线阶段/人物欲望输入；自然灾害和原角色身份不继承 |
| `cosmic-scope` | `cosmic-scope/SCOPE.md` | #28 | `785618cbf40b18d5…` | 采用尺度和16区域配额；S0与S7职责更新 |
| `scope-atlas` | `scope-atlas/atlas.json` | #28 | `55421887df1f2c1c…` | 沿用坐标；详细航段新增S0-S2 |
| `route-departure` | `route-departure/ROUTE.md` | #29 | `73626554867c9879…` | 保留反例审查方法；旧和平/自然灾害时间与库存推演不沿用 |
| `first-year-community` | `first-year-community/01-community.md` | #23 | `cdba25401e2e057a…` | 人口与家庭输入；旧日期/排班不成为战时证明 |
| `first-year-culture` | `first-year-culture/03-culture.md` | #25 | `cd514e9b69cbf626…` | 生活细节输入；旧首年日期不继承 |

这些文件是修订 8 的**输入**，不是现行设定：现行设定以 `world/current/BOOK.md` 与 `world/current/reference/` 为准，`inputs.json` 的"使用说明"一栏写明了每份输入中哪些内容被继承、哪些不再沿用。文件内的日期、排班、库存推演等按该栏说明理解。
