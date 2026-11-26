#!/usr/bin/env bash
# 构建 strip 后的二进制到 dist/
#
#   ./build.sh                 按当前宿主机 OS/arch 构建（支持 macOS / Linux / Windows Git Bash）
#   GOOS=linux GOARCH=amd64 ./build.sh   指定目标交叉构建
#   ./build.sh --all           交叉构建全部常用平台（linux / darwin / windows × amd64 / arm64）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin"
mkdir -p "$ROOT/dist"
cd "$ROOT"

detect_goos() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "linux" ;;
  esac
}

detect_goarch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "amd64" ;;
    *) echo "amd64" ;;
  esac
}

build_one() {
  local os="$1"
  local arch="$2"
  local ext=""
  if [ "$os" = "windows" ]; then
    ext=".exe"
  fi
  local out="dist/waw-remote-agent-${os}-${arch}${ext}"
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 \
    go build -trimpath -ldflags='-s -w' -o "$out" .
  echo "built $ROOT/$out"
}

HOST_GOOS="$(detect_goos)"
HOST_GOARCH="$(detect_goarch)"

if [ "${1:-}" = "--all" ]; then
  for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
    build_one "${target%/*}" "${target#*/}"
  done
  ext=""
  [ "$HOST_GOOS" = "windows" ] && ext=".exe"
  cp -f "dist/waw-remote-agent-${HOST_GOOS}-${HOST_GOARCH}${ext}" "dist/waw-remote-agent${ext}"
  echo "default binary: $ROOT/dist/waw-remote-agent${ext} (${HOST_GOOS}/${HOST_GOARCH})"
  exit 0
fi

: "${GOOS:=$HOST_GOOS}"
: "${GOARCH:=$HOST_GOARCH}"
export GOOS GOARCH
export CGO_ENABLED=0

ext=""
[ "$GOOS" = "windows" ] && ext=".exe"
build_one "$GOOS" "$GOARCH"
cp -f "dist/waw-remote-agent-${GOOS}-${GOARCH}${ext}" "dist/waw-remote-agent${ext}"
echo "built $ROOT/dist/waw-remote-agent${ext}"
