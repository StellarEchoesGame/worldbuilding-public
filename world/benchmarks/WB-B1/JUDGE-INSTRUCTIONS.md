# 评分执行指令

你是未参与原文写作的独立评分者。只读取本包 PROTOCOL.md、input-manifest.json、input 中的正文、questions/public.json、questions/fresh.json、questions/controls.json。不要读取 method/control-key.json、方法审读、其他评委输出、旧审读或聊天。不要联网、改源文或外部发布。

完整读 BOOK 与八份 reference；六份基础章节与 BOOK 内容重复，按引用定位即可。8.1参考中明确选定的S6/S7局部机制补充旧基线中的未选题；不能把正常版本扩展误判同版矛盾，亦不能默默替真正冲突和解。每题由原文作答，可条件推导，但不得将你临场发明的规则、观察细节或人物动机当作原文优点。必须区分未知与作者已宣称成立却没有支持的跳步。

按24题逐题评分，读取先后自选。另一评委不可见。无预期总分，不为奖励作者调分；题目、控制题和硬门槛都需完成。D4—D6逐题写吸引力的具体文本证据与最强的不吸引理由，缺少本维3分证据时最高2分。无需追求分数方差，4分需要额外的文本证据，2分不是指作品无价值。证据用简短连续原文，必须能在 source 文件中逐字找到；同一引文重复贴到所有题不算实质证据。

交付 JSON 到给定 runs/initial/judge-X.json，结构：
```json
{
  "judge_id": "judge-X",
  "input_manifest_sha256": "读取文件的sha256",
  "protocol_sha256": "读取协议的sha256",
  "cases": [{"id":"P01","dimension":"D1","score":3,"answer":"对问题的具体回答","evidence":[{"source":"input/BOOK.md","section":"具体小节","quote":"连续原文短引"}],"counterevidence":"最强反证、缺失或不能进一步声称的内容","inference_boundary":"哪些原文/推导/新假设；没新增也说明"}],
  "controls": [{"id":"C01","score":0,"answer":"理由"}],
  "gates": {"H1":{"status":"pass|fail|unresolved","reason":"具体原因","evidence":[{"source":"input/BOOK.md","section":"小节","quote":"原文"}]},"H2":{},"H3":{},"H4":{}},
  "strengths": ["主要长处"],
  "defects": [{"id":"A-01","severity":"critical|major|minor","problem":"实际缺陷","evidence":[{"source":"input/BOOK.md","section":"小节","quote":"原文"}],"affected_cases":["P01"],"minimal_fix":"最小修订方向；不写源文"}]
}
```

所有24题（P01—P16、N01—N08）、4控制题、4硬门槛必须齐全。score均为0—4整数。不存在的缺陷不用凑数。你的全部JSON是原始成绩，不由根补写。完成后简短报告所写路径和最强发现，不讨论另一评委。
