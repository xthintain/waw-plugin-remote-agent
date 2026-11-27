# waw-plugin-remote-agent

waw 的**远程工作区**插件：一条 SSH 目标 = 一个远端项目，shell / 文件读写 / glob / grep 都在那台机器上执行，外加后台 job。宿主与远端支持 **Linux、macOS（Intel / Apple Silicon）与 Windows** 的任意组合。

同一个 `.plugin.mjs` 会被求值两次（这就是 waw 的插件契约）：

```
tui-host（Node）                    桌面 webview
capabilities.tools|modules|servers  capabilities.ui|extras
  ├─ 注册 remote::* 工具             ├─ 侧栏目标列表 / 创建向导
  ├─ 拉起 waw-remote-agent（Go）      ├─ 设置节（SSH config / 私钥 + passphrase 表单）
  └─ 通过 RPC 转发 shell/fs 调用      └─ 面板渲染 + 命令 + 快捷键
```

## 组成

| 文件 | 作用 |
| --- | --- |
| `remote-agent.plugin.mjs` | 插件入口，两端的分支都在这里（静态只依赖 `remote-os.mjs`，两个半端按需动态加载） |
| `remote-bridge.mjs` | 起 / 池化 `waw-remote-agent`：SSH 只用来探测目标平台、投递并启动远端二进制；含 ControlMaster、askpass 与本地二进制的解析 |
| `remote-exec.mjs` | 远端 shell / fs / code::map 的转发层 |
| `remote-os.mjs` | 跨平台的纯规则：远端根路径、盘符、引号、PowerShell 引导命令、目标二进制名（与 TUI 宿主共用同一套向量） |
| `remote-rpc.mjs` | 与远端二进制的 JSON-RPC 客户端 |
| `remote-status.mjs` | 健康表（侧栏与重连用） |
| `native/waw-remote-agent/` | 远端 Go agent 源码：协议 **6**，daemon 生命周期 + 后台 job，Linux / macOS / Windows 三端 |

## 平台

- **命令执行**按平台检测 shell（`native/waw-remote-agent/shell.go`）：POSIX 用 `bash -lc`（无 bash 退 `sh -lc`）；Windows 默认 `pwsh` → `powershell`，并额外探测 Git Bash。`exec` / `job_start` 可逐条指定 `shell`（`auto` / `powershell` / `gitbash` / `posix`），主机没有的那个返回可用列表而不是静默换 shell。
- **协议号 6**：Windows 远端必须 6，POSIX 远端仍接受 5（升级不强制重装所有 Linux agent）。
- **进程树**：Windows 用 `taskkill /T /F`（exec 超时与 `job_kill` 共用），daemon 的 worker 另挂 Job Object（`KILL_ON_JOB_CLOSE`），daemon 被强杀也不留孤儿。
- **残留进程回收**：Linux 读 `/proc`，macOS 没有 procfs 改问 `/bin/ps -axo pid=,command=`，Windows 按镜像名 + 命令行过滤；三端都只回收同一二进制的非 `--daemon` 进程。
- **SSH 控制套接字**：macOS 的 `sockaddr_un.sun_path` 只有 104 字节，家目录过长时改落 `/tmp/waw-cm-<uid>`；Windows 的 OpenSSH 没有控制套接字，只给 `ConnectTimeout`。

## 构建

```sh
# 本机目标（自动识别 linux / darwin / windows × amd64 / arm64）+ 默认远端矩阵
./native/waw-remote-agent/build.sh

# 一次交叉构建全平台（推荐跨平台 SSH，如 macOS 连 Linux 远端）
./native/waw-remote-agent/build.sh --all

# 只多产指定目标（本机目标始终补入）
WAW_REMOTE_TARGETS=darwin/arm64,linux/amd64 ./native/waw-remote-agent/build.sh
```

`dist/waw-remote-agent[.exe]`（不带 os/arch）永远是**本机目标**的产物 —— 本机 spawn 用它；远端上传走 `waw-remote-agent-<os>-<arch>[.exe]`。Windows 侧用 `pwsh -File native/waw-remote-agent/build.ps1`（只产 `windows/amd64`；arm64 宿主先 `$env:GOARCH='arm64'`，`--all` 与 `WAW_REMOTE_TARGETS` 目前只在 `build.sh` 里）。

## 安装

```sh
./install.sh              # 复制 .mjs 到 ~/.waw/tui/plugins/
./install.sh --link       # 软链接，改代码后 reload 生效
./install.sh --build      # 顺带按当前平台 go build
./install.sh --build-all  # 顺带交叉构建全平台
```

运行期是六个 `.mjs` 一整组（互相 import）；`TUI_CONFIG_DIR` 覆盖插件目录（默认 `~/.waw/tui`）。桌面版读同一目录，装一次两边都可用。

插件加载成功但远端功能起不来，几乎总是二进制缺失。解析顺序（`remote-bridge.mjs` 的 `localBinary()` / `binaryNamesFor()`）：

1. `$WAW_REMOTE_AGENT_BIN`（Windows 目标用 `$WAW_REMOTE_AGENT_WIN_BIN`）
2. `native/waw-remote-agent/dist/`：先找 `waw-remote-agent-<os>-<arch>[.exe]`，再回退不带后缀的那份。**这里按插件自身位置与进程 cwd 找**，所以只命中两种情况：插件跑在 waw 源码树里（`desktop/agent-desktop/src/plugins/`），或宿主 cwd 就是仓库根 / 其子目录
3. `$WAW_EXTRAS_DIR/bin/` 或 `${XDG_DATA_HOME:-~/.local/share}/waw/extras/bin/`（桌面 `install-extras.mjs` 装到这里）

也就是说：装进 `~/.waw/tui/plugins/` 之后，仓库里的 `dist/` **不会**被找到。`./install.sh --build` 会把它打印出来，并提示 `export $WAW_REMOTE_AGENT_BIN=…` 或复制进 extras 目录 —— 二选一之后远端才可用。

远端侧默认落在 `~/.waw/bin/waw-remote-agent`（Windows 是带 arch 与内容 hash 的版本化文件名，避免覆盖正在运行的 exe），用 `WAW_REMOTE_AGENT_REMOTE_PATH` 覆盖。

## 两个半端的可安装性

| 半端 | 能力 | 放进 `~/.waw/tui/plugins/` | 说明 |
| --- | --- | --- | --- |
| tui-host（Node） | `remote::*` 工具、远端 shell/fs、后台 job | ✅ 可用 | 只依赖 `node:*` 与同目录 `.mjs` |
| 桌面 webview | 侧栏目标列表、创建向导、SSH 设置节 | ⚠️ 需 app 内的 `../components/*`、`../agent/tui-host-api` | 只有跑在 waw 的 `desktop/agent-desktop` Vite 图里才解析得到 |

`test/mirror-invariants.test.mjs` 把这条边界钉住：`./x.mjs` 必须在本仓库里解析得到，`../*` 只允许出现在桌面那半端。

## 测试

```sh
node --test test/                     # 零安装：纯规则 + 平台判断 + 镜像不变量
./native/waw-remote-agent/build.sh    # e2e 用例需要先构建出二进制
(cd native/waw-remote-agent && go vet ./... && go test ./...)
```

跑完 Go 命令后如果 `./scripts/sync-from-web-agent.sh --check` 报 `go.mod` 差异，是 Go 工具链按 `-mod=mod` 去掉了 `// indirect`（历史上发生过），重新 `sync` 一次再提交即可 —— 本仓库要求与上游逐字节一致。

`test/` 是**镜像自己的**套件，不随上游同步：`remote-os.test.mjs` 钉跨平台路径/引号/探测解析，`remote-bridge.test.mjs` 钉二进制命名、协议号与 SSH 控制套接字，`mirror-invariants.test.mjs` 钉「运行期文件导得通、安装清单、同步清单、协议号」四处不漂移。上游对应的 vitest 用例在 waw 仓库里。

## 与上游的关系

**源真相在 [waw](https://github.com/xthintain/waw) 的 `desktop/agent-desktop/src/plugins` 与 `native/waw-remote-agent`。**
本仓库是它的可安装镜像，用清单驱动同步（`scripts/sync-manifest.txt`）：

```sh
./scripts/sync-from-web-agent.sh          # 上游 → 本仓库（WEB_AGENT 覆盖上游路径）
./scripts/sync-from-web-agent.sh --check  # 只比对，有差异以 1 退出
```

`--check` 按内容比对（CRLF/LF 不算差异），两个方向的漏登记都算漂移：本仓库多出来的 `.mjs`，以及上游新加却没进清单的 `remote-*.mjs` / Go 源文件与构建脚本。本仓库的 `test/`、`install.sh`、`scripts/`、`README.md` 是镜像自有文件，不随上游覆盖。

## License

MIT
