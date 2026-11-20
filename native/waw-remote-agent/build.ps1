# 构建 strip 后的二进制到 dist/
# Windows 默认 GOOS=windows 产出 dist/waw-remote-agent.exe（本地 stdio/WS 运行）；
# $env:GOOS=linux 交叉构建（无后缀 dist/waw-remote-agent，ssh 远端 scp 使用）。
# 与 build.sh 语义对齐（镜像），build.sh 保留供 POSIX/CI 使用。
$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
# build.sh 同样把 /usr/local/go/bin 补进 PATH；Windows 常见安装目录为 C:\Program Files\Go\bin
$env:PATH = "${env:PATH};C:\Program Files\Go\bin"

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'dist') | Out-Null

if (-not $env:GOOS) { $env:GOOS = if ($IsWindows) { 'windows' } else { 'linux' } }
if (-not $env:GOARCH) { $env:GOARCH = 'amd64' }
$env:CGO_ENABLED = '0'

$Artifact = Join-Path $Root "dist/waw-remote-agent-$($env:GOOS)-$($env:GOARCH)"
if ($env:GOOS -eq 'windows') { $Artifact += '.exe' }
$Final = Join-Path $Root 'dist/waw-remote-agent'
if ($env:GOOS -eq 'windows') { $Final += '.exe' }

Push-Location $Root
try {
    go build -trimpath "-ldflags=-s -w" -o $Artifact .
} finally {
    Pop-Location
}

Copy-Item -Force $Artifact $Final
Write-Host "built $Final"
