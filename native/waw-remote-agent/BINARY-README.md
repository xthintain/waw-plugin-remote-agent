# waw-remote-agent

SSH / WS / HTTP 远端无 UI 工具面（Go）。帧协议见 `docs/plans/2026-08-15-ssh-go-remote-agent.md`，守护进程设计见 `docs/plans/go-remote-agent-daemon.md`。

## 三种控制面

| 方式        | 参数                            | 对端                                      |
| ----------- | ------------------------------- | ----------------------------------------- |
| stdio       | 无                              | SSH 管道（`ssh-remote.service` spawn）    |
| WS 逆连     | `--dial-ws ws://…/remote-agent` | web 平台 agent-service                    |
| HTTP 长轮询 | `--dial-http http://host:port`  | TUI host（`pnpm --filter @waw/tui host`） |

两种远端传输的方法面完全相同，只是请求/响应的搬运方式不同：WS 一问一答直接走 socket；
HTTP 是 `register → poll → reply`，响应由后台 goroutine 提交，处理本身不阻塞。两者同时给时
以 `--dial-http` 为准（stderr 会提示）。

## 两种运行模式

### 1. worker（工具面，原单进程）—— stdio / WS / HTTP

```bash
# stdio（SSH 管道）
./build.sh
./dist/waw-remote-agent --workspace /tmp/ws --token test

# WebSocket 逆向（预装到 Pod/VM）
./dist/waw-remote-agent \
  --workspace /data/ws \
  --token "$TOKEN" \
  --agent-id pod-a \
  --dial-ws "ws://agent-service:3001/remote-agent"

# HTTP 长轮询（TUI host）
./dist/waw-remote-agent \
  --workspace /data/ws \
  --token "$TOKEN" \
  --agent-id pod-a \
  --dial-http "http://127.0.0.1:5191"
```

Token：控制面 `POST /api/remote-agents/tokens`，或环境变量 `REMOTE_AGENT_SHARED_TOKEN`。不调用 LLM、不持有 API Key。

HTTP 模式下 token 同时用作 hub 的 bearer（`WAW_TUI_REMOTE_HUB_TOKEN` 配置在 host 上时，两边填同一个值）。
404 来自 `poll` 表示 host 已不认这个会话，进程会重新注册并继续；daemon 里则由 supervisor 重连。

### 2. daemon（守护进程，同 agency 双进程）—— 常驻 supervisor

```bash
./dist/waw-remote-agent \
  --daemon \
  --workspace /data/ws \
  --token "$TOKEN" \
  --agent-id pod-a \
  --dial-ws "ws://agent-service:3001/remote-agent"
```

- **daemon**：常驻，以 `<agentId>:daemon` 连控制面（命令面），派生并监督 worker。
- **worker**：daemon 派生的子进程（同一 binary），以 `<agentId>` 连控制面（工具面：exec/read_file 等）。
- 传输沿用 daemon 启动时选的 `--dial-ws` / `--dial-http`，worker 不会另连一个平面。
- worker 非显式停止时崩溃会被 daemon **自动重启**；显式 `daemon_stop` 后不再自启，直到 `daemon_start`。

#### 生命周期（WAW 开关机语义）

- **控制面未启动**：daemon 只做带退避的重连，**不派生 worker**（不会在 WAW 没开时唤醒远端 agent）。
- **WAW 关闭 / 连接断开**：立即暂停 worker 的自动重启（避免对着不存在的控制面 500ms 空转），已有进程保留到 `--idle-stop` 宽限期（默认 `30m`）；到期后 daemon 停止所有 worker（Linux 通过 `/proc`、macOS 通过 `ps` 同时清扫同一 binary 的其它非 daemon 进程），**daemon 自身常驻**。
- **WAW 重新启动**：daemon 重连成功即取消回收并唤醒 worker。
- 显式 `daemon_stop` 的停止意图跨重连保持；`daemon_start` / `daemon_restart` 才会重新拉起。
- 回收宽限期可用 `--idle-stop 10m` 调整（默认 `30m`）。

#### daemon 级 RPC（发到 `<agentId>:daemon` 连接）

| method           | 行为                                        |
| ---------------- | ------------------------------------------- |
| `daemon_status`  | 返回 `{daemon:"alive", worker:{state,pid}}` |
| `daemon_stop`    | 关闭 worker 子进程（保留 daemon 常驻）      |
| `daemon_start`   | 拉起 worker（若已在跑返回 already_running） |
| `daemon_restart` | 重启 worker                                 |

**模型内置工具**：`remote_agent_daemon{agentId, action(status|stop|start|restart)}`，经控制面转发到目标 agent 的 daemon。web 侧由 agent-service 的 `remote-agent-daemon` 工具提供；TUI 侧由 `remote` 模块提供（desktop 模式注册，见 `docs/tui.md`）。
