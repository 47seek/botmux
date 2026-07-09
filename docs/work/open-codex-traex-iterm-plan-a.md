# 飞书按钮打开 Codex / TRAE 到 iTerm 调研方案 A

日期：2026-07-09
范围：只读调研 botmux 当前代码链路；本文件是唯一产出，不改产品代码。

> 归档说明：本文件是规划阶段子 agent A 的独立研究稿，不是最终实现规格。最终采用方案、v1 边界和实际 action 名以 `docs/work/open-codex-traex-iterm-best-strategy.md` 为准；本文中 `open_local_terminal`、closed/persisted session、managed tmux 等建议如与最终策略冲突，均视为研究备选。

## 结论摘要

- 当前 checkout 里没有搜到显式的“打开 Codex”“打开 TRAE/traex”按钮、`codex://` / `trae://` / `traex://` URL scheme、`open -a`、`osascript` 或本地 App deeplink 实现。
- 当前飞书卡片里的终端入口是通用“打开终端”：通过 `multi_url` 打开 Web Terminal URL；可选用飞书 `web_url/open` 包一层，让 PC 侧栏打开。
- `/adopt` 当前已支持 Codex 和 TRAE 的 live session 发现与接入，TRAE 识别为 `traex`，会从 `~/.trae/cli/sessions/...` 解析会话 id；Codex 从 `~/.codex/...` 解析。
- 如果要实现“从飞书按钮把本机 Codex / TRAE 会话打开到 iTerm”，不建议继续走 CLI/App 专属 URL scheme。推荐新增一个通用飞书回调动作 `open_local_terminal`，服务端校验 operator 权限后，在 daemon 所在 macOS 机器上用 AppleScript 打开 iTerm 并执行 `tmux attach` 或 CLI resume 命令。
- “打开 traex 会打开 Trae terminal”大概率来自外部分支/旧实现里的 CLI 专属 launcher 映射，当前仓没有该逻辑。修复方向应把“终端 App”选择从 `cliId` 解耦：`cliId=traex` 只决定会话/命令，终端承载固定走 iTerm。
- “打开 codex 点不动”大概率是因为依赖了不存在或未注册的 Codex URL scheme，或飞书卡片动作没有对应后端 handler。用统一 callback action 可以同时解决 Codex/traex 分叉。

## 现状链路

1. 飞书卡片按钮生成

- `src/im/lark/card-builder.ts:215` 的 `sidebarUrl()` 会生成 `https://applink.feishu.cn/client/web_url/open?...&url=<terminalUrl>`。
- `src/im/lark/card-builder.ts:246` 的 `terminalMultiUrl()` 根据全局配置决定直接打开 Web Terminal，还是在飞书 PC 侧栏打开。
- `src/im/lark/card-builder.ts:258` 的 `buildSessionCard()` 首个按钮是 `card.btn.open_terminal` / `card.btn.open_writable_terminal`，只带 `multi_url`，没有 callback。
- `src/im/lark/card-builder.ts:663` 的 `buildStreamingCard()` 同样把“打开终端”渲染成 `multi_url: terminalMultiUrl(terminalUrl)`。
- `src/im/lark/card-builder.ts:1806` 的 `buildAdoptSelectCard()` 只渲染 live/resume 下拉选择，不生成“打开 Codex/traex”按钮。

2. URL 生成

- `src/core/terminal-url.ts:67` 的 `buildTerminalUrl()` 是当前唯一会话终端 URL 生成入口。
- proxy ready 时 URL 为 `http://<externalHost>:<advertisedPort>/s/<sessionId>`；远程访问开启时可变成平台机器域名 `/s/<sessionId>`；写权限通过 `?token=<workerToken>` 或平台角色控制。

3. 后端处理

- 普通“打开终端”是 `multi_url`，飞书客户端直接打开 URL，`card-handler.ts` 不参与。
- `get_write_link`、`close`、`takeover`、`disconnect` 等动作走 `card-handler.ts` callback，并可拿到 Lark verified `operator.open_id` 做权限判断。
- daemon dashboard IPC 已有 `GET /api/sessions/:sessionId/write-link`，用于按需返回写权限 Web Terminal URL；该路径用 loopback HMAC 保护。

4. adopt / 终端观察逻辑

- `/adopt` 在 `src/core/command-handler.ts:1815` 处理，先发现 tmux 和 zellij session，再构造选择卡。
- `src/core/session-discovery.ts:42` 把进程名 `codex` 映射到 `cliId=codex`，`traex` 映射到 `cliId=traex`。
- `src/core/session-discovery.ts:701` 通过 Codex rollout fd 发现 Codex session id；`src/core/session-discovery.ts:715` 用 TRAE 专用路径查 `~/.trae/cli/sessions/...`。
- 选择 adopt 后，`src/core/command-handler.ts:2865` 校验目标，`src/core/command-handler.ts:2880` 写入 `ds.adoptedFrom`，`src/core/command-handler.ts:2900` fork adopt worker。
- worker adopt 分支在 `src/worker.ts:3858` 开始。tmux/zellij adopt 走 `src/worker.ts:3903`，使用 `TmuxPipeBackend` 或 `ZellijObserveBackend`，不是旧的 `tmux attach-session`。
- `src/adapters/backend/tmux-pipe-backend.ts:1` 明确说明当前 tmux adopt 使用 `pipe-pane`，避免 `tmux attach-session` 与 iTerm2 control mode 冲突。

5. CLI resume 能力

- `CliAdapter.buildResumeCommand` 定义在 `src/adapters/cli/types.ts:100`，用于生成用户可复制到本地终端的 resume 命令。
- Codex adapter 在 `src/adapters/cli/codex.ts:155` 生成 `codex resume <sid>`。
- TRAE adapter 在 `src/adapters/cli/traex.ts:170` 生成 `traex resume <sid>`。
- closed session card 已复用这个能力，见 `src/core/closed-session-card.ts:24`。

## 问题假设

- 现象里的“打开 traex”不是当前 `buildStreamingCard()` 的通用 Web terminal 按钮，而是某个待合入/旧分支中的本地 launcher 按钮；当前仓未包含该实现。
- 该旧实现可能按 `cliId` 选择目标 App：`traex` 误选 Trae 终端，导致用户想进 iTerm 却打开 Trae terminal。
- Codex 不动可能是因为 Codex 没有可用的桌面 URL scheme，或卡片 button value 没接入 `card-handler.ts` 的 action 分发。
- 飞书 `multi_url` 只能让客户端打开 URL，不能直接在 daemon 机器上执行 `open -a iTerm`。如果要从按钮启动本机 iTerm，必须走 callback 或一个会执行服务端动作的 HTTP endpoint。

## 推荐修复策略

### 方案 A：新增飞书 callback 动作，服务端打开 iTerm

这是推荐方案，原因是可以复用飞书 callback 的 operator 身份，避免把“启动本机终端”的能力暴露成群里任何人都能点的裸 URL。

改动点：

- 在 `card-builder.ts` 的 streaming/session card 中，对 `cliId === 'codex' || cliId === 'traex'` 增加一个按钮，文案可为“打开 iTerm”或沿用产品文案“打开 Codex / 打开 TRAE”，但 action 统一为：
  - `value: { action: 'open_local_terminal', session_id, root_id, cli_id, terminal_app: 'iterm' }`
- 在 `card-handler.ts` 的敏感 action 集合加入 `open_local_terminal`，沿用 `canOperate()` 权限门。
- 新增小模块，例如 `src/services/local-terminal-launcher.ts`：
  - `buildTmuxAttachCommand(ds)`：优先 attach live tmux pane/session。
  - `buildResumeCommand(ds)`：无 live pane 时，复用 adapter `buildResumeCommand()`，在 `workingDir` 下执行 `codex resume <sid>` 或 `traex resume <sid>`。
  - `openInIterm(command, cwd)`：macOS 上用 `/usr/bin/osascript` 控制 iTerm 打开新 window/tab 并执行命令。
- 对非 macOS、无 iTerm、无 tmux target、无 cliSessionId 的情况返回 toast，不要静默失败。

执行命令优先级：

1. Adopted tmux session：打开 iTerm 执行 `tmux attach-session -t <session> ; select-window ; select-pane`，目标来自 `ds.adoptedFrom.tmuxTarget`。
2. Botmux 管理的 tmux session：打开 iTerm 执行 `tmux attach-session -t bmx-<sessionId>`。
3. 没有 live tmux，但有 CLI-native session id：打开 iTerm，在 `workingDir` 下执行 `codex resume <sid>` 或 `traex resume <sid>`。
4. zellij/herdr：第一版可 toast “暂不支持 iTerm 直连，请使用 Web Terminal”，避免把复杂面扩大。

关键约束：

- 终端 App 由配置/按钮固定为 iTerm，不由 `cliId` 推导。
- `cliId` 只决定 attach/resume 的 CLI 命令。
- 不替换现有“打开终端”Web Terminal 按钮，新增本地 iTerm 按钮更稳，回滚简单。

### 备选方案 B：URL endpoint 执行启动动作

可以新增 `GET /api/sessions/:sessionId/open-local-terminal?...`，按钮用 `multi_url` 打开该 URL，服务端执行后返回一个 HTML 成功页。

不推荐作为第一版：

- `multi_url` 点击时没有可靠 operator 身份，难以复用 `canOperate()`。
- 如果 URL 出现在群卡片里，任何可见成员都可能触发 daemon 机器打开本地终端。
- 需要额外一次性 token 或 owner-only 私聊卡才能安全化，复杂度比 callback 高。

## 涉及文件

建议第一版涉及：

- `src/im/lark/card-builder.ts`：新增按钮生成；不要改变现有 Web Terminal `multi_url`。
- `src/im/lark/card-handler.ts`：新增 `open_local_terminal` action 分支和权限门。
- `src/services/local-terminal-launcher.ts`：新增 iTerm launcher 和命令构造。
- `src/adapters/cli/types.ts` / `codex.ts` / `traex.ts`：不需要改接口；复用已有 `buildResumeCommand()`。
- `test/card-builder.test.ts`：断言 Codex/traex 卡出现本地 iTerm 按钮，其他 CLI 不出现或按产品要求隐藏。
- `test/card-handler*.test.ts` 或新增 `test/local-terminal-launcher.test.ts`：覆盖 action 分发、权限、命令构造、错误 toast。

暂不建议碰：

- `src/core/terminal-url.ts`：它只负责 Web Terminal URL，不应混入本地 App 启动。
- `src/core/terminal-proxy.ts` / worker Web server：现有职责是 Web Terminal HTTP/WS 代理，不适合承载本地 app 启动语义。
- `TmuxBackend.attachToExisting()`：旧 attach 路径不是当前 adopt 主链路，且已经被 `TmuxPipeBackend` 规避。

## 测试方案

单测：

- card-builder：
  - Codex streaming card 包含 `open_local_terminal` 按钮，value 带 `session_id/root_id/cli_id`。
  - traex streaming card 同样包含按钮，但文案/terminal_app 指向 iTerm，不出现 Trae terminal 字样。
  - 原 Web Terminal `multi_url` 保持不变。
- local-terminal-launcher：
  - adopted tmux target `work:2.0` 生成 attach/select pane 命令，参数 shell escape。
  - managed tmux session 生成 `tmux attach-session -t bmx-<sessionId>`。
  - Codex fallback 复用 `codex resume <sid>`；TRAE fallback 复用 `traex resume <sid>`。
  - 非 darwin / iTerm 不存在 / 缺 session id 返回可读错误。
- card-handler：
  - 非 operator 点击被拒绝。
  - operator 点击调用 launcher 并返回 success toast。
  - launcher 报错时返回 error toast，不删除/更新原卡。

手测：

1. 在 iTerm tmux pane 中分别运行 `codex` 和 `traex`，飞书发 `/adopt`，选择对应 session。
2. 点击流式卡片上的“打开 iTerm/打开 Codex/打开 TRAE”。
3. 期望 iTerm 被激活并进入对应 tmux pane/session；TRAE 不再打开 Trae terminal。
4. Codex 按钮点击后应有 toast，且 iTerm 有实际动作；失败时 toast 给出原因。
5. 回归现有“打开终端”按钮仍打开 Web Terminal，`获取操作链接` 仍返回写权限 Web Terminal。

## 风险与注意事项

- 远程/移动点击：callback 会在 daemon 所在机器上打开 iTerm，而不是在点击者设备打开。文案要避免误解。
- 权限：本地终端启动是 operate 级能力，不能做成群可见裸 URL；必须走 `canOperate()` 或 owner-only 私聊卡。
- macOS 依赖：iTerm AppleScript 只在 macOS + 已安装 iTerm 时可用，其他平台应清晰降级。
- tmux target 精确性：`session:window.pane` attach 后需要 select window/pane，否则可能只进 session 当前 pane。
- zellij/herdr：当前 adopt 支持它们，但 iTerm 直连第一版不应扩大到这两类，避免引入新 attach 语义。
- URL scheme 不稳定：Codex/Trae 桌面 URL scheme 不在当前仓内，不应作为修复基础。
- 安全：不要把 worker write token 写进本地 launch 命令；attach 到 tmux 已经是本机操作，Web Terminal 写权限仍由原 token 体系控制。
