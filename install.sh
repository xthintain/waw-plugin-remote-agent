#!/usr/bin/env bash
# 把 remote-agent 插件装进 waw 的插件目录，并按需构建 Go 端二进制。
#
#   ./install.sh              只复制 .mjs 文件
#   ./install.sh --link       软链接（改代码后 reload 即生效）
#   ./install.sh --build      按当前宿主机 OS/arch 构建 Go 二进制
#   ./install.sh --build-all  交叉构建全部平台（linux / darwin / windows × amd64 / arm64）
#
# TUI_CONFIG_DIR 覆盖插件目录（默认 ~/.waw/tui）。桌面版读同一目录，因此装一次
# 两边都可用；桌面的侧栏/设置面板那半端还需要 app 内的组件，见 README。
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest=${TUI_CONFIG_DIR:-$HOME/.waw/tui}/plugins
mode=copy
build=0
build_all=0

for arg in "$@"; do
  case "$arg" in
    --link) mode=link ;;
    --build) build=1 ;;
    --build-all) build_all=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# 运行期文件整组复制：它们互相 import（remote-bridge → remote-os/remote-rpc/
# remote-status，plugin → remote-os，exec → bridge），缺一个就是运行时
# "Cannot find module"。这份清单必须与 scripts/sync-manifest.txt 的 plugin 行一致，
# test/mirror-invariants.test.mjs 会核对。
PLUGIN_FILES=(
  remote-agent.plugin.mjs
  remote-bridge.mjs
  remote-exec.mjs
  remote-os.mjs
  remote-rpc.mjs
  remote-status.mjs
)

# 宿主机目标（= remote-bridge.mjs 的 localTarget）：本机 spawn 用它，build.sh 的不带
# 后缀产物也是它，所以提示里的二进制名按这里算。
case "$(uname -s)" in
  Darwin) host_os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) host_os=windows ;;
  *) host_os=linux ;;
esac
case "$(uname -m)" in
  arm64|aarch64) host_arch=arm64 ;;
  *) host_arch=amd64 ;;
esac
if [ "$host_os" = windows ]; then
  host_ext=.exe
  env_var=WAW_REMOTE_AGENT_WIN_BIN
else
  host_ext=''
  env_var=WAW_REMOTE_AGENT_BIN
fi
dist="$here/native/waw-remote-agent/dist"
data_home=${XDG_DATA_HOME:-$HOME/.local/share}

if [ "$build_all" = 1 ]; then
  "$here/native/waw-remote-agent/build.sh" --all
  echo
  echo "binaries: $dist/"
elif [ "$build" = 1 ]; then
  "$here/native/waw-remote-agent/build.sh"
  echo
  echo "binary: $dist/waw-remote-agent$host_ext"
fi

mkdir -p "$dest"
for f in "${PLUGIN_FILES[@]}"; do
  [ -f "$here/$f" ] || { echo "missing $f" >&2; exit 1; }
  if [ "$mode" = link ]; then ln -sfn "$here/$f" "$dest/$f"; else cp -f "$here/$f" "$dest/$f"; fi
done

# 二进制解析顺序照抄 remote-bridge.mjs 的 localBinary()/binaryNamesFor()：环境变量
# （按目标 os 选 WIN_BIN / BIN）→ dist 里带 os/arch 的名字 → 不带后缀的名字 → extras
# 目录。不带后缀的那份只会是本机目标产物，Windows arm64 上因此不认它。
if [ "$host_os" = windows ]; then
  override=${WAW_REMOTE_AGENT_WIN_BIN:-}
else
  override=${WAW_REMOTE_AGENT_BIN:-}
fi
legacy_ok=1
[ "$host_os" = windows ] && [ "$host_arch" != amd64 ] && legacy_ok=0
names=("waw-remote-agent-$host_os-$host_arch$host_ext")
[ "$legacy_ok" = 1 ] && names+=("waw-remote-agent$host_ext")

candidates=()
[ -n "$override" ] && candidates+=("$override")
for name in "${names[@]}"; do candidates+=("$dist/$name"); done
for name in "${names[@]}"; do candidates+=("$data_home/waw/extras/bin/$name"); done
if [ -n "${WAW_EXTRAS_DIR:-}" ]; then
  for name in "${names[@]}"; do candidates+=("$WAW_EXTRAS_DIR/bin/$name"); done
fi

found=''
for candidate in "${candidates[@]}"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    found=$candidate
    break
  fi
done

if [ -z "$found" ]; then
  echo
  echo "warn: 没找到 $host_os/$host_arch 的 waw-remote-agent。插件会加载成功，但远端功能起不来。" >&2
  echo "      跑 ./install.sh --build（或 --build-all），或设 $env_var。" >&2
else
  echo
  echo "binary: $found"
  case "$found" in
    "$dist"/*)
      # 装好的插件按「目标名 → extras 目录」找二进制，仓库 dist 不在它的搜索路径里
      # （bridge 只认插件目录相对位置与 cwd），所以这里必须把变量交出去。
      echo "      这份在仓库 dist/ 下，装进 $dest 的插件不会去那里找。启用远端前二选一："
      echo "        export $env_var=$found"
      echo "        mkdir -p $data_home/waw/extras/bin && cp \"$found\" $data_home/waw/extras/bin/"
      ;;
  esac
fi

echo
echo "installed into $dest"
echo "reload: /plugins 里 reload remote-agent，或重启 CLI"
