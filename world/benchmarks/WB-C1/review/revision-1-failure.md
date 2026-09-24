# 修订调用 1 未交付正文

响应 `stop_reason=max_tokens`，返回正文为空。CLI 的 `is_error=false` / `subtype=success` 仅表示客户端结束，不能证明任务完成。协调脚本已将本次状态记为 failure。元数据记录 22004 输出 tokens，其中 22000 thinking tokens；不保存或展示内部推理正文。

保留所有原始响应，不覆盖重跑。修订调用 2 使用同一已确认 Claude SKU，任务级 effort 从 high 改为 medium，输出额度从 22000 调整到 32000，压缩篇幅目标，其余工具隔离保持不变。没有修改全局配置。此为针对已知 max_tokens 失败的一次调整重试，不是超时未知结果的重复下单。
