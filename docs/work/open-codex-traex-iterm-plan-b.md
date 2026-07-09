# 打开 Codex / TRAE 按钮适配 iTerm 方案 - 子 Agent B

> 归档说明：本文件是规划阶段子 agent B 的独立研究稿，不是最终实现规格。最终采用方案、v1 边界和实际 action 名以 `docs/work/open-codex-traex-iterm-best-strategy.md` 为准；本文中携带 `cwd/cli_session_id`、closed-session 按钮、persisted session 读取等建议如与最终策略冲突，均视为研究备选。

## 结论

推荐把“打开 Codex / 打开 TRAE”做成 **飞书卡片 callback action，由 botmux daemon 在本机执行 iTerm AppleScript**，不要继续依赖 `codex://`、`trae://` 或 Trae 自己的 URL scheme。

原因：

- 当前仓库没有已有的 iTerm / Terminal.app / `osascript` helper，也没有 `codex://`、`traex://` deep link 入口。
- 现有“打开终端”按钮是 `multi_url` URL 按钮，只会打开 botmux Web Terminal；不会进入 `card-handler`。
- `trae://` 类 URL 容易被 Trae 客户端接管，所以“打开 traex”会进入 Trae terminal，而不是 iTerm。
- Codex 没有可用的本地 URL scheme；如果按钮用了不存在的 scheme，“打开 codex”在飞书里看起来就是点不动。
- callback action 能使用飞书回调里可信的 `operator.open_id` 做权限校验，也不会把“在本机执行命令”的能力暴露成公开 GET URL。

## 已读代码事实

- 飞书卡片按钮构建集中在 `src/im/lark/card-builder.ts`。
- 现有终端按钮走 `terminalMultiUrl()`，默认直连 Web Terminal URL；开启 `openTerminalInFeishu` 后包一层 `https://applink.feishu.cn/client/web_url/open?...`，PC 在飞书侧栏打开。对应代码在 `card-builder.ts:215`、`card-builder.ts:247`、`card-builder.ts:715`、`card-builder.ts:881`。
- session dashboard 的终端按钮也是 `multi_url`，并明确注释为“no callback”，见 `src/im/lark/sessions-card.ts:440`。
- Web Terminal URL 由 `src/core/terminal-url.ts:67` 构建；proxy 模式下是 `http://<host>:<proxyPort>/s/<sessionId>`。
- terminal proxy 只代理 `/s/<sessionId>` 到 worker xterm 服务，见 `src/core/terminal-proxy.ts:47` 和 `src/core/terminal-proxy.ts:71`。
- `card-handler.ts` 负责飞书 callback action 分发；敏感操作目前包括 `restart`、`close`、`get_write_link`、`term_action` 等，但没有“打开本地 CLI / iTerm”的 action。
- Codex adapter 已能生成本地恢复命令：`codex resume <sid>`，见 `src/adapters/cli/codex.ts:155`。
- TRAE adapter 已能生成本地恢复命令：`traex resume <sid>`，见 `src/adapters/cli/traex.ts:170`。
- `/adopt` 的历史会话导入会解析 Codex/TRAE rollout 中的 `cliSessionId` 和 `cwd`，见 `src/services/resumable-session-discovery.ts:258`。

## 推荐实现

新增一个小模块，例如 `src/core/local-cli-opener.ts`：

- 输入结构只接受结构化字段：`cliId`、`cwd`、`cliSessionId`、可选 `model/wrapperCli`。
- 只允许白名单 CLI：先支持 `codex` 和 `traex`。
- 使用已有 adapter 的 `buildResumeCommand()` 生成命令，或对 `/adopt` 的外部历史会话直接拼同语义命令。
- 用统一 shell quote 生成：`cd <quoted cwd> && <resume command>`。
- macOS 优先执行 iTerm AppleScript：激活 iTerm，新建 window/tab，`write text "<command>"`。
- iTerm 不存在或 AppleScript 失败时，返回 toast，提示用户复制卡片里的命令；不要自动落到 Trae terminal。

卡片侧：

- 在产生“打开 Codex / 打开 TRAE”的卡片处使用 callback button：
  - `value: { action: 'open_local_cli', cli_id, session_id, cli_session_id, cwd, root_id }`
  - 不要使用 `multi_url`，不要使用 `trae://` 或 `codex://`。
- 如果该按钮来自 session closed card，可在 `buildSessionClosedCard()` 中在已有“恢复会话”旁加“打开 Codex/打开 TRAE”，仅当 `cliResumeCommand` 和 `workingDir` 都存在时显示。
- 如果该按钮来自 `/adopt` 历史会话列表，建议先不在 select option 里做按钮，而是在选择后返回一个确认/启动卡，避免把 cwd/sessionId 塞进不可审计的 URL。

handler 侧：

- 在 `src/im/lark/card-handler.ts` 中加入 `open_local_cli` 分支，并纳入 sensitive action。
- 复用现有 operator / allowedUsers 校验；对带 `session_id` 的卡片继续走 `getSessionByActionValue()` 和 CLI 绑定校验。
- 对已关闭 session，可从 `sessionStore` 取 `workingDir`、`cliId`、`cliSessionId` 后再生成命令，避免完全信任 card value。
- 成功返回 toast：`已在 iTerm 打开 Codex/TRAE`。
- 失败返回 toast：`未能打开 iTerm，可复制下方命令手动执行`。

## 备选方案

备选 A：HTTP opener URL，例如 `http://127.0.0.1:<proxyPort>/open-cli/<token>`。

- 优点：仍可用 `multi_url`，不占用 card callback。
- 缺点：GET 触发本地命令副作用，权限弱；群里可见 URL 容易被重放；还要处理 token TTL/一次性消费/跨 bot 端口。安全性差于 callback。

备选 B：继续用客户端 URL scheme。

- 优点：实现最少。
- 缺点：正是当前问题来源。TRAE scheme 会打开 Trae terminal；Codex 没稳定 scheme，按钮点不动。不可推荐。

## 测试与验收

- 单测 `local-cli-opener`：`codex` 生成 `cd <cwd> && codex resume <sid>`；`traex` 生成 `cd <cwd> && traex resume <sid>`；cwd 含空格/引号时正确 quote。
- 单测 `card-builder`：打开本地 CLI 按钮使用 `value.action='open_local_cli'`，没有 `multi_url`，没有 `trae://` / `codex://`。
- 单测 `card-handler`：非 allowed user 被拒；CLI mismatch 被拒；closed session 从 store 取真实 `cwd/cliSessionId`。
- macOS 手动验收：
  - 点击“打开 TRAE”后 iTerm 新窗口执行 `traex resume <uuid>`，不能打开 Trae terminal。
  - 点击“打开 Codex”后 iTerm 新窗口执行 `codex resume <uuid>`，不能无响应。
  - 未安装 iTerm 时返回明确 toast，不误打开 Trae。

## 风险与边界

- 该能力只能打开 daemon 所在机器的 iTerm。若 botmux 跑在远端 DevBox，点击者本机不会被打开；这种场景应隐藏按钮或只展示复制命令。
- 不建议把完整 shell 命令放进 URL query 或完全信任 card value；应从 session store / adapter 重新生成。
- “打开终端”现有 Web Terminal 行为不应改名或复用；本地 iTerm 按钮应是独立的“打开 Codex / 打开 TRAE”。
