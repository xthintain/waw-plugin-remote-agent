#!/usr/bin/env bash
# 构建 strip 后的二进制到 dist/
#
# 默认产出「本机目标」+ linux/amd64 + Windows 的 amd64/arm64：本机目标那份供
# 桌面在本机 spawn / stdio 运行，Windows 两份供 SSH 桥接按探测到的远端架构上传
# （desktop/agent-desktop/src/plugins/remote-bridge.mjs 的 binaryNamesFor）。因此
# 在 macOS 上默认产出 darwin/<arch>，而不是一个本机跑不了的 Linux 二进制。
#
#   ./build.sh                     本机目标 + 默认远端矩阵
#   ./build.sh --all               linux / darwin / windows × amd64 / arm64
#   WAW_REMOTE_TARGETS=darwin/arm64,linux/amd64 ./build.sh   显式指定（本机目标始终补入）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Homebrew 在 Apple Silicon 装到 /opt/homebrew，Intel 在 /usr/local；两处都补进 PATH。
export PATH="${PATH}:/opt/homebrew/bin:/usr/local/bin:/usr/local/go/bin"
mkdir -p "$ROOT/dist"
cd "$ROOT"
export CGO_ENABLED=0

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

host_goos="$(detect_goos)"
host_goarch="$(detect_goarch)"
host_target="${host_goos}/${host_goarch}"

if [[ "${1:-}" == "--all" ]]; then
  targets=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64)
else
  : "${WAW_REMOTE_TARGETS:=linux/amd64,windows/amd64,windows/arm64}"
  IFS=',' read -r -a targets <<< "$WAW_REMOTE_TARGETS"
fi

# 本机目标必须产出：宿主与 extras 安装都从 dist/waw-remote-agent[.exe] 取本机用的那份。
if [[ " ${targets[*]} " != *" $host_target "* ]]; then
  targets=("$host_target" "${targets[@]}")
fi

for target in "${targets[@]}"; do
  goos="${target%%/*}"
  goarch="${target##*/}"
  out="dist/waw-remote-agent-${goos}-${goarch}"
  [[ "$goos" == "windows" ]] && out="${out}.exe"
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags='-s -w' -o "$out" .
  echo "built $ROOT/$out"
done

# 历史约定：本机目标的产物同时落成不带后缀的名字 —— smoke / e2e 与宿主的默认
# 路径都按这个名字找。远端上传走带 os/arch 的那份，不读这个。
ext=""
[[ "$host_goos" == "windows" ]] && ext=".exe"
cp -f "dist/waw-remote-agent-${host_goos}-${host_goarch}${ext}" "dist/waw-remote-agent${ext}"
echo "local binary: $ROOT/dist/waw-remote-agent${ext} (${host_target})"
