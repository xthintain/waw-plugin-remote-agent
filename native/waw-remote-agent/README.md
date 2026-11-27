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

## 平台：POSIX 与 Windows

- 路径与文件 RPC（`read_file`/`write_file`/`stat`/`list_dir`）走 Go 的 `filepath`，Windows 的盘符与反斜杠本来就支持；允许根判断在 Windows 上大小写不敏感。
- **命令执行**按平台检测 shell（`shell.go`）：Linux/macOS 用 `bash -lc`（无 bash 退 `sh -lc`）；Windows 默认 `pwsh`（7+）→ `powershell`（5.1），并额外探测 **Git Bash**（`Git\bin\bash.exe`，`uname -s` 为 `MINGW*`/`MSYS*`；WSL 的 `System32\bash.exe` 不算）。PowerShell 用 `-Command` 执行、传播 `$LASTEXITCODE`、UTF-8 输出；不兜底 cmd.exe。
- **逐条选择 shell**：`exec` 与 `job_start` 接受可选 `shell`（`auto`/`powershell`/`gitbash`/`posix`）。同一台 Windows 主机上两种 shell 都可用时，由调用方按命令语法选择；主机没有的那个会返回可用列表，不会静默换 shell。`ping` 回报 `os` / `shell` / `shells` / `posixShell` / `capabilities`（`posixScripts` 有 Git Bash 即为真）。
- 协议号 6：Windows 主机必须用 6，POSIX 仍接受 5。
- **Windows 上的进程树**：`proc_windows.go` 用 `taskkill /T /F` 结束整棵树（`job_kill` 与 exec 超时共用），daemon 的停止也走 `terminateProcess`。
- **残留进程回收分三端**：Linux 读 `/proc`（`stray_linux.go`），macOS 没有 procfs，改问 `/bin/ps -axo pid=,command=`（`stray_darwin.go`，解析在 `stray_ps.go`），Windows 按镜像名 + 命令行过滤（`stray_windows.go`）。三端都只回收同二进制的非 `--daemon` 进程；daemon 的直接子进程由 `stopWorker` 处理。
- 构建（本机那份供桌面 spawn，其余按探测到的远端 OS/arch 上传；macOS 主机因此产 darwin 而不是 Linux 二进制）：

```bash
./build.sh   # 本机目标（自动识别 linux/darwin/windows × amd64/arm64）+ linux/amd64 + windows/amd64 + windows/arm64
./build.sh --all                            # linux / darwin / windows × amd64 / arm64
WAW_REMOTE_TARGETS=linux/amd64 ./build.sh   # 只多产指定的那份（本机目标始终补入）
pwsh -File build.ps1                        # Windows 本机构建
```

`dist/waw-remote-agent[.exe]`（不带 os/arch）永远是**本机目标**的产物：宿主默认路径、e2e 与 smoke 都按这个名字取本地 pipe 用的二进制。

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
- **WAW 关闭 / 连接断开**：立即暂停 worker 的自动重启（避免对着不存在的控制面 500ms 空转），已有进程保留到 `--idle-stop` 宽限期（默认 `30m`）；到期后 daemon 停止所有 worker（Linux 下同时清扫同一 binary 的其它非 daemon 进程），**daemon 自身常驻**。
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
