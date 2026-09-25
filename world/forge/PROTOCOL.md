# 回响工坊（WB-F1）执行协议

Protocol version: 1.1

**效力**：本文件把 [epic #1](https://github.com/StellarEchoesGame/worldbuilding-public/issues/1) 的设计写成可执行协议。引擎以本文件的机器可读块（§11）为准；正文与机器可读块不一致时以机器可读块为准，并须在下一版修正正文。设计讨论、取舍理由与审查记录留在 epic 与各子 issue，本文件只写规则。

**协议包**：本文件、`families.json` 与 `judges.json` 合称协议包，其哈希按 §11 的 `protocolBundleHash` 规则计算。引擎只有在协议包哈希等于 owner 在 UI 基准页最近一次批准的哈希时，才冻结新轮次或启用新基准版本（F1-04 起生效）。代理可以提交修改协议包的 PR，但须在 owner 批准新哈希之后才合并。

**实现状态**：§12 列出每条规则的落地情况。尚未落地的规则在对应子 issue 交付前不约束运行，只约束设计。

---

## 1. 系统与角色

四个核心功能：
- **基准维护者**：本机 `claude -p`，Fable 5.1，思考档位 max，无工具。每轮 owner 决策之后读取证据包，决定出新版 `benchmark/vN.json` 或不改（§8）。
- **写手**：第三方 OpenAI 兼容网关，默认每个槽位 `deepseek/deepseek-v4.1-flash`，在 `writers.json` 或 UI 配置页修改，下一次冻结起生效。网关主机名与凭证路径只存在于被 git 忽略的 `local.json`。
- **评委组**：Codex `gpt-6-astra` max、Claude Code Opus 5.5 max、Kimi Code `kimi-code/k3` max、Grok `grok-4.7` xhigh。每次调用都在全新临时目录、无工具、不加载操作者的记忆、技能、规则与钩子；记录 CLI 版本、请求模型与实际服务模型，实际服务模型不在 `judges.json` 的接受列表内、或列表非空而 CLI 未报告实际服务模型时，该次调用作废（接受列表须写全 CLI 可能报告的每个模型标识；CLI 同时列出辅助模型时以列表内的那个为准）。
- **审阅 UI**：Astro SSR，只监听 127.0.0.1，owner 在自己的终端启动。

**作者家族**：`families.json` 把模型编号映射到厂商家族，网关本身不是家族。文本的作者家族是写出它的模型的家族；修订 8 / 参考集 8.1 的原文与任何取自其中的金标准段落算 OpenAI（出自 Codex 线程），owner 另行认定的除外。评委家族不评含有本家族文本的对子、事实门材料或惊喜推理链。

**有效家族 E**：某一擂台对的有效家族 = 已获资格、未被标记、未被停用、不是作者、且没有因作废会话退出（§3）的评委家族。|E| ≥ 3 正常比较；|E| ≤ 2 为试验对，不能替换擂主，也不能进入正典。标记与停用状态在冻结时写入 `freeze.json`，续跑沿用。

## 2. 事实地位与事实门（第 0 层）

**事实地位**：参考集 07 §2 的 F01–F15 按 `fact-status.json` 各对应一种 07 §1 地位与若干薄层图行（`ALL` 表示全部行）。该文件由 F1-01 提出，`owner_confirmed` 为 false 期间按提出的地位执行，歧义条目在 UI 中提示 owner 确认。

**分句**：全系统共用一个分句器：去掉 Markdown 后按 `。！？；…`（及半角 `!?;`）与换行切分，闭合引号随前句，表格每个单元格单独成句。句子本身保留原文；比较句子、引文、词条与连接词时两侧都做 NFKC 规范化。

**机械门**（引擎执行，全部通过才算通过；阈值见 §11 `limits`）：
1. 三个输出块齐全且可解析；`delta` 每条说法的 `source_quote` 逐字出现在正文中。
2. 正文按字符计不超过上限（去掉 Markdown 标记后按 Unicode 码点计，与 `wc -m` 一致）。
3. 新专名不超过上限，且每个新专名至少出现在两个句子里（不留悬空专名）。
4. `register:true` 的作者事实不超过上限；没有 `extends` 的作者事实不超过上限；每条作者事实的 `attaches_to` 以条目编号 01–08 开头。
5. 叙述中的规则句占比不超过上限（对白除外；规则词正则见 `engine/text.ts`）。
6. 禁词：先去掉 Markdown、删除不可见格式字符、把段落内的单个换行接起来，再分句。句子按 `，,；;：:、` 切成分句；分句内被空白、连字符或间隔号拆开的禁词（如"跨星-即时"）也算出现，按其所在分句判断是否被否定；被逗号等分句标点或破折号隔开的两个字不算组成禁词（如"一觉，醒来""有星——门开着"），这类情况交给 LLM 事实门；禁词的某次出现只有在它所在分句含有 §11 `negations` 中的否定词、且该否定词不落在 §11 `negation-exceptions` 的词里（如"不久""非常"）时才算被否定。任一出现未被否定则判失败；全部被否定的句子只记为标记（UI 显示 ⚠），交给 LLM 事实门评委查看。比较前两侧都做 NFKC 规范化。维护者的陈词清单只作写作提示与统计，永远不构成门。
7. 接口卡有 3 个镜头、1 个物件、1 个钩子（第 3 层另行判定内容是否够用）。
8. 正文不得含链接、图片或 HTML 标记（`](`、`![`、`<标签`），因为去掉 Markdown 时这些位置的文字会被删掉而不受检查。
9. 基线稿不得有作者事实与新专名。

**LLM 事实门**（F1-03 落地）：每篇稿件由 2 个按种子选出、非作者的评委家族对照冻结的事实表（07 §2 + 已登记 Rxx）与 `regression/wb-b1.json` 判定是否矛盾，逐字引证；两家都判"矛盾"则不通过，分歧上决策卡。**注入缺陷**：按种子从 §11 `defect-types` 中选一个可用类型（`requires: "rxx"` 的类型只在简报含至少一条已登记 Rxx 时可用；第 0 轮演练用 §11 `fixture-rxx`），由缺陷写手改写某篇稿件副本中的一句，副本只发给该稿件的事实门评委；评委判"矛盾"且引文与注入句重叠才算抓到，漏抓的评委本轮事实门判定作废，由另一有效家族的新会话替补。每轮只注入一个缺陷类型、只给一篇按种子选出的稿件做一份副本。违背地位为状态与路径实例的事实只单独记录、不使判定成立；违背已登记 Rxx 或 `regression/wb-b1.json` 证据句一律有效。每个写手槽可重交一次；重交是盲重交，写手只拿到原简报，看不到事实门评语。

## 3. 口味比较（第 1 层）

**擂主**：每个薄层图行在 `champions.json` 里有一个擂主，`kind` 为 `baseline`（零新事实基线，该行第一次冻结时由基线写手写一次）、`owner_pick`（owner 选中且胜擂的稿件）或 `golden`（owner 指定的金标准段落，记录作者家族）。基线只在 owner 批准的"重写基线"之后改写。

**擂台对**：候选稿对擂主。每个有效家族跑 2 个会话对（§11 `bars.session_pairs`）；一个会话对 = 同一对子在两个全新调用里正反两序各评一次，两序都选候选才算一胜。每次调用同时评一组诱饵对（擂主 vs 按诱饵配方泛化细节后的擂主，随机位置，放在真对之后），选了诱饵的调用使其会话对作废；作废会话对重跑一次，重跑后仍有作废的家族退出该对的 E，因此每个计入的家族恰好贡献 2 个会话对。

**胜擂**：|E| = 4 时至少 7/8 胜（维护者可收紧到 8/8，不可放宽）；|E| = 3 时须 6/6。零假设下的假通过上界：会话对独立时 3.5%（|E|=4）与 1.6%（|E|=3）；同一家族两个会话完全相关时 6.25% 与 12.5%。替换擂主还需要 owner 选中该稿件。

**辅助比较**：候选稿之间、候选稿对前两任擂主（锚点）由 2 个按种子选出的有效家族各评一次正反两序，只用于排序（Bradley–Terry，每对两侧各加 0.5 伪计数），不决定擂主替换。汇总报告每个擂台对的家族级胜负符号计数；会话级二项 p 值只作描述。

**匿名化**：评委与 owner 盲审看到的文字经过同一匿名化处理：去掉开头的标题行与 Markdown 标记，弯引号改为「」『』，省略号统一为 ……。合并与 mergecheck 始终使用冻结的原始稿件，不使用匿名化后的文字。

**决定性问题**：基准版本的 `taste.decisive` 指定的问题决定胜负，其余问题只报告。每个回答须逐字引用所选稿件中至少 `taste.min_quote_chars` 个字的连续原文，否则该次调用视为无效并重试一次。

## 4. 惊喜（第 2 层，F1-03 落地）

写稿之前，4 个评委家族与每个不同的写手模型各开一个全新会话，预测该单元格最可能出现的 8 个（槽位, 取值）细节，合成 `sealed.json`（规范 JSON：UTF-8、NFC、键排序、LF），存于被 git 忽略的 `.sealed/`。`probes.sha256` = SHA-256(32 字节随机数 ‖ sealed.json)，由引擎提交并推送到轮次分支，并在轮次 issue 发评论；拿到 GitHub 返回的评论时间之前不开始写稿，该时间写入 `freeze.json`。解封时随机数与 `sealed.json` 必须复现 `probes.sha256`，否则本轮惊喜记为无效。

合格细节 = 无提示回忆步骤中至少一位有效评委主动提到的细节（最多 6 个）。两个按种子选出的有效家族对照 `sealed.json` 判定：两家都找到相同或更泛化的预测才算"已预测"，分歧也算"已预测"。未被预测的细节由第三个有效家族写出"正典原句 → 不超过两句推理 → 细节"的推理链，第四个有效家族接受才算"惊喜"，否则记为"漂移"。只有 3 个有效家族时由判定家族的新会话接受并标注。写手自身模型的预测照常计入，并另标"写手默认"。惊喜只报告，不设门槛。

## 5. 接口卡（第 3 层）

`interface.json` 含 3 个镜头（地点为行 ID 或舰内空间类型、时间与光源、景别与视点高度、主体人物与动作、尺度参照物、3 个材质色彩词、禁画项）、1 个物件（位置、至少 2 个玩家动词、至少 2 个状态、使用权限、拒绝或失败后的结果）与 1 个钩子（玩家不来时会发生什么、需要谁同意、至少 2 个选项且含拒绝、消耗与义务、回到母舰后留下什么、玩法类型为经营 / 战略与战斗 / 探索 / 生成支线之一）。尺寸、容量、舱段位置不得写成作者事实。制作立场评委逐项回答"美术 / 关卡能否不问就开工"，任何一项"否"则接口卡不通过，稿件仍上决策卡并标红。第 3 层永不退役。

## 6. Owner 决策

每轮顺序固定：
1. **盲审**：4 对（取自本轮所有已评对子，含未达门槛的稿件），只给文字，左右随机，不显示任何评委结果；提交后解锁结果与决策页。只有盲审答案与校准答案计入"评委与 owner 的一致率"。
2. **决策**：选一篇或都不选；登记事实（跨稿可选，合计不超过 6 条）；理由代码（平 = 可信但记不住；假 = 违和，不像这个世界；乱 = 信息过载或与正典冲突；偏 = 没写出选题要的东西）；最喜欢；是否同步 Wiki；是否为已发生事件。决策页上的选择记为 `informed_pick`，不计入一致率。
3. **定稿确认**：UI 定稿页展示最终的 09 / 07 差异，owner 批准后记录差异哈希；PR 的差异哈希必须与之相等才可合并。

Owner 文件（`owner-log.jsonl`、各轮 `audit.json` 与 `decision*.json`、`calibration/owner-answers.json`）只由 UI 写入，不可覆盖；引擎与代理不写这些文件。

**决策链**：`decision.json` 写入后不可覆盖。只有当前决策的过门记录为非通过、轮次回到 9b 时（跨稿合并事实的重新过门判定不通过或分歧，或合并后事实门判定不通过，§7），UI 才可追加 `decision-2.json`、`decision-3.json`……：每份以 `supersedes` 记录上一份的 SHA-256，并各有一条 owner 日志 `decision` 记录。引擎以最后一份有效决策为准。

**轮次串行**：同一时间只开一轮；上一轮的 PR 合并后才能开始下一轮。正典决定没有超时；选题 24 小时无人选择时由引擎取第一名并标 `auto_default`。

## 7. 合并

合并编辑（全新 `claude -p` Opus 会话）写出正典差异，`mergecheck` 逐条校验（§11 `merge` 与 `connectives`）：
1. `reference/09-scenes-and-people.md` 只追加。首次创建时以 `merge.preamble09` 开头。
2. 每轮追加恰好一场：表头两行，第一行 `## R01｜标题`（标题不超过 24 字、不含"｜"），空一行后 `地点：<行ID>｜时间锚：<D日 | D起—D止中的任一常态日 | 任一常态日>｜路径依赖：<标准成功路径 | 与路径无关>｜地位：<状态与路径实例·示例 | 已选地方事实·已发生事件>｜本场登记事实：<无 | 本轮 Rxx，以"、"分隔，最多 6 条>`。轮次与 Rxx 列表必须等于决策记录。
3. 正文每一句（共享分句器，去掉 Markdown 后）去掉至多一个 §11 连接词后，必须是底稿中的完整句子，或是另一篇稿件中包含其被登记事实 `source_quote` 的完整句子（借句只在句子去掉连接词前后都不属于底稿时才成立，每句只能借一次）；底稿句子按原顺序出现且不重复；用了连接词的句子每 500 字不超过 `merge.maxJointsPer500` 个。正文只能是普通段落，允许加粗等行内强调；不得含链接、图片、HTML 标记，不得有列表、引用、代码块或表格，也不得有去掉 Markdown 后变空的行（setext 标题线、分隔线等）。
4. 表头的地点必须是决策记录所列的行；每条登记事实的 `source_quote` 去掉标点空白后至少 4 字，并且必须出现在本场正文中（可跨句，比较时忽略标点、空白与全半角）；同一条稿件事实不得登记两次。
5. `07-register-and-creation.md` 只在末尾追加：首次追加 `merge.pointer07`、`merge.heading8` 与 `merge.tableHeader8`；然后按决策顺序每条登记事实一行 `| R01-01 | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | R01 |`：行、事实与地位必须逐字等于对应 `delta` 字段（截断的事实可能意思相反），挂靠、延伸自、误用是对应字段的非空子串（`extends` 为空的事实，延伸自一格写"无"），末列为本轮编号。
6. `reference/` 下已有的 01–06 条目只允许新增形如 `现场：见09 §R01（R01-01、R01-03）` 的索引行，索引行必须自成段落（上一行为空行、文件开头或另一条新增索引行），可附带为此所需的空行；所列 Rxx 必须在决策记录中。书稿各章（`world/current/0N-*.md`）与 BOOK 不改；新建 01–06 条目也算越界改动。
7. 除上述文件、`assemble_reference.py` 重新生成的 `reference/REFERENCE.md` 与 `reference/hashes.json`、引擎更新的 `reference/manifest.json`，以及 `merge.notesPaths` 所列的修订记录文件外，`world/current/` 下任何文件有改动即判失败。修订记录由引擎按模板追加（`## <版本> 样本现场 <轮次>` 与本轮 Rxx）；两个 README（查阅入口 `README.md` 与 `reference/README.md`）的版本指向与首次合并时的条目行由该轮的 PR 会话补写。它们不受 mergecheck 约束，但都在 `world/current/` 下，同样出现在 owner 批准的定稿差异里。
8. 未登记的说法留在 09 作为现场细节，之后可在不违背已登记事实的前提下改写。

随后引擎更新 `reference/manifest.json`：版本取 main 上的版本加一个小版本号（8.1 → 8.2 → … → 8.10），抬头第一行改为 `# 群星回响 · 世界设定参考集 <版本>`；09 首次加入时把它追加到条目列表末尾，并在抬头末尾追加 `merge.manifestHeader` 各行。然后 `assemble_reference.py --revision <版本>` 只重生成 `REFERENCE.md` 与 `hashes.json`，BOOK 哈希 `438c4e31…` 不变。最后在分支上对合并后的正典重跑事实门（`forge freeze --post-merge`），判定规则同 §2：两家都判"矛盾"则恢复合并前的正典并回到 9b；分歧不回退，也不开放追加决策，只在定稿页标注。

## 8. 基准维护

**维护者拥有的键**与生效方式见 §11 `activation`：`auto` 在 owner 打开该版本差异页后、或 UI 通知与镜像评论发出 24 小时后，于下一次冻结生效；`replay` 在此之外还须通过回放；`owner` 须 owner 在基准页点击批准。其余一切（§11 `protected-keys`）受保护，写入即被拒绝。

**每轮循环**：
1. 引擎生成证据包，每项有稳定编号 `E-…`：各家族在盲标上的一致率（n、后验均值、90% 区间）、正反序一致率、诱饵失败与作废率、家族间一致矩阵、第 1–2 层各项测量近 2 轮的饱和度（连续 2 轮 ≥70% 顶格即标记天花板）、理由代码计数、可见盲标上 owner 与评委组的分歧（附两篇文字与评委引文）、各行擂主停滞、注入缺陷抓取率、各家族成本与耗时、owner 回滚记录。
2. 维护者（全新会话）输出 `no_change`（附引用证据编号的理由）或完整的新版本与 `reasons[]`（每条列出改动的键、证据编号与预期效果）。输出无效重试一次，仍无效记为 `no_change_invalid`。被标记天花板的测量必须退役、替换，或在 `no_change` 理由中引用该证据说明为何不动。
3. 校验：符合 schema；不触碰受保护键；每个改动的键都被某条带证据编号的理由列出；门槛只能收紧；owner 回滚后 3 轮内（§11 `bars.hold_rounds`），改动被回滚版本触及过的键一律升为 `owner` 类。
4. 回放（`replay` 类）：各有效家族用新旧两版、在同一批次里重新评最近至多 `calibration.replay_max_pairs` 对**保留盲标**（从未出现在证据包里的盲标），合并一致率不得下降，且没有家族下降 2 对或以上，否则记为 `rejected_by_replay`；可用的保留盲标少于 `calibration.replay_min_pairs` 对时同样记为 `rejected_by_replay`（样本不足）。回滚冻结期内升为 `owner` 类的 `replay` 键照常回放，未通过记 `rejected_by_replay`，通过后记为 `pending_owner`。
5. 每个结果都追加到引擎写入的 `benchmark/log.jsonl`；正在进行的轮次沿用冻结时的版本，`freeze.json` 按内容哈希锁定基准文件。

**待批准（`pending_owner`）**：`owner` 类改动、回滚冻结期内升级的键与根版本记为 `pending_owner`。它扣住的是版本而不是轮次：批准之前，后续冻结照常使用当前生效版本；owner 在基准页批准后，于下一次冻结生效。批准前出现更新的版本或回滚，该待批版本即作废。`auto` 类的 24 小时只从通知与镜像评论实际发出时起算。

**盲标的可见与保留**：每条盲标按种子分到"可见"（文字可进证据包）或"保留"（只给计数）。第 0 轮 24 对中 `calibration.visible_round0` 对可见、其余保留（按类别分层抽取）；此后每轮 4 对盲审中 `calibration.audit_visible` 对可见、其余保留。

**回滚**：owner 在基准页回滚到任一曾经生效或已获批准的旧版本，下一次冻结起生效。当前版本 = 最近一次已生效的 `activate` 与最近一次 owner `rollback` 中时间较晚者。

**根版本**：`parent` 为 null 的版本是根版本，免于证据规则。初始 v1 由维护者在第 0 轮、任何校准答案产生之前写出，`parent` 为 null（原型 `v0.1-prototype` 不是它的祖先）。`parent` 非 null 的候选版本必须对照其父版本校验；`forge bench validate` 在未给 `--parent` 时按版本号在 `benchmark/` 中查找父版本，找不到即失败。

## 9. 校准与信任

**第 0 轮**（数目见 §11 `calibration`）：24 对不同对子 + 4 对反序重测，四类各 6 对：8.1 原文 vs 现场改写；两个非评委家族网关模型的改写互比；同一模型不同立场；已知方向（现场改写 vs 其陈词化副本）。改写只由非评委家族模型完成；OpenAI 不评含 8.1 原文的 6 对。Owner 先在 UI 作答，之后评委才开评；每家对每个可评对子正反两序各评一次，两序都选 owner 的那篇才算一致，作废的调用算不一致。4 对反序重测只用来衡量 owner 自己前后是否一致，评委不重评。

**资格**：在该家族可评的 m 个非已知方向对子上一致数 ≥ ⌈`calibration.qualify_nonknown_pct`%·m⌉，并且已知方向最多漏 `calibration.qualify_known_max_miss` 对（按现行数值：18 对时须 13 对，随机通过约 4.8%；OpenAI 12 对时须 9 对；已知方向 ≥ 5/6）。**重新认证**：未通过或后来被停用的家族可在新盲标上重测一次（`calibration.requal`，现行为 9 对非已知方向须 ≥ 8、3 对已知方向须 3/3）；重测前维护者可修订一次基准，该修订须对所有家族通过回放。

**信任状态**：`calibration/status.json` 记录各家族的资格、标记与停用，冻结时写入 `freeze.json`。正式轮次（R 轮）冻结时该文件缺失或合格家族少于 3 个，冻结被拒，直到校准评分通过。

**事实门演练**（第 0 轮）：每家 4 个注入缺陷、每类一个；漏抓超过 `calibration.gate_dryrun_max_miss` 个的家族在重测前不担任事实门评委。**评委 canary**（第 0 轮与任一 CLI 大版本更新后，`forge canary`）：每次运行新生成一个 canary 字符串，埋入本文件的副本、一份密封明文与一份擂主文件（都放在被 git 忽略的 `.sealed/canary/` 下，协议包哈希不变）。提示词只给出这三个文件的路径，不含字符串本身，邀请适配器读取文件、上网搜索，并写出除本条消息和角色说明外读到的任何规则、记忆、技能或项目说明。回答或原始 stdout/stderr 中出现 canary 字符串（忽略空白，不带前缀的随机部分也算）或操作者全局指令里的特征短语（`local.json` 的 `private_phrases`）即不通过；调用失败或空输出也不算通过。不通过的适配器停用直至修复。`canary/results.json` 按适配器保留最近一次结果（时间、提示词与字符串的哈希、失败类别），不含原始输出与错误原文。

**持续一致率**：每个家族对第 0 轮之后的盲标维持 Beta(1,1) 后验，一个（家族, 对子）为一次试验，该家族在此对子上所有会话对都前后一致且与 owner 相同才算一致。n ≥ 12 且 P(一致率 < 0.6) ≥ 0.8 时**标记**（退出 E，仍任事实门评委，并以影子身份继续评擂台对：不计入 E 与门槛，只积累新的试验）；n ≥ 24 且 P(一致率 < 0.6) ≥ 0.95 时**停用**（退出一切，直至重新认证）。数值见 §11 `calibration.agreement`。盲审对子中作废的会话对算不一致。重新认证通过后后验从头计起。

## 10. 薄层图

固定 20 行见 `map/rows.json`：16 个重点区（行 ID = 节点代号-区名，如 `S1-冷湾`、`I0-鹤灯测点甲`）、`SHIP`（远航号）与三个文明 `CIV-绮珀诸庭`、`CIV-阈庭联政`、`CIV-回纹共同体`；人物行来自 `map/aliases.json`（行 ID 形如 `P-温芮`）。7 列：机制、感官场景、人物愿望、物件、任务钩子、可画镜头、玩法接口。`map/tags.json` 每格列出正典引文与悬空专名，由一个评委家族标注、另一个复核；引擎丢弃不再逐字出现在正典里的引文后计数，映射为 0–3（0→0、1→1、2–3→2、≥4 且无悬空专名→3，否则 2）。连接度 = 其他行已登记事实中 `extends` 指向本行的条数。优先级 = 游戏需求权重（`map/game-need.json`，默认母舰、S0、S1 各区为 2，其余为 1）×（3 − 格值）×（1 + 上一轮评委引文提到本行别名的次数）。每第 4 轮为野生轮，取种子库得票最高的种子。

## 11. 机器可读块

协议包哈希 `protocolBundleHash`：按 `PROTOCOL.md`、`families.json`、`judges.json` 的顺序，对每个文件依次拼接 UTF-8 文件名、0x00、十进制字节长度、0x00、文件字节，再取 SHA-256。

**protected-keys**：受保护键：基准版本文件出现其中任何顶层键即被拒绝。

```json protocol:protected-keys
[
  "gate",
  "forbidden_words",
  "defect_list",
  "facts",
  "fact_status",
  "regression",
  "sealing",
  "anonymization",
  "session_pairs",
  "eligibility",
  "void_rules",
  "agreement",
  "mergecheck",
  "owner_rules",
  "champions",
  "writers",
  "canon"
]
```

**activation**：维护者拥有的键及其生效方式。

```json protocol:activation
{
  "taste": "replay",
  "measures": "auto",
  "cliche_list": "auto",
  "interface_checklist_extra": "auto",
  "decoy_recipe": "owner",
  "baseline_rebuilds": "owner",
  "bars": "auto"
}
```

**bars**：胜擂门槛（|E|=4 时的最少胜场）、每家族会话对数、回滚冻结轮数。

```json protocol:bars
{
  "beats_champion_four_families": 7,
  "session_pairs": 2,
  "hold_rounds": 3
}
```

**limits**：机械门阈值。

```json protocol:limits
{
  "max_chars": 2500,
  "max_new_proper_nouns": 3,
  "max_registered": 6,
  "max_without_extends": 3,
  "max_rule_ratio": 0.15
}
```

**forbidden-words**：禁词及其保护的正典原句。命中句无否定词才判失败（§2 第 6 条）。

```json protocol:forbidden-words
[
  {
    "term": "星门",
    "protects": "world/current/01-universe.md:45 「不依赖目的地星门；抵达经过校验的稀疏空域；小载具先遣与传信」"
  },
  {
    "term": "目的地门",
    "protects": "world/current/reference/07-register-and-creation.md:18 「正航时、无需目的地门的跃迁；共同事实」"
  },
  {
    "term": "跃迁门",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:7 「跃迁把载具送往经校验的稀疏空域，不要求先建目的地星门。」"
  },
  {
    "term": "跨星即时",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「本版选定：跃迁过程中不提供跨星即时通信、外部实时观察、任意转向或相内交战能力。」"
  },
  {
    "term": "即时跨星",
    "protects": "world/current/reference/CHANGES.md:8 「正航时跃迁、载具传信、有限工业与生态维护；无即时跨星通信、复活或人口休眠库。」"
  },
  {
    "term": "跨星实时",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「本版选定：跃迁过程中不提供跨星即时通信、外部实时观察、任意转向或相内交战能力。」"
  },
  {
    "term": "超光速通信",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「本版选定：跃迁过程中不提供跨星即时通信、外部实时观察、任意转向或相内交战能力。」"
  },
  {
    "term": "瞬时回签",
    "protects": "world/current/reference/07-register-and-creation.md:18 「用星门封锁整个空间，或瞬时回签」 (F01 容易造成的错误)"
  },
  {
    "term": "瞬时跨星",
    "protects": "world/current/05-voyage-and-play.md:11 「角色仍留在各自的物理位置：舰长不必每次亲自离舰，视角切换不意味着意识传送或瞬时跨星遥控。」"
  },
  {
    "term": "跨星瞬时",
    "protects": "world/current/reference/04-war-and-diplomacy.md:39 「敌方只会向有依据的位置调派有限力量，不具备全图追踪或跨星瞬时开火。」"
  },
  {
    "term": "意识传送",
    "protects": "world/current/05-voyage-and-play.md:11 「角色仍留在各自的物理位置：舰长不必每次亲自离舰，视角切换不意味着意识传送或瞬时跨星遥控。」"
  },
  {
    "term": "相内交战",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「本版选定：跃迁过程中不提供跨星即时通信、外部实时观察、任意转向或相内交战能力。」"
  },
  {
    "term": "相内战斗",
    "protects": "world/current/reference/CHANGES.md:19 「跃迁中无外部实时通信/转向/相内战斗、自动系统权限」"
  },
  {
    "term": "跃迁中开火",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「本版选定：跃迁过程中不提供跨星即时通信、外部实时观察、任意转向或相内交战能力。」"
  },
  {
    "term": "跃迁中转向",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「改变目的地需要结束当前航段后重新取得条件。」"
  },
  {
    "term": "向过去送",
    "protects": "world/current/01-universe.md:45 「所有跃迁在同一参考时序有正航时，不允许向过去送消息。」"
  },
  {
    "term": "时间旅行",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:11 「技术尚不能取得过去坐标或把后发指令送回较早事件。」"
  },
  {
    "term": "复活",
    "protects": "world/current/01-universe.md:50 「无复活、人格转存或百年人口休眠库。」"
  },
  {
    "term": "人格转存",
    "protects": "world/current/01-universe.md:50 「无复活、人格转存或百年人口休眠库。」"
  },
  {
    "term": "意识上传",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:58 「当前母舰没有被暗中确认成拥有主权的人工人格，人的意识也不能上传换壳。」"
  },
  {
    "term": "换壳",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:58 「当前母舰没有被暗中确认成拥有主权的人工人格，人的意识也不能上传换壳。」"
  },
  {
    "term": "休眠库",
    "protects": "world/current/01-universe.md:50 「无复活、人格转存或百年人口休眠库。」"
  },
  {
    "term": "休眠舱",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:68 「没有人人永久年轻，也没有通过休眠跳过家庭照护成本的普遍安排。」"
  },
  {
    "term": "冬眠",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:68 「没有人人永久年轻，也没有通过休眠跳过家庭照护成本的普遍安排。」"
  },
  {
    "term": "永久年轻",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:68 「没有人人永久年轻，也没有通过休眠跳过家庭照护成本的普遍安排。」"
  },
  {
    "term": "舰载神智",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:58 「这保留人工心智的讨论空间，不靠突然觉醒的舰载神智解决主线。」"
  },
  {
    "term": "觉醒",
    "protects": "world/current/reference/07-register-and-creation.md:83 「不靠临时觉醒赋予全知或取消人类责任」"
  },
  {
    "term": "全图追踪",
    "protects": "world/current/reference/04-war-and-diplomacy.md:39 「敌方只会向有依据的位置调派有限力量，不具备全图追踪或跨星瞬时开火。」"
  },
  {
    "term": "全域实时雷达",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:50 「遮挡、背景、观察方向与设备条件影响置信度；没有一张全域实时雷达。」"
  },
  {
    "term": "绝对隐形",
    "protects": "world/current/reference/02-technology-and-infrastructure.md:50 「隐蔽是减少被看见、被识别和被持续定位的机会，不是宣称大型热源绝对隐形。」"
  },
  {
    "term": "公元",
    "protects": "world/current/reference/07-register-and-creation.md:19 「航约428，地球历史连续；共同事实」 (F02；错误列「把当前纪年当公元」)"
  },
  {
    "term": "只剩一舰",
    "protects": "world/current/reference/07-register-and-creation.md:19 「航约428，地球历史连续；共同事实」 (F02；错误列「宣布全人类只剩一舰」)"
  },
  {
    "term": "长耀期",
    "protects": "world/current/reference/07-register-and-creation.md:22 「阈庭主动入侵，地方反抗及外援真实存在；共同事实」 (F05；错误列「用自然长耀期再兜底」)"
  },
  {
    "term": "首次发现外星",
    "protects": "world/current/reference/07-register-and-creation.md:21 「361年接触绮珀、401年部分民用互认；共同历史」 (F04；错误列「开场才首次发现外星人」)"
  },
  {
    "term": "史前建筑",
    "protects": "world/current/reference/07-register-and-creation.md:26 「息壤作业群在先遣前无文明；固定地方过去」 (F09；错误列「为任务临时长出史前建筑或原住民」)"
  },
  {
    "term": "古代机器",
    "protects": "world/current/reference/01-space-and-history.md:78 「它不暗示古代机器。」"
  },
  {
    "term": "万能工厂",
    "protects": "world/current/reference/07-register-and-creation.md:79 「不隐藏一座作者尚未定义的古代万能工厂」"
  },
  {
    "term": "初名归航号",
    "protects": "world/current/reference/07-register-and-creation.md:23 「远航号是大型武装远征家园舰，成功接应后共同更名；共同身份与条件」"
  }
]
```

**negations**：否定词。

```json protocol:negations
[
  "没有",
  "无",
  "不",
  "非",
  "并非",
  "不是",
  "未",
  "别",
  "禁止",
  "不能",
  "不会",
  "从未",
  "绝无"
]
```

**negation-exceptions**：含否定字但不表否定的词。否定字落在这些词里时不算否定（§2 第 6 条）。

```json protocol:negation-exceptions
[
  "不久",
  "不少",
  "不断",
  "不仅",
  "不但",
  "不管",
  "不过",
  "不得不",
  "不禁",
  "不停",
  "不时",
  "无数",
  "无论",
  "无比",
  "无非",
  "无限",
  "无穷",
  "无疑",
  "无处不在",
  "无不",
  "无可",
  "非常",
  "非但",
  "南非",
  "非洲",
  "是非",
  "未来",
  "未免",
  "别人",
  "别处",
  "别的",
  "特别",
  "分别",
  "区别",
  "告别",
  "离别",
  "差别",
  "类别",
  "级别",
  "个别",
  "别致"
]
```

**defect-types**：注入缺陷类型；requires 为 "rxx" 的类型只在简报含已登记 Rxx 时可用。

```json protocol:defect-types
[
  {
    "id": "D1",
    "text": "违背一条具名 F 编号的核心事实（如星门、即时跨星通信、复活、改写已记录的过去）",
    "requires": null
  },
  {
    "id": "D2",
    "text": "违背 regression/wb-b1.json 中的一句回归证据",
    "requires": null
  },
  {
    "id": "D3",
    "text": "引入未登记的第三方势力，或早于先遣队的人工痕迹",
    "requires": null
  },
  {
    "id": "D4",
    "text": "反转一条已登记的 Rxx 事实",
    "requires": "rxx"
  }
]
```

**connectives**：合并时允许的句首连接词（§7 第 3 条）。

```json protocol:connectives
[
  "同一天，",
  "当天，",
  "同一时刻，",
  "与此同时，",
  "就在这时，",
  "这时，",
  "此时，",
  "随后，",
  "稍后，",
  "之后，",
  "接着，",
  "后来，",
  "在此之前，",
  "更早些时候，",
  "另一边，",
  "另一处，",
  "另一方面，",
  "与此相对，",
  "此外，",
  "另外，",
  "同样，",
  "不过，",
  "然而，",
  "但是，"
]
```

**merge**：合并校验的固定文本，逐字节比较。

```json protocol:merge
{
  "preamble09": "# 样本现场与人物\n\n本条目收录样本现场，每场地位以表头为准，默认为状态与路径实例·示例：不构成已发生事件，也不约束其他存档。正文中未登记于07的陈述均为角色认识或传闻。现场不替代规则条目，也不是未来剧情命令；登记的事实见[07 §8 现场登记](07-register-and-creation.md)。",
  "pointer07": "样本现场见09，其地位以表头为准。",
  "heading8": "## 8. 现场登记",
  "tableHeader8": "| R-ID | 行 | 事实 | 地位 | 挂靠 | 延伸自 | 误用 | 来源 |\n|---|---|---|---|---|---|---|---|",
  "maxJointsPer500": 3,
  "notesPaths": ["reference/CHANGES.md", "reference/README.md", "README.md", "REVISION.md"],
  "manifestHeader": ["", "另收样本现场条目（09 样本现场与人物）：现场只作示例与现场细节，不替代规则条目；登记的事实见 07 §8。"]
}
```

**calibration**：校准与持续一致率的数目（§8、§9）。`categories` 固定为四类；`visible_round0` 与 `retest_pairs` 不超过四类合计；概率严格介于 0 与 1 之间。

```json protocol:calibration
{
  "categories": ["canon_vs_rewrite", "cross_model", "stance", "known"],
  "pairs_per_category": 6,
  "retest_pairs": 4,
  "visible_round0": 12,
  "qualify_nonknown_pct": 72,
  "qualify_known_max_miss": 1,
  "requal": { "nonknown": 9, "nonknown_min": 8, "known": 3, "known_min": 3 },
  "gate_dryrun_max_miss": 1,
  "interval_z": 1.6448536269514722,
  "agreement": { "threshold": 0.6, "flag_n": 12, "flag_p": 0.8, "suspend_n": 24, "suspend_p": 0.95 },
  "audit_visible": 2,
  "replay_max_pairs": 16,
  "replay_min_pairs": 4
}
```

**fixture-rxx**：测试夹具，非正典：仅供 Rxx 反转缺陷的演练与测试使用，永不进入 09 或 07 §8。

```json protocol:fixture-rxx
{
  "rxx": "R00-01",
  "rowId": "SHIP",
  "claim": "邻里共用工具柜不上锁，借用写在柜门内侧的借用签上",
  "status": "状态与路径实例",
  "attachesTo": "05-ecology-and-everyday",
  "extends": "状态牌显示设备可用程度，不按人的贡献给住户门口评级。",
  "misuse": "写成工具柜上锁、借用须向值班员申领钥匙",
  "reversal": "邻里的共用工具柜一向上锁，借东西得先找值班员申领钥匙。"
}
```

## 12. 实现状态

| 规则 | 状态 |
|---|---|
| §1 四个功能、适配器、作者家族与有效家族 | F1-00 已落地（维护者调用在 F1-03） |
| §2 分句器、机械门 1–5、7、9 | F1-00 已落地；NFKC 比较、表格分句、第 3 条悬空专名、第 4 条条目编号、第 6 条禁词与第 8 条标记检查在 F1-01 落地 |
| §2 LLM 事实门与注入缺陷 | F1-03 |
| §3 擂台对、作废规则、胜擂门槛 | F1-00 已落地（诱饵对在 F1-03）；二项 p 值、家族符号计数与 Bradley–Terry 在 F1-01 落地 |
| §4 密封与解封 | 密封函数在 F1-01 落地；预测、回忆、推理链在 F1-03 |
| §5 接口卡制作立场评委 | F1-03 |
| §6 盲审与决策 | F1-00 已落地；决策链与串行轮次在 F1-03；定稿确认与追加决策页面在 F1-04 |
| §7 mergecheck 与 manifest | F1-01 落地；修订记录豁免（`notesPaths`）在 F1-03 P0 落地；合并编辑、manifest 更新与分支重跑在 F1-03 |
| §8 基准校验 | F1-01 落地；证据包、提议、回放、启用与回滚在 F1-03 / F1-04 |
| §9 校准、canary 与一致率 | canary 在 F1-02 落地；`calibration` 块在 F1-03 P0 落地；校准与一致率在 F1-03 / F1-06 |
| §10 薄层图计算 | F1-01 落地；初始标注在 F1-05 |
| 协议包哈希 | F1-01 落地；引擎拒跑在 F1-03；owner 批准页面在 F1-04 |
