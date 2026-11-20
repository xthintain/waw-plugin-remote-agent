#!/usr/bin/env bash
# 把 remote-agent 插件装进 waw 的插件目录，并按需构建 Go 端二进制。
#
#   ./install.sh              只复制 .mjs 文件
#   ./install.sh --link       软链接（改代码后 reload 即生效）
#   ./install.sh --build      先 go build 生成 native/waw-remote-agent/dist/waw-remote-agent
#
# TUI_CONFIG_DIR 覆盖插件目录（默认 ~/.waw/tui）。桌面版读同一目录，
# 因此装一次两边都可用。
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest=${TUI_CONFIG_DIR:-$HOME/.waw/tui}/plugins
mode=copy

for arg in "$@"; do
  case "$arg" in
    --link) mode=link ;;
    --build) build=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "${build:-0}" = 1 ]; then
  "$here/native/waw-remote-agent/build.sh"
  echo
  echo "binary: $here/native/waw-remote-agent/dist/waw-remote-agent"
  echo "指向它：export WAW_REMOTE_AGENT_BIN=$here/native/waw-remote-agent/dist/waw-remote-agent"
  echo "或复制到 ~/.local/share/waw/extras/bin/"
  echo
fi

mkdir -p "$dest"
for f in remote-agent.plugin.mjs remote-bridge.mjs remote-exec.mjs remote-rpc.mjs remote-status.mjs; do
  [ -f "$here/$f" ] || { echo "missing $f" >&2; exit 1; }
  if [ "$mode" = link ]; then ln -sfn "$here/$f" "$dest/$f"; else cp -f "$here/$f" "$dest/$f"; fi
done

if [ ! -x "${WAW_REMOTE_AGENT_BIN:-}" ] && [ ! -x "$HOME/.local/share/waw/extras/bin/waw-remote-agent" ] \
   && [ ! -x "$here/native/waw-remote-agent/dist/waw-remote-agent" ]; then
  echo
  echo "warn: 没找到 waw-remote-agent 二进制。插件会加载成功但远端功能起不来。" >&2
  echo "      跑 ./install.sh --build，或设置 WAW_REMOTE_AGENT_BIN 指向已有二进制。" >&2
fi

echo
echo "installed into $dest"
echo "reload: /plugins 里 reload remote-agent，或重启 CLI"
