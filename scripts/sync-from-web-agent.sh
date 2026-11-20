#!/usr/bin/env bash
# 从 web-agent 拉取上游源文件，让本仓库保持与 web-agent 一致。
#
# 源真相在 web-agent（desktop/agent-desktop/src/plugins 与 native/）。
# 本仓库是镜像，供「单独安装 / 单独引用 / 单独 issue」使用。
#
#   ./scripts/sync-from-web-agent.sh            复制上游 → 本仓库
#   ./scripts/sync-from-web-agent.sh --check    只比对，有差异以 1 退出（CI 用）
#
# WEB_AGENT 覆盖上游路径（默认 ~/gitRepo/web-agent）。
# 清单格式见 scripts/sync-manifest.txt：<plugin|native> <相对路径>
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src=${WEB_AGENT:-$HOME/gitRepo/web-agent}
mode=${1:-copy}
fail=0

copy_one() { # $1=源 $2=目标(相对 here)
  local to="$here/$2"
  [ -f "$1" ] || { echo "missing source: $1" >&2; fail=1; return; }
  if [ "$mode" = "--check" ]; then
    cmp -s "$1" "$to" || { echo "differs: $2"; fail=1; }
  else
    mkdir -p "$(dirname "$to")"
    cp -f "$1" "$to"
    echo "synced $2"
  fi
}

while read -r kind rel; do
  case "${kind:-}" in
    ''|\#*) continue ;;
    plugin) copy_one "$src/desktop/agent-desktop/src/plugins/$rel" "$rel" ;;
    native) copy_one "$src/native/$rel" "native/$rel" ;;
    *) echo "unknown kind: $kind" >&2; fail=1 ;;
  esac
done < "$here/scripts/sync-manifest.txt"

if [ "$mode" = "--check" ]; then
  [ $fail -eq 0 ] && echo "up to date with $src ($(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  exit $fail
fi
echo "done. upstream: $(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
