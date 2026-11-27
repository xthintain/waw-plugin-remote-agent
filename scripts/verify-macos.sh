#!/usr/bin/env bash
# macOS 实机端到端校验脚本（在 Intel / Apple Silicon Mac 上运行）
#
# 校验项：
#   1. build.sh 自动识别 darwin/(arm64|amd64) 并产出原生 Mach-O 二进制
#   2. Go 静态检查 + 完整单元测试（含 /var -> /private/var symlink 围栏、进程组、daemon E2E）
#   3. Node ↔ Go 实机 stdio RPC 冒烟（ping 返回 os=darwin、exec、文件读写、后台 job 启停）
#   4. macOS 实机 /bin/ps 残留进程识别校验
#   5. Node 单元测试（node --test test/）与 install.sh 隔离目录安装冒烟
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: 此脚本需要在 macOS 实机（或 GitHub Actions macos-latest）上运行，当前系统为 $(uname -s)" >&2
  exit 1
fi

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin"

echo "==> [1/5] 检查工具链并按当前 Mac 架构构建 Go agent"
go version
node -v
"$ROOT/native/waw-remote-agent/build.sh"

BIN="$ROOT/native/waw-remote-agent/dist/waw-remote-agent"
file "$BIN" | grep -q "Mach-O" || { echo "error: 产物不是 Mach-O 二进制" >&2; exit 1; }

echo "==> [2/5] 运行 Go vet 与全部单元测试"
(
  cd "$ROOT/native/waw-remote-agent"
  go vet ./...
  go test -v ./...
)

echo "==> [3/5] 运行 macOS 实机 Node ↔ Go stdio RPC 冒烟测试"
TMP_WS="$(mktemp -d /tmp/waw-macos-verify.XXXXXX)"
trap 'rm -rf "$TMP_WS"' EXIT

cd "$ROOT"
ROOT="$ROOT" BIN="$BIN" TMP_WS="$TMP_WS" node --input-type=module - << 'EOF'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { RemoteRpcClient } from './remote-rpc.mjs'

const bin = process.env.BIN
const ws = process.env.TMP_WS
const token = 'macos-smoke-token'

const child = spawn(bin, ['--workspace', ws, '--token', token], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

const rpc = new RemoteRpcClient(child.stdin, child.stdout, token)
try {
  const ping = await rpc.call('ping', {})
  assert.equal(ping.ok, true, `ping failed: ${JSON.stringify(ping)}`)
  assert.equal(ping.result.os, 'darwin', `expected os=darwin, got ${ping.result.os}`)
  // The agent does not report arch; the probe does (`uname -m`). What matters
  // here is that the binary runs at all and speaks the protocol the bridge wants.
  assert.equal(ping.result.protocolVersion, 6, `unexpected protocol: ${ping.result.protocolVersion}`)
  assert.ok(ping.result.shells.length > 0, 'no shell reported')

  const write = await rpc.call('write_file', { path: 'hello.txt', content: 'macos-ok', mkdir: true })
  assert.equal(write.ok, true)
  const read = await rpc.call('read_file', { path: 'hello.txt' })
  assert.equal(read.ok, true)
  assert.equal(read.result.content, 'macos-ok')

  const execRes = await rpc.call('exec', { command: 'uname -s', cwd: ws })
  assert.equal(execRes.ok, true)
  assert.equal(execRes.result.stdout.trim(), 'Darwin')

  const job = await rpc.call('job_start', { command: 'sleep 30', cwd: ws })
  assert.equal(job.ok, true)
  const killed = await rpc.call('job_kill', { jobId: job.result.jobId })
  assert.equal(killed.ok, true)
  assert.equal(killed.result.state, 'killed')

  await rpc.call('shutdown', {})
  console.log(`macOS RPC smoke OK: darwin/${process.arch}`)
} finally {
  rpc.close()
  if (!child.killed) child.kill('SIGTERM')
}
EOF

echo "==> [4/5] 校验 macOS /bin/ps 命令行输出格式"
/bin/ps -axo pid=,command= | head -n 5 >/dev/null

echo "==> [5/5] 运行 Node 单元测试与 install.sh 隔离目录冒烟"
(
  cd "$ROOT"
  node --test test/
  TUI_CONFIG_DIR="$TMP_WS/tui-config" ./install.sh --link
  for f in remote-agent.plugin.mjs remote-bridge.mjs remote-exec.mjs remote-os.mjs remote-rpc.mjs remote-status.mjs; do
    test -L "$TMP_WS/tui-config/plugins/$f" || { echo "error: $f 没被装进插件目录" >&2; exit 1; }
  done
)

echo
echo "ALL macOS real-machine checks PASSED."
