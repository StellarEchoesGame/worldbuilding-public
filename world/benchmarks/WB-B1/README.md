# WB-B1：世界观 benchmark

任务：[worldbuilding #32](https://github.com/StellarEchoesGame/worldbuilding/issues/32)。对象为 reference 8.1 与 revision 8 BOOK；本目录是评测快照和证据，不是另一份现行正典。

先读 [协议](PROTOCOL.md)，再读本轮 [结果](REPORT.md)。题库分 [公开题](questions/public.json) 与 [独立新题](questions/fresh.json)。输入身份见 [清单](input-manifest.json)，评分前冻结记录见 [freeze.json](freeze.json)。

评分不是自动完成：两个无继承上下文审读者分别保存完整回答和证据，程序仅核验哈希、题目覆盖、引用与算术。运行 `python3 score.py` 可复算既有原始结果，不会调用模型，也不重新证明主观判断。

新增版本需保存新的输入清单及run，保留失败；新题一经公开就成为回归题，不继续称为未见题。真实读者的吸引力和游戏体验另测。
