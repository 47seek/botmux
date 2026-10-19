# 任务执行与工具身份

工具身份跟随正在执行的任务。新消息可以准备自己的身份材料；Worker 在该消息开始执行时选择对应材料。授权有效性由任务授权、允许的工具范围及凭证状态决定，对话轮数用于定位执行与审计，不消耗授权次数。

## 执行链路

```mermaid
flowchart LR
  A[可信消息或定时任务授权] --> B[按 turnId 准备工具身份快照]
  B --> C[Worker 开始执行]
  C --> D[发布 caller 与 identityTurnId]
  D --> E[工具入口验证当前执行]
  E --> F[读取该执行的身份快照]
```

`ActiveTurnAuthority` 保存当前执行主体。`turnId` 表示当前消息归属；`identityTurnId` 指向当前执行选用的工具身份。跨主体隔离关闭时，补充消息可以更新消息归属，已有执行继续保留 caller 与身份引用，包括没有真人 caller 的委托执行。

Daemon 将身份写入 session 下按 `identityTurnId` 分开的快照。Worker 发布的原子记录同时携带 turn、caller 和身份引用。PID marker 恢复完成后更新该记录，Daemon 的 managed origin 与工具 Gateway 使用同一执行主体。

Linux 本机受管路径复用 `current-execution` 的进程证明。一次执行重复发布 managed origin 时沿用初始进程边界；执行主体、身份引用、同一消息归属的派发 attempt 或 Worker 代次改变时重新建立边界。工具入口读取本次证明指向的快照。Lark user 入口在异步取凭证后复核执行状态。

## 定时任务与授权等待

Direct 定时任务沿用持久化的可信创建者。Delegated 定时任务可以没有真人 actor，凭精确执行绑定的有效工具委托解析授权目标。每次运行继续执行已有的任务状态、目标用户、工具范围和凭证检查。撤销授权、范围不符和凭证失效仍会阻止对应调用。

`auth request` 固定应用、授权用户及 scopes，`auth wait` 固定 requestId。隔离会话每次轮询读取当前执行 claim；服务端核对该执行与原授权用户。相同用户的后续执行可以接收完成的授权；其他用户开始执行时拒绝原请求，具体返回执行证明失败或 `auth_turn_changed`。身份文件尚未就绪时返回 `pending`，CLI 在原有超时窗口内继续轮询。

## 常用 Case

| 场景 | 预期结果 | 对应验证 |
|---|---|---|
| A 执行时 B、C 入队 | A 工具继续使用 A；B、C 各自准备快照 | `cli-identity`、`turn-cli-identity` |
| A 结束，B 开始 | 工具选择 B 的快照 | `cli-identity`、`worker-turn-idle` |
| 跨主体隔离关闭，B 补充 A 的执行 | 消息归属更新；caller 和身份引用保留 A | `active-turn-authority`、`session-lifecycle-start` |
| 无真人 actor 的委托任务收到真人补充 | 保留原委托执行及身份引用 | `active-turn-authority`、`ipc-auth-request` |
| 定时任务在没有新人工消息时运行 | Direct 使用可信创建者；delegated 使用授权工具范围 | `scheduler-authority-integration`、`schedule-delegated-runtime` |
| 同一次执行重复发布 managed origin | 已启动的合法工具进程继续通过证明 | `session-lifecycle-start` |
| A 遗留 shell 在 B 执行期间派生工具 | Linux 本机入口拒绝获取 B 的身份 | `ipc-current-execution-route`、`ipc-lark-tool-identity` |
| 授权期间同一用户发新消息 | requestId 与授权用户保持，轮询当前 claim | `auth-request`、`ipc-auth-request` |
| 授权期间实际执行切换为其他用户 | 原请求返回明确错误，凭证不写入其他用户快照 | `ipc-auth-request` |
| PID marker 由外部推进或恢复 | marker、活动身份文件、managed origin 一致 | `worker-turn-idle` |
| 委托由 bot 派发，凭证属于真人 | 按委托目标运行；bot caller 与用户身份可以不同 | `cli-identity`、`ipc-lark-tool-identity` |

## 验证与适用范围

使用仓库固定版本 Bun 安装依赖，运行 `bun run build`。上述 Case 的原生测试入口为 `bun run test --maxWorkers 4 test/<name>.test.ts`；真实 Worker 与工具测试采用隔离 HOME、临时数据目录和测试凭证。

进程证明依赖 Linux `/proc` 与本机受管 Worker/CLI 血缘。macOS、remote、adopt、外部 app-server 和 workflow 路径继续按各自既有契约运行；本变更的旧进程跨执行隔离保证限于 Linux 本机受管入口。发布后需重建对应 Worker，使入口与 Daemon 使用同一版本。真实第三方 OAuth、线上定时任务和 macOS 运行结果需要部署环境验证。
