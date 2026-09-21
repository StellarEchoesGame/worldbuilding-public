# 群星回响 · 世界观与概念设计

这是 [StellarEchoesGame](https://github.com/StellarEchoesGame) 的世界观、概念手稿与制作 Wiki 仓库。游戏运行工程、Blender 运行资产和过场制作工程在 [game](https://github.com/StellarEchoesGame/game)；本仓可以独立构建公开 Wiki，不需要检出游戏仓库。

在线阅读：[群星回响 Wiki](https://wiki.stellar-echoes.online/)。当前母舰仍处于概念设计阶段；平剖、透视图和提示词中的目标不代表工程验证或 Unity 实装。

## 从哪里读

- [世界观入口](world/README.md)：时代、规则、文明、人物与归航号使命。
- [母舰概念包](concepts/mothership/README.md)：外形、港口、舰内、机体、邻里平剖及返修记录。
- [早期手稿](concepts/sketchbook/README.md)：保留探索方向和实际生成历史。
- [后续制作路线图](world/12-后续制作路线图.md)：下一阶段的顺序与验收边界。
- [Wiki 编辑说明](wiki/README.md)：公开条目、图鉴与完整提示词的展示方式。

## 目录职责

| 目录 | 维护内容 |
| --- | --- |
| `world/` | 世界设定正文、设计依据与候选方案；明确历史记录、当前设定和未定项 |
| `concepts/mothership/` | 母舰原图、历史版本、原始生成输入、设计规格与布局数据 |
| `concepts/sketchbook/` | 前期概念探索、原图与生成记录 |
| `wiki/` | Astro/Starlight 站点、公开文章、图鉴与适合公开的提示词记录 |
| `docs/migration/` | 拆仓来源与原路径对应记录；不作为运行时依赖 |

PNG 等原始二进制由 Git LFS 管理，在 `concepts/` 只保留一份制作来源。Wiki 的 `public/art/` 和 `public/records/neighborhood/` 是构建副本，不另行入库；它们的线上 URL 保持原样。`wiki/asset-sources.json` 固定每份副本的源路径、目标路径和 SHA-256，构建会拒绝内容不符的源文件。`public/records/concept-prompts.json` 则由 Wiki 的提示词记录导出。

## 独立本地构建

先通过 Git LFS 取得原图的完整内容；如果检出的是 LFS 指针而非图像，素材校验会失败。本轮验证使用 Node.js 26.7.0、npm 11.19.0，依赖版本由 `wiki/package-lock.json` 固定。

在本仓根目录执行：

```sh
npm --prefix wiki ci --no-audit --no-fund
npm --prefix wiki run build
npm --prefix wiki run check:public
npm --prefix wiki run preview
```

构建会先校验并生成素材副本、导出完整提示词，再生成静态网站和搜索索引。公开检查覆盖站内链接、公开信息边界、固定浅色、图片与提示词对应、提示词完整原文和发布素材哈希。预览端口为 4191；开发时可运行 `npm --prefix wiki run dev`，它也会先准备素材。

本地安装、构建、提交或推送不会自动部署 Cloudflare。Wiki 的现有域名和 Pages 配置保留；生产发布是独立操作，本次拆仓没有修改线上服务。

## 原始记录与未来协作

实际发送给图像模型的 JSON/TXT 提示词、参考图顺序和历史绝对路径均保留原文。旧本机路径和原目录名是**历史生成记录**，不作为新仓执行入口，也不要求他人的电脑存在这些路径。迁移后的阅读入口使用当前相对链接；跨游戏仓库的链接指向组织内 `game` 仓库。

新增或返修手稿时保留旧图，追加实际生成步骤与参考来源。确认公开范围后，更新 Wiki 图鉴、公开提示词记录、`asset-sources.json` 与 `public/records/art-manifest.json` 的对应项，再完成构建检查。提示词中的工程要求不能替代实际评图。

世界观与手稿在本仓评审，游戏机制和运行资产在 `game` 验证。两端交接时给出具体文件、版本或提交与验收范围；不要把新的母舰候选图直接视为已经替换游戏资产，也不要把同一原始图片另存到游戏仓库作为第二个制作源。
