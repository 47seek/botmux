# 打开 Codex / TRAE 按钮适配 iTerm 最佳策略

日期：2026-07-09

## 规划结论

两个规划子 agent 独立调研后结论一致：不要继续依赖 `codex://`、`trae://`、`traex://` 或 `multi_url` 来触发本地 CLI。最佳策略是新增飞书卡片 callback action，由 botmux daemon 在本机通过 AppleScript 打开终端，并从服务端 session 状态重新构造命令。

## 采用方案

新增 `open_local_cli` callback action。

- 卡片侧新增独立按钮，不替换现有 Web Terminal 的“打开终端”按钮。
- 仅对 `cliId=codex` / `cliId=traex` 展示本地按钮，文案保持用户语义：“打开 Codex”/“打开 TRAE”。
- handler 侧把 `open_local_cli` 纳入 sensitive action，复用 `canOperate()` 权限门。
- handler 必须立即返回 ack/toast，不等待 AppleScript 执行完成，避免飞书显示“操作已收到后台处理中”。
- handler 不信任 card value 中的 cwd 或 shell command，v1 只用 `root_id/session_id/cli_id` 定位 active session，并从 active `DaemonSession` 读取真实信息；closed/persisted session 暂不支持本机打开。
- 本地启动模块白名单只支持 `codex` 和 `traex`。
- 终端承载优先 iTerm；本机没有 iTerm 时兜底 Terminal.app；不由 `cliId=traex` 推导 Trae terminal。

## 命令构造优先级

第一版优先保证点击后稳定打开本机终端并恢复对应 CLI。

1. 如果 active/adopt session 有 `adoptedFrom.tmuxTarget`，优先生成 `tmux attach-session` + `select-window` + `select-pane`，直连用户原 pane；tmux attach 不额外 `cd <cwd>`。
2. 否则若 active session 是 botmux-managed tmux backend，打开本机终端执行 `tmux attach-session -t bmx-<sessionId-prefix>`，直连当前 live pane，避免复制出第二个 CLI。
3. 否则若 session 有 CLI-native resume id，复用对应 adapter 的 `buildResumeCommand()`：
   - Codex: `codex resume <sid>`
   - TRAE: `traex resume <sid>`
4. CLI-native resume 执行前进入 session working dir：`cd <cwd> && <resume-command>`。
5. zellij/herdr 第一版不做本机直连，包含 managed active session 和 adopt session，均记录明确失败原因。

## 涉及文件

- `src/im/lark/card-builder.ts`
  - 新增 `open_local_cli` 按钮生成 helper。
  - `buildSessionCard()` 和 `buildStreamingCard()` 对 Codex/TRAE 增加本地按钮。
- `src/im/lark/card-handler.ts`
  - `open_local_cli` 加入 sensitive action。
  - 新增 action 分支，立即返回 success toast；本地 opener 后台执行，失败再异步发消息说明原因。
- `src/services/local-cli-opener.ts`
  - 新增命令构造、shell/AppleScript escape、iTerm 优先 + Terminal.app 兜底启动逻辑。
- `test/card-builder.test.ts`
  - 覆盖 Codex/TRAE 按钮存在、非 Codex/TRAE 不出现、Web Terminal 按钮保留。
- 新增 opener/handler 测试
  - 覆盖命令构造、权限门、成功/失败 toast。

## 验收重点

- 点击“打开 TRAE”必须打开本机终端里的 `traex`，不能打开 Trae terminal。
- 点击“打开 Codex”必须立即 ack，并在后台触发本机终端动作，不能让飞书长时间显示后台处理中。
- 非授权用户不能触发本机命令。
- 现有 Web Terminal “打开终端”和“获取操作链接”不回归。
- 卡片 value / URL 不携带完整 shell command 或 token。

## 明确不做

- 不新增公开 GET opener。
- 不使用任何 CLI/App URL scheme。
- 不在 closed/persisted session 卡片上支持本机打开；v1 只覆盖 active `buildSessionCard()` / `buildStreamingCard()`。
- 不改 `terminal-url.ts` / `terminal-proxy.ts`。
- 不把 iTerm 失败 fallback 到 Trae terminal；只能 fallback 到 Terminal.app。

## 实施记录

2026-07-09:

- 新增 `src/services/local-cli-opener.ts`，本地打开仅白名单支持 `codex` / `traex`，通过 `/usr/bin/osascript` 优先驱动 iTerm，iTerm 不可用时驱动 Terminal.app。
- botmux-managed tmux active session 优先 attach `bmx-<sessionId-prefix>`，不会在已有 live 会话旁边再 `codex/traex resume` 出第二个 CLI。
- botmux-managed zellij/herdr active session 返回不支持 toast，不 fallback 到 CLI resume，避免复制出第二个 CLI。
- `buildSessionCard()` / `buildStreamingCard()` 在保留 Web Terminal `multi_url` 按钮的基础上，为 Codex / TRAE 增加 `open_local_cli` callback 按钮。
- `card-handler.ts` 将 `open_local_cli` 纳入 sensitive action，复用 `canOperate()`；handler 只用 active session 构造命令，并校验 card `cli_id` 与 session CLI 一致。
- 已补充 card-builder、local-cli-opener、card-handler 相关单测。
