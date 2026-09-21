# 群星回响 · 制作 Wiki

发布目标：https://wiki.stellar-echoes.online

独立静态 Wiki，使用 Astro + Starlight、Pagefind 全文搜索和 Cloudflare Pages。游戏和原始设计包继续保留；此目录只负责公开文档与展示。

## 编辑

- 内容：`src/content/docs/` 中的 Markdown/MDX。
- 图鉴：`src/data/art.json`；公共图稿位于 `public/art/`。
- 过程记录：`process/timeline.md`、`decisions.md`、`reviews.md`；退回版本记入 `process/archive.md`。
- 逐图提示词：`src/data/prompt-records.json` 保存每张图的完整原文、引用图和编辑链；构建自动导出 `public/records/concept-prompts.json`。
- 图文使用 `ArtFigure`，图鉴使用 `PromptDetails`，避免只有图片却没有对应生成记录。
- 固定浅色：自定义主题提供器和静态构建收尾统一首屏主题；无主题切换入口。

新增条目应写清日期、状态、设计理由、对应图稿及仍待解决的问题。更新图片使用新版本名并保留旧版，不要把“已经画出”写成“已经实现”。

## 本地验证

```sh
npm ci
npm run build
npm run check:public
npm run preview
```

本地预览在4191端口。生产构建包含全文搜索索引；开发服务器的搜索不作为验收依据。

## 发布

`wrangler.jsonc` 固定 Pages 项目 `stellar-echoes-wiki`，`scripts/deploy.mjs` 通过进程环境固定指定 Cloudflare account，并拒绝不一致的账户覆盖。命令 `npm run deploy` 发布构建产物；执行前需在进程环境提供该账户凭据。凭据不放入此工程或网页。

正式域名为 `wiki.stellar-echoes.online`；原主域名通过单独的 Cloudflare Redirect Rule 保留路径跳转到 Wiki。后续发布应先构建、检查公开内容、实看页面并记录产物校验，再执行经授权的部署。工程仓库为 `redacted-user/stellar-echoes`，本站位于其中的 `outputs/stellar-echoes-wiki`；未配置 Git 自动部署，提交或推送本身不会自动上线。

## 公开范围

公开原创概念图、经过整理的自创世界设定、制作过程和公开官网引用。私有知识库原文、内部链接、本机操作日志、账户信息和凭据不进入 `public/` 或正文。
