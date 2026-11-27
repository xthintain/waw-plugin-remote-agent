# 构建 strip 后的二进制到 dist/（与 build.sh 语义一致）
#
# 默认产出「本机目标」+ linux/amd64 + Windows 的 amd64/arm64：本机目标那份供
# 桌面在本机 spawn / stdio 运行，linux/amd64 与 Windows 两份供 SSH 桥接按探测到的
# 远端目标上传（desktop/agent-desktop/src/plugins/remote-bridge.mjs 的 binaryNamesFor）。
#
#   ./build.ps1                                                  本机目标 + 默认远端矩阵
#   ./build.ps1 -All                                             linux / darwin / windows × amd64 / arm64
#   $env:WAW_REMOTE_TARGETS='darwin/arm64,linux/amd64'; ./build.ps1   显式指定（本机目标始终补入）
#
# dist/waw-remote-agent[.exe]（不带 os/arch）永远是**本机目标**的产物；远端上传走
# waw-remote-agent-<os>-<arch>[.exe]。$env:GOOS / $env:GOARCH 不参与选择目标（与
# build.sh 一致），免得「上一次设过的环境变量」把本机那份悄悄换成别的平台。
param([switch]$All)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
# build.sh 同样把 /usr/local/go/bin 补进 PATH；Windows 常见安装目录为 C:\Program Files\Go\bin
$env:PATH = "${env:PATH};C:\Program Files\Go\bin"

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'dist') | Out-Null
$env:CGO_ENABLED = '0'

# $IsWindows / $IsMacOS 只有 PowerShell 7+ 定义；Windows PowerShell 5.1 下它们是
# $null，直接拿来判断会把 GOOS 判成 linux（历史上就是这么错的）。
function Get-HostGoOS {
  if (Test-Path Variable:\IsWindows) {
    if ($IsWindows) { return 'windows' }
    if ($IsMacOS) { return 'darwin' }
    return 'linux'
  }
  if ($env:OS -eq 'Windows_NT') { return 'windows' }
  return 'linux'
}

function Get-HostGoArch {
  $name = $null
  # PS 5.1 与 7 都有 RuntimeInformation（.NET Framework 4.7.1+ / .NET Core）；
  # 拿不到时退回环境变量（32 位宿主用 PROCESSOR_ARCHITEW6432 看真实架构）。
  try {
    $name = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $name = $null
  }
  if (-not $name) {
    $name = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  if ($name -match '^(Arm64|ARM64|aarch64)$') { return 'arm64' }
  return 'amd64'
}

$hostGoos = Get-HostGoOS
$hostGoarch = Get-HostGoArch
$hostTarget = "$hostGoos/$hostGoarch"

if ($All) {
  $targets = @(
    'linux/amd64', 'linux/arm64',
    'darwin/amd64', 'darwin/arm64',
    'windows/amd64', 'windows/arm64'
  )
} else {
  $spec = if ($env:WAW_REMOTE_TARGETS) { $env:WAW_REMOTE_TARGETS } else { 'linux/amd64,windows/amd64,windows/arm64' }
  $targets = @($spec -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# 本机目标必须产出：宿主与 extras 安装都从 dist/waw-remote-agent[.exe] 取本机用的那份。
if ($targets -notcontains $hostTarget) {
  $targets = @($hostTarget) + $targets
}

$savedGoos = $env:GOOS
$savedGoarch = $env:GOARCH
Push-Location $Root
try {
  foreach ($target in $targets) {
    if ($target -notmatch '^[A-Za-z0-9]+/[A-Za-z0-9]+$') { throw "bad target: $target (expect <os>/<arch>)" }
    $goos, $goarch = $target -split '/'
    $env:GOOS = $goos
    $env:GOARCH = $goarch
    $out = Join-Path $Root "dist/waw-remote-agent-$goos-$goarch"
    if ($goos -eq 'windows') { $out += '.exe' }
    & go build -trimpath '-ldflags=-s -w' -o $out .
    # 原生进程失败不会抛异常（PS 5.1 与 7 默认都只看 $LASTEXITCODE）。
    if ($LASTEXITCODE -ne 0) { throw "go build failed for $target" }
    Write-Host "built $out"
  }
} finally {
  Pop-Location
  $env:GOOS = $savedGoos
  $env:GOARCH = $savedGoarch
}

# 历史约定：本机目标的产物同时落成不带后缀的名字 —— smoke / e2e 与宿主的默认
# 路径都按这个名字找。远端上传走带 os/arch 的那份，不读这个。
$ext = if ($hostGoos -eq 'windows') { '.exe' } else { '' }
$local = Join-Path $Root "dist/waw-remote-agent$ext"
Copy-Item -Force (Join-Path $Root "dist/waw-remote-agent-$hostGoos-$hostGoarch$ext") $local
Write-Host "local binary: $local ($hostTarget)"
