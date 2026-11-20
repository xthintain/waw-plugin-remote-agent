#!/usr/bin/env bash
# 构建 strip 后的二进制到 dist/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="${PATH}:/usr/local/go/bin"
mkdir -p "$ROOT/dist"
cd "$ROOT"
: "${GOOS:=linux}"
: "${GOARCH:=amd64}"
export GOOS GOARCH
export CGO_ENABLED=0
go build -trimpath -ldflags='-s -w' -o "dist/waw-remote-agent-${GOOS}-${GOARCH}" .
cp -f "dist/waw-remote-agent-${GOOS}-${GOARCH}" dist/waw-remote-agent
echo "built $ROOT/dist/waw-remote-agent"
