# 构建 strip 后的二进制到 dist/
# 默认按当前宿主机 OS/arch 构建（Windows / macOS / Linux，支持 amd64 与 arm64）；
# 传入 -All 交叉构建全部平台（linux / darwin / windows × amd64 / arm64）；
# 也可通过 $env:GOOS / $env:GOARCH 指定单一目标交叉构建。
# 与 build.sh 语义对齐（镜像），build.sh 保留供 POSIX/CI 使用。
param(
    [switch]$All
)

$ErrorActionPreference = 'Stop'

$Root = $PSScriptRoot
# 补齐 Windows / macOS Homebrew / Linux 常见 Go 安装路径
$sep = [System.IO.Path]::PathSeparator
$extraPaths = if ($IsWindows) {
    @('C:\Program Files\Go\bin')
} else {
    @('/opt/homebrew/bin', '/usr/local/bin', '/usr/local/go/bin')
}
$env:PATH = ($env:PATH, ($extraPaths -join $sep)) -join $sep

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'dist') | Out-Null

function Get-HostGoos {
    if ($IsWindows) { return 'windows' }
    if ($IsMacOS) { return 'darwin' }
    return 'linux'
}

function Get-HostGoarch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    switch ($arch) {
        'arm64' { return 'arm64' }
        'x64'   { return 'amd64' }
        default { return 'amd64' }
    }
}

function Build-One([string]$TargetOs, [string]$TargetArch) {
    $ext = if ($TargetOs -eq 'windows') { '.exe' } else { '' }
    $artifact = Join-Path $Root "dist/waw-remote-agent-${TargetOs}-${TargetArch}${ext}"
    $prevOs = $env:GOOS
    $prevArch = $env:GOARCH
    $prevCgo = $env:CGO_ENABLED
    try {
        $env:GOOS = $TargetOs
        $env:GOARCH = $TargetArch
        $env:CGO_ENABLED = '0'
        Push-Location $Root
        try {
            go build -trimpath "-ldflags=-s -w" -o $artifact .
            if ($LASTEXITCODE -ne 0) { throw "go build failed for ${TargetOs}/${TargetArch}" }
        } finally {
            Pop-Location
        }
    } finally {
        $env:GOOS = $prevOs
        $env:GOARCH = $prevArch
        $env:CGO_ENABLED = $prevCgo
    }
    Write-Host "built $artifact"
    return $artifact
}

$hostOs = Get-HostGoos
$hostArch = Get-HostGoarch

if ($All) {
    $targets = @(
        @('linux', 'amd64'),
        @('linux', 'arm64'),
        @('darwin', 'amd64'),
        @('darwin', 'arm64'),
        @('windows', 'amd64'),
        @('windows', 'arm64')
    )
    foreach ($t in $targets) {
        $null = Build-One $t[0] $t[1]
    }
    $ext = if ($hostOs -eq 'windows') { '.exe' } else { '' }
    $hostArtifact = Join-Path $Root "dist/waw-remote-agent-${hostOs}-${hostArch}${ext}"
    $final = Join-Path $Root "dist/waw-remote-agent${ext}"
    Copy-Item -Force $hostArtifact $final
    Write-Host "default binary: $final (${hostOs}/${hostArch})"
    exit 0
}

$goos = if ($env:GOOS) { $env:GOOS } else { $hostOs }
$goarch = if ($env:GOARCH) { $env:GOARCH } else { $hostArch }
$artifact = Build-One $goos $goarch
$ext = if ($goos -eq 'windows') { '.exe' } else { '' }
$final = Join-Path $Root "dist/waw-remote-agent${ext}"
Copy-Item -Force $artifact $final
Write-Host "built $final"
