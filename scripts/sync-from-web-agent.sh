#!/usr/bin/env bash
# 从上游拉取源文件，让本仓库保持投影状态。
#
# 源真相在 waw：desktop/agent-desktop/src/plugins 与 native/waw-remote-agent。
# 本仓库是它的可安装镜像，供「单独安装 / 单独引用 / 单独 issue」使用。运行期
# .mjs、Go 源码/测试与构建脚本由清单驱动；test/ 是镜像自己的 node --test 套件，
# 不随上游同步（上游对应的是 vitest 的 *.test.ts）。
#
#   ./scripts/sync-from-web-agent.sh            复制上游 → 本仓库
#   ./scripts/sync-from-web-agent.sh --check    只比对，有差异以 1 退出（CI 用）
#
# WEB_AGENT 覆盖上游路径；缺省依次尝试 ~/gitRepo/web-agent 与与本仓库同级的 waw。
# 清单格式见 scripts/sync-manifest.txt：<plugin|native> <相对路径>。
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:-copy}
fail=0

if [ -n "${WEB_AGENT:-}" ]; then
  src=$WEB_AGENT
else
  src=''
  for candidate in "$HOME/gitRepo/web-agent" "$here/../waw"; do
    if [ -d "$candidate/desktop/agent-desktop/src/plugins" ]; then
      src=$candidate
      break
    fi
  done
fi
if [ -z "$src" ]; then
  echo "no upstream checkout found — set WEB_AGENT to the waw repository root" >&2
  exit 2
fi

# 两侧都可能是 CRLF 检出（Windows 的 core.autocrlf），行尾不是内容差异。
same_file() { cmp -s <(tr -d '\r' < "$1") <(tr -d '\r' < "$2"); }

copy_one() { # $1=源 $2=目标(相对 here)
  local to="$here/$2"
  if [ ! -f "$1" ]; then
    echo "missing source: $1" >&2
    fail=1
    return
  fi
  if [ "$mode" = "--check" ]; then
    if [ ! -f "$to" ] || ! same_file "$1" "$to"; then
      echo "differs: $2"
      fail=1
    fi
  else
    mkdir -p "$(dirname "$to")"
    cp -f "$1" "$to"
    echo "synced $2"
  fi
}

while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "${line:-}" in ''|\#*) continue ;; esac
  kind=${line%%[[:space:]]*}
  rel=${line#*[[:space:]]}
  case "$kind" in
    plugin) copy_one "$src/desktop/agent-desktop/src/plugins/$rel" "$rel" ;;
    native) copy_one "$src/native/$rel" "native/$rel" ;;
    *) echo "unknown kind: $kind" >&2; fail=1 ;;
  esac
done < "$here/scripts/sync-manifest.txt"

# 清单之外多出来的运行期文件同样是漂移：install.sh 按清单整组复制，漏一个下一次
# 安装就会在运行时 "Cannot find module"。上游新加的文件没登记则永远同步不下来，
# 所以两个方向都查，且只在 --check 下报告，不自动删/加。
listed() { # $1=kind $2=name
  tr -d '\r' < "$here/scripts/sync-manifest.txt" | grep -qxF "$1 $2"
}
unlisted() { # $1=kind $2=name $3=说明
  listed "$1" "$2" || {
    echo "unlisted $3: $2"
    fail=1
  }
}
if [ "$mode" = "--check" ]; then
  for f in "$here"/*.mjs; do
    [ -e "$f" ] || continue
    unlisted plugin "$(basename "$f")" "plugin file"
  done
  for f in "$src/desktop/agent-desktop/src/plugins"/remote-*.mjs; do
    [ -e "$f" ] || continue
    unlisted plugin "$(basename "$f")" "upstream plugin file"
  done
  for f in "$src/native/waw-remote-agent"/*.go \
    "$src/native/waw-remote-agent/go.mod" \
    "$src/native/waw-remote-agent/go.sum" \
    "$src/native/waw-remote-agent/README.md" \
    "$src/native/waw-remote-agent/build.sh" \
    "$src/native/waw-remote-agent/build.ps1"; do
    [ -e "$f" ] || continue
    unlisted native "waw-remote-agent/$(basename "$f")" "upstream native file"
  done
fi

if [ $fail -eq 0 ]; then
  if [ "$mode" = "--check" ]; then
    echo "up to date with $src ($(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo '?'))"
  else
    echo "done. upstream: $(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  fi
  exit 0
fi
echo "sync failed ($mode): 见上面的 differs / missing / unlisted" >&2
exit 1
