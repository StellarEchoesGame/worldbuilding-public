# 群星回响 · Stellar Echoes

一款正在制作中的单人星际探索游戏，围绕远征、资源规划、建设与文明生活展开。归航号是一艘持续生活和探索的文明家园；“归航”也意味着寻找值得继续生活与探索的理由。

**敬群星。**

制作 Wiki：[wiki.stellar-echoes.online](https://wiki.stellar-echoes.online/) · [完整制作路线图](outputs/stellar-echoes-unity/Worldbuilding/12-后续制作路线图.md)

## 当前阶段

已有 Unity 6 原生可玩原型、渐进教学、资源与建设、出入港过场、航程存档和首章通讯剧情。正在完善世界观与母舰概念设计，手稿中的母舰生活社区尚未全部进入游戏。当前原型的七至九人资源规则，与新设定中的全舰人口分开理解；七名核心人物不代表全舰只有七个人。

先完成可评审的概念设计，再进入 Blender 空间与运镜验证和 Unity 实现。AI 手稿保留完整原始提示词、参考图与修改链；历史退回方案保留版本与评审原因。已有验证报告按其原始日期和版本解读，不代表本次仓库初始化重跑了游戏测试。

## 工程目录

为保持既有脚本、素材引用与制作记录可追溯，首次入库保留原目录结构。

| 目录 | 内容 |
| --- | --- |
| [Unity 工程](outputs/stellar-echoes-unity/) | 游戏源码、场景、资源、测试与工程设置；Unity **6000.6.0f1** |
| [世界观与制作路线图](outputs/stellar-echoes-unity/Worldbuilding/README.md) | 设定、科技边界、剧情与设计依据 |
| [母舰设计包](outputs/stellar-echoes-unity/Worldbuilding/MothershipDesign/) | 外观、内装、舰载机体、生活场景与邻里概念，含提示词及评审 |
| [Blender 美术源文件](outputs/stellar-echoes-unity/ArtSource/) | 现有原型的可编辑模型、生成脚本与导出资产 |
| [制作 Wiki](outputs/stellar-echoes-wiki/) | Astro / Starlight 浅色文档站，含逐图提示词与搜索 |
| [开场影像实验](outputs/cinematic-experiment-01/实验报告.md) | 世界观手稿、白模运镜、视频生成与剪辑实验；实验成片不等于最终开场验收 |
| [早期浏览器原型](outputs/stellar-echoes/) | 保留用于追溯，当前正式引擎方向为 Unity |

## 获取完整素材

图片、Blender/FBX/GLB、音视频与字体使用 **Git LFS**。安装 Git 和 Git LFS，并以有权限的 GitHub 账户认证后：

```sh
git lfs install
git clone https://github.com/redacted-user/stellar-echoes.git
cd stellar-echoes
git lfs pull
git lfs fsck
```

GitHub 网页的源码 ZIP 不作为完整素材交付方式；使用带 LFS 的克隆。Unity 导入会在本机重建 Library，首次导入可能需要下载锁定的依赖。

## 启动

**游戏：**用 Unity Hub 和 **6000.6.0f1** 打开 `outputs/stellar-echoes-unity`，运行 `Assets/StellarEchoes/Scenes/TidalGarden.unity`。Unity CLI、测试及原生构建命令见 [Unity 工程说明](outputs/stellar-echoes-unity/README.md)。

**Wiki：**使用 Node.js 22.12 或更新的受支持版本，在目录内执行：

```sh
cd outputs/stellar-echoes-wiki
npm ci
npm run build
npm run check:public
npm run preview
```

预览地址为 `http://127.0.0.1:4191/`。GitHub 推送与 Wiki 线上部署分开；仓库初始化不改变现有 Cloudflare 站点。

## 入库边界

保留源码、原始设计文档、图片与提示词、模型、精选运镜视频、实验成片及已有验证记录。排除 Unity/Node 缓存、构建 ZIP、逐帧渲染序列、未完成下载、本机工作日志和凭据。这些排除项仍保留在原本机目录，未删除。发布包通过 Unity 构建流程重新生成。

第三方字体的版权与 SIL Open Font License 保留在 [字体来源目录](outputs/stellar-echoes-unity/ArtSource/fonts/)。本仓库尚未指定整体开源许可证。
