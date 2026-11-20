# waw-plugin-remote-agent

waw 的**远程工作区**插件：一条 SSH 目标 = 一个远端项目，shell / 文件读写 / glob / grep 都在那台机器上执行，外加后台 job。

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
| `remote-bridge.mjs` | 起 / 池化 `waw-remote-agent`，SSH 只用来投递并启动远端二进制 |
| `remote-exec.mjs` | 远端 shell / fs / code::map 的转发层 |
| `remote-rpc.mjs` | 与远端二进制的 JSON-RPC 客户端 |
| `remote-status.mjs` | 健康表（侧栏与重连用），被 `remote-rpc.test.ts` / `remote-status.test.ts` 覆盖 |
| `native/waw-remote-agent/` | 远端 Go agent 源码（协议版本 5：daemon 生命周期 + 后台 job） |

## 安装

```sh
./install.sh            # 复制 .mjs 到 ~/.waw/tui/plugins/
./install.sh --link     # 软链接，改代码后 reload 生效
./install.sh --build    # 顺带 go build 出远端二进制
```

插件加载成功但远端功能起不来，几乎总是二进制缺失。解析顺序见 `remote-bridge.mjs` 的 `localBinary()`：

1. `$WAW_REMOTE_AGENT_BIN`
2. 仓库内 `native/waw-remote-agent/dist/waw-remote-agent`
3. `$WAW_EXTRAS_DIR/bin/` 或 `~/.local/share/waw/extras/bin/`（`scripts/install-extras.mjs` 装的位置）

远端侧默认落在 `~/.waw/bin/waw-remote-agent`，用 `WAW_REMOTE_AGENT_REMOTE_PATH` 覆盖。

## 测试

```sh
pnpm test          # 或 npx vitest run —— 覆盖 remote-rpc / remote-status
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
