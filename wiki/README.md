# 群星回响 · 制作 Wiki

发布目标：https://wiki.stellar-echoes.online

独立静态 Wiki，使用 Astro + Starlight、Pagefind 全文搜索和 Cloudflare Pages。游戏运行工程在组织内的 `game` 仓库；本仓的 `world/` 与 `concepts/` 保存设定和原始设计包。本目录负责公开文档与展示，构建不依赖游戏仓库。

## 编辑

- 内容：`src/content/docs/` 中的 Markdown/MDX。
- 图鉴：`src/data/art.json`。原图只保存在 `../concepts/`；`asset-sources.json` 固定源路径、公开路径及 SHA-256，构建生成 `public/art/` 和 `public/records/neighborhood/`，生成副本不入库。不要直接修改这些副本。
- 过程记录：`process/timeline.md`、`decisions.md`、`reviews.md`；退回版本记入 `process/archive.mdx`。
- 逐图提示词：`src/data/prompt-records.json` 保存每张图的完整原文、引用图和编辑链；构建自动导出 `public/records/concept-prompts.json`。
- 图文使用 `ArtFigure`，图鉴使用 `PromptDetails`，避免只有图片却没有对应生成记录。
- 固定浅色：自定义主题提供器和静态构建收尾统一首屏主题；无主题切换入口。

新增条目应写清日期、状态、设计理由、对应图稿及仍待解决的问题。更新图片使用新版本名并保留旧版，不要把“已经画出”写成“已经实现”。

## 本地验证

```sh
npm ci --no-audit --no-fund
npm run build
npm run check:public
npm run preview
```

以上命令在 `wiki/` 中执行，也可从仓库根使用 `npm --prefix wiki …`。已用 Node.js 26.7.0、npm 11.19.0 独立安装依赖。`build` 与 `dev` 启动前会校验源素材哈希并生成副本；如果提示哈希不符，应检查源图和版本清单，不能跳过校验。

本地预览在4191端口。生产构建包含全文搜索索引；开发服务器的搜索不作为验收依据。

## 发布

`wrangler.jsonc` 固定 Pages 项目 `stellar-echoes-wiki`，`scripts/deploy.mjs` 通过进程环境固定指定 Cloudflare account，并拒绝不一致的账户覆盖。命令 `npm run deploy` 发布构建产物；执行前需在进程环境提供该账户凭据。凭据不放入此工程或网页。

正式域名为 `wiki.stellar-echoes.online`；原主域名通过单独的 Cloudflare Redirect Rule 保留路径跳转到 Wiki。后续发布应先构建、检查公开内容、实看页面并记录产物校验，再执行经授权的部署。工程仓库为 `StellarEchoesGame/worldbuilding`，本站位于 `wiki/`；未配置 Git 自动部署，提交或推送本身不会自动上线。拆仓及本地验证不调用发布命令，不修改现有域名、DNS、重定向或 Cloudflare 项目。

## 公开范围

公开原创概念图、经过整理的自创世界设定、制作过程和公开官网引用。私有知识库原文、内部链接、本机操作日志、账户信息和凭据不进入 `public/` 或正文。

## 生成记录

`../concepts/` 中的原始提示词、参考路径与生成日志保留当时字节；其中旧目录名和本机绝对路径明确属于历史记录，不是当前构建依赖。公开提示词档案保留完整实际输入和参考顺序，页面与素材 URL 沿用原站。源码迁移记录见仓库根的 `docs/migration/`。
