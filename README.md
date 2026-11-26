# waw-plugin-remote-agent

waw 的**远程工作区**插件：一条 SSH 目标 = 一个远端项目，shell / 文件读写 / glob / grep 都在那台机器上执行，外加后台 job。支持 **Linux、macOS（Intel / Apple Silicon）与 Windows**。

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
| `remote-agent.plugin.mjs` | 插件入口，两端的分支都在这里 |
| `remote-bridge.mjs` | 起 / 池化 `waw-remote-agent`，SSH 只用来探测目标平台、投递并启动远端二进制 |
| `remote-exec.mjs` | 远端 shell / fs / code::map 的转发层 |
| `remote-rpc.mjs` | 与远端二进制的 JSON-RPC 客户端 |
| `remote-status.mjs` | 健康表（侧栏与重连用），被 `remote-rpc.test.ts` / `remote-status.test.ts` 覆盖 |
| `native/waw-remote-agent/` | 远端 Go agent 源码（协议版本 5：daemon 生命周期 + 后台 job，支持 Linux / macOS / Windows） |

## 平台支持与构建

支持宿主机与远端主机任意组合（Linux / macOS / Windows × `amd64` / `arm64`）：

```sh
# macOS / Linux：自动按当前宿主机 OS/arch 构建
./install.sh --build

# 一次交叉构建全平台二进制（推荐跨平台 SSH，如 macOS 连 Linux 远端）
./install.sh --build-all
# 或直接跑构建脚本：
./native/waw-remote-agent/build.sh --all
```

Windows PowerShell：

```powershell
# 按当前 Windows 架构（amd64/arm64）构建
.\native\waw-remote-agent\build.ps1

# 一次交叉构建全平台二进制（含 linux / darwin / windows）
.\native\waw-remote-agent\build.ps1 -All
```

## 安装

```sh
./install.sh              # 复制 .mjs 到 ~/.waw/tui/plugins/
./install.sh --link       # 软链接，改代码后 reload 生效
./install.sh --build      # 顺带按当前平台 go build 出远端二进制
./install.sh --build-all  # 顺带交叉构建全平台二进制
```

插件加载成功但远端功能起不来，几乎总是二进制缺失。解析顺序见 `remote-bridge.mjs` 的 `resolveLocalBinary()`（优先按目标 `<os>-<arch>` 匹配 `waw-remote-agent-<os>-<arch>[.exe]`，再回退通用名 `waw-remote-agent[.exe]`）：

1. `$WAW_REMOTE_AGENT_BIN`
2. 仓库内 `native/waw-remote-agent/dist/`
3. `$WAW_EXTRAS_DIR/bin/`、macOS `~/Library/Application Support/waw/extras/bin/`、Windows `%LOCALAPPDATA%\waw\extras\bin\` 或 `~/.local/share/waw/extras/bin/`

远端侧默认落在 `~/.waw/bin/waw-remote-agent`，用 `WAW_REMOTE_AGENT_REMOTE_PATH` 覆盖。

## 两个半端的可安装性

同一个文件被求值两次，可安装性和「装到哪」并不相同（冒烟实测，2026-11-20）：

| 半端 | 能力 | 放进 `~/.waw/tui/plugins/` | 说明 |
| --- | --- | --- | --- |
| tui-host（Node） | `remote::*` 工具、远端 shell/fs、后台 job | ✅ 可用 | 只依赖 `node:*` 与同目录 `.mjs`，无 app 内组件 |
| 桌面 webview | 侧栏目标列表、创建向导、SSH 设置节 | ⚠️ 需 app 内的 `../components/*`、`../agent/tui-host-api` | 只有跑在 `web-agent/desktop/agent-desktop` 的 Vite 图里才解析得到。生产包用 `scripts/install-extras.mjs` 装进 `<extras>/plugins` |

因此 `./install.sh` 默认把文件复制到 drop-in 目录，**保证 TUI 侧工具可用**；桌面面板请跟 waw-desktop 一起构建/安装。

## 测试

```sh
pnpm test          # 或 npx vitest run —— 覆盖 remote-rpc / remote-status / remote-bridge
./native/waw-remote-agent/build.sh && (cd native/waw-remote-agent && go test ./...)
```

## 与 web-agent 的关系

**源真相在 [`web-agent`](https://gitea.x.com/xthintain/…) 的 `desktop/agent-desktop/src/plugins` 与 `native/waw-remote-agent`**。
本仓库是它的可安装镜像，用清单驱动同步：

```sh
./scripts/sync-from-web-agent.sh          # 上游 → 本仓库
./scripts/sync-from-web-agent.sh --check  # 只比对，有差异以 1 退出
```

## License

MIT
