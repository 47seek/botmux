# 现有消息的写前检查

机器人配置可以显式设置 `topicUnavailablePolicy: "stop"`。未配置或使用 `"legacy"` 时沿用已有行为，不增加消息状态查询。此策略属于共享飞书客户端的可选能力；不会创建其他群或话题，不修改身份、角色或权限。

reply、整卡 PATCH、forward、urgent、新增表情/置顶和 CardKit 写入会在调用前读取精确消息；若消息属于话题，还读取它的根。必须明确读到匹配 ID 且 `deleted: false`。确认撤回返回 `TOPIC_SEND_BLOCKED`；缺失、重复、状态未知或查询失败返回 `TOPIC_SEND_CHECK_FAILED`。API gate 内的重试会重新查询；删除已有表情/置顶属于清理操作，仍可执行。Pin 维持原来的未确认返回 null 语义。

原消息检查不与远端写入组成原子事务。支持撤回错误码的接口会把写入期间的撤回归为停止错误；不能据此宣称 exactly-once 或自动替换目标。原始错误和确认结果由调用者继续处理。

CardKit 的 cardId 不能证明消息归属。已有 CardStreamStore 在原锁内将其已持久化的 messageId 随 sequence lease 传到 CLI/daemon transport；没有新增数据格式、索引、UUID 或独立调度器。直接调用 CardKit 写接口的调用者必须提供真实 messageId；stop 下缺少证据会拒绝。

`sendMessage` 和 `replyMessage` 的现有 `OutboundMessageOptions` 可接收 `beforeWrite` 回调。它在实际 provider 尝试前执行，失败后不会触发发送后的 outbound hook。回调属于调用者提供的可信上下文，不能来自消息正文。它位于 options 参数：sendMessage 第 7 参数，replyMessage 第 8 参数；hookContext 是另一参数。

此改动只覆盖共享客户端及消息 lease 传递。新建顶层消息没有可从目标反推的原话题，调用者必须自行冻结来源，并通过 beforeWrite 核验；本改动不自动补全所有 CLI、workflow、CoT 或会话业务来源。上层自动回退、独立原生 SDK 路线及恢复语义需要各自的调用方改动和回归，不能以此 PR 代替全出站验证。

Native CoT creation checks its frozen message origin; append, completion and orphan recovery check the existing bubble and root. A policy refusal retains the original recovery marker and never redirects the bubble. Explicit unthreaded origins remain unthreaded. This does not add managed-Ask retirement or business visibility rules.
