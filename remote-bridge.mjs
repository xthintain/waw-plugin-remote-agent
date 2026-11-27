/**
 * Spawn / pool waw-remote-agent and talk RPC.
 *
 * SSH is only used to install + run the Go binary on the remote host
 * (same as agent-service SshRemoteService). User commands go through
 * method "exec" / "read_file" / ….
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PS_PRELUDE,
  browseRoot,
  isAbsoluteRemoteRoot,
  joinRemotePath,
  normalizeArch,
  normalizeDrives,
  normalizeRemoteRoot,
  parsePosixProbe,
  parseWindowsProbe,
  powershellCommand,
  psMkdir,
  psPath,
  psQuote,
  psScript,
  remoteBinName,
  remotePathInside,
  sameRemotePath,
} from './remote-os.mjs'
import { RemoteRpcClient } from './remote-rpc.mjs'
import {
  listRemoteAgentHealth,
  recordRemoteAgentHealth,
  subscribeRemoteAgentHealth,
} from './remote-status.mjs'

const REMOTE_BIN_REL =
  process.env.WAW_REMOTE_AGENT_REMOTE_PATH?.trim() || '.waw/bin/waw-remote-agent'

/**
 * Minimum worker protocol. Older remotes are reinstalled on first use.
 * 4: daemon lifecycle (no worker while the control plane is down; 30m idle
 * reclaim) — bumping also refreshes the binary that hosts the daemon.
 * 5: background jobs (`job_*`) + capability list in `ping`; `mkdir`/`move`
 * removed in favour of `exec`.
 *
 * 6 adds the PowerShell shell on Windows and `os`/`shell`/`capabilities` in
 * `ping`. Only a Windows host needs 6: a POSIX remote keeps working on 5, so
 * this does not force a reinstall of every Linux agent.
 */
export const REQUIRED_PROTOCOL_VERSION = 6
export const POSIX_PROTOCOL_VERSION = 5

/** @type {Map<string, { key: string, child: import('node:child_process').ChildProcess, rpc: RemoteRpcClient, workspace: string, sshHost: string }>} */
const pool = new Map()

/**
 * `drives` lists the mounted drive roots on a Windows host (`C:/`, `D:/`), so the
 * worker can be spawned with every drive allowed and the browser can offer them
 * as top-level entries. POSIX hosts leave it empty.
 *
 * @type {Map<string, { home: string, remoteBin: string, os: 'posix'|'windows', osName: string, arch: string, psExe?: string, installed: boolean, drives: string[] }>} */
const hostCache = new Map()

/** @type {Map<string, Promise<unknown>>} */
const warmInflight = new Map()

/**
 * Opening one (host, workspace) is a shared promise.
 *
 * The bind warms the agent and the first run may ask for the same target a
 * moment later (shell capabilities, or its first tool); without this, both
 * started an SSH worker and one was left orphaned in the pool.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const ensureInflight = new Map()

/** Remote helper binaries (codemap, …) uploaded once per host. */
const toolCache = new Map()
const toolInflight = new Map()

/**
 * Where the SSH ControlMaster sockets live.
 *
 * macOS caps `sockaddr_un.sun_path` at 104 bytes, and OpenSSH adds its own
 * suffix when binding on top of the 40-character `%C` hash — a long home
 * directory pushes `~/.waw/ssh-cm/<hash>` past that and every ssh call fails
 * with "path too long for Unix domain socket". Fall back to a short /tmp path
 * there (the uid keeps two accounts on one machine apart). Linux has no such
 * limit; Windows never asks for a control socket at all.
 */
export function resolveControlMasterDir(platform = process.platform, home = homedir()) {
  const preferred = join(home || tmpdir(), '.waw', 'ssh-cm')
  if (platform === 'darwin' && join(preferred, 'x'.repeat(40)).length > 84) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
    return `/tmp/waw-cm-${uid}`
  }
  return preferred
}

/** In-memory key passphrase (from desktop via tui-host). Never logged. */
let sshPassphrase = ''

/** Push passphrase from the UI so encrypted IdentityFile can unlock under SSH_ASKPASS. */
export function setSshPassphrase(value) {
  sshPassphrase = typeof value === 'string' ? value : ''
}

export function getSshPassphrase() {
  return sshPassphrase
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * ssh always hands the remote command to the *login* shell (`fish -c …`,
 * `zsh -c …`, …). Those shells disagree on POSIX `var=value`. Run the real
 * script under absolute `/bin/sh` so the login shell only has to exec a path
 * (works for bash/zsh/fish/dash/ksh/csh). Script body stays POSIX — no bashisms.
 */
function remoteSh(script) {
  return `/bin/sh -c ${shQuote(script)}`
}

function ensureAskpassScript(platform = process.platform, home = homedir()) {
  const dir = resolveControlMasterDir(platform, home)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* */
  }
  // Prints WAW_SSH_ASKPASS_PASS — set only for the ssh/scp child env, not process-wide.
  // Windows' OpenSSH never runs a `#!/bin/sh` script: it needs a .cmd (or an
  // executable) to read the passphrase back.
  if (platform === 'win32') {
    const cmdPath = join(dir, 'askpass.cmd')
    writeFileSync(cmdPath, '@echo off\r\necho %WAW_SSH_ASKPASS_PASS%\r\n', { mode: 0o700 })
    return cmdPath
  }
  const shPath = join(dir, 'askpass.sh')
  writeFileSync(shPath, '#!/bin/sh\nprintf \'%s\\n\' "$WAW_SSH_ASKPASS_PASS"\n', {
    mode: 0o700,
  })
  return shPath
}

/** Env for ssh/scp: when passphrase is set, force askpass (BatchMode would ignore it). */
function sshChildEnv() {
  const env = { ...process.env }
  if (!sshPassphrase) return env
  env.SSH_ASKPASS = ensureAskpassScript()
  env.SSH_ASKPASS_REQUIRE = 'force'
  env.WAW_SSH_ASKPASS_PASS = sshPassphrase
  // Older OpenSSH only invokes askpass when DISPLAY is set.
  if (!env.DISPLAY) env.DISPLAY = ':0'
  return env
}

/**
 * Multiplex SSH so probe + spawn share one TCP handshake (comfort: cold path).
 *
 * Windows' OpenSSH has no Unix-domain control sockets; asking for one only earns
 * a warning on every call, so the plain connect timeout is the whole list there.
 */
export function multiplexArgs(platform = process.platform, home = homedir()) {
  if (platform === 'win32') return ['-o', 'ConnectTimeout=15']
  const cmDir = resolveControlMasterDir(platform, home)
  try {
    mkdirSync(cmDir, { recursive: true, mode: 0o700 })
  } catch {
    /* */
  }
  return [
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${cmDir}/%C`,
    '-o',
    'ControlPersist=120',
  ]
}

function sshBaseArgs() {
  // Multiplex SSH so probe + spawn share one TCP handshake (comfort: cold path).
  const args = ['-T', ...multiplexArgs()]
  if (sshPassphrase) {
    // Drop BatchMode so SSH_ASKPASS can unlock an encrypted private key.
    // Stay on publickey only — never hang waiting for an interactive password.
    args.push(
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
    )
  } else {
    args.push('-o', 'BatchMode=yes')
  }
  return args
}

function scpBaseArgs() {
  const args = [...multiplexArgs()]
  if (sshPassphrase) {
    args.push(
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
    )
  } else {
    args.push('-o', 'BatchMode=yes')
  }
  return args
}

/**
 * Directories installed beside the app bundle (`scripts/install-extras.mjs`).
 * This file is copied there too, so the checkout-relative candidates below do
 * not exist in an installed app.
 */
function extrasDirs() {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return [process.env.WAW_EXTRAS_DIR?.trim(), join(dataHome, 'waw', 'extras')].filter(Boolean)
}

function sha8(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
}

/** Node's own platform/arch, spelled the way Go's GOOS/GOARCH are. */
const NODE_OS = { linux: 'linux', darwin: 'darwin', win32: 'windows' }
const NODE_ARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }
const localTarget = { osName: NODE_OS[process.platform] ?? process.platform, arch: NODE_ARCH[process.arch] ?? process.arch }

/**
 * Candidate file names for a remote target, most specific first.
 *
 * Extracted from `localBinary` so the name choice is testable without touching
 * the disk: dropping the arch from a name silently uploads a binary the host
 * cannot execute, and that is the kind of mistake a test has to catch.
 *
 * `local` describes this desktop's own build (the unversioned `waw-remote-agent`
 * file is only ever that build; it is never offered to a different target).
 */
function targetOf(os, info = {}, local = localTarget) {
  return {
    arch: normalizeArch(info.arch) || local.arch,
    osName: os === 'windows' ? 'windows' : info.osName || local.osName,
  }
}

export function binaryNamesFor(os = 'posix', info = {}, local = localTarget) {
  const { arch, osName } = targetOf(os, info, local)
  const names = []
  if (os === 'windows') {
    names.push(`waw-remote-agent-windows-${arch}.exe`)
    // A Windows desktop's own unversioned build is amd64; never hand it to an
    // arm64 host.
    if (arch === 'amd64') names.push('waw-remote-agent.exe')
  } else {
    names.push(`waw-remote-agent-${osName}-${arch}`)
    if (osName === local.osName && arch === local.arch) names.push('waw-remote-agent')
  }
  return [...new Set(names)]
}

/**
 * The local binary to upload for a remote of `os` — NOT the host's own binary.
 *
 * The target comes from what the probe found (`info.osName` / `info.arch`), so a
 * Windows arm64 laptop gets the arm64 `.exe` and nothing is assumed to be amd64.
 * `WAW_REMOTE_AGENT_BIN` overrides POSIX, `WAW_REMOTE_AGENT_WIN_BIN` Windows.
 */
function localBinary(os = 'posix', info = {}) {
  const override =
    os === 'windows'
      ? process.env.WAW_REMOTE_AGENT_WIN_BIN?.trim()
      : process.env.WAW_REMOTE_AGENT_BIN?.trim()
  if (override && existsSync(override)) return override
  const { osName, arch } = targetOf(os, info)
  const names = binaryNamesFor(os, info)
  const here = dirname(fileURLToPath(import.meta.url))
  const dist = (name) => [
    resolve(here, `../../../../native/waw-remote-agent/dist/${name}`),
    resolve(process.cwd(), `native/waw-remote-agent/dist/${name}`),
    resolve(process.cwd(), `../native/waw-remote-agent/dist/${name}`),
  ]
  const candidates = [
    ...names.flatMap((name) => dist(name)),
    ...extrasDirs().flatMap((dir) => names.map((name) => join(dir, 'bin', name))),
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  throw new Error(
    `waw-remote-agent binary for ${osName}/${arch} missing (set ${
      os === 'windows' ? 'WAW_REMOTE_AGENT_WIN_BIN' : 'WAW_REMOTE_AGENT_BIN'
    } or build it with WAW_REMOTE_TARGETS=${osName}/${arch}). Tried: ${candidates.join(', ')}`,
  )
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: sshChildEnv(),
      ...opts,
    })
    const out = []
    const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString('utf8'))
      else {
        reject(
          new Error(
            `${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').trim() || Buffer.concat(out).toString('utf8')}`,
          ),
        )
      }
    })
  })
}

function remoteAgentPath(home) {
  const configured = process.env.WAW_REMOTE_AGENT_REMOTE_PATH?.trim()
  if (configured?.startsWith('/')) return configured
  const rel = (configured || REMOTE_BIN_REL).replace(/^~\/?/, '')
  return `${home.replace(/\/+$/, '')}/${rel}`
}

/**
 * POSIX probe: HOME, whether the fixed-name agent is executable, and the remote
 * OS/arch so the upload can pick a matching build instead of assuming this
 * desktop's own.
 */
async function probePosixHost(sshHost) {
  const marker = '__WAW__'
  const configured = process.env.WAW_REMOTE_AGENT_REMOTE_PATH?.trim()
  const binExpr = configured?.startsWith('/')
    ? shQuote(configured)
    : '"$home/.waw/bin/waw-remote-agent"'
  const out = (
    await run('ssh', [
      ...sshBaseArgs(),
      sshHost,
      remoteSh(
        `home=$(printf %s "$HOME"); bin=${binExpr}; if test -x "$bin"; then st=installed; else st=missing; fi;` +
          ` printf '%s${marker}%s${marker}%s${marker}%s\\n' "$home" "$st" "$(uname -s)" "$(uname -m)"`,
      ),
    ])
  ).trim()
  const parsed = parsePosixProbe(out)
  if (!parsed) throw new Error(`cannot resolve remote HOME on ${sshHost}`)
  const { home, installed, osName, arch } = parsed
  const remoteBin = configured?.startsWith('/') ? configured : remoteAgentPath(home)
  return { home, remoteBin, os: 'posix', installed, drives: [], osName, arch }
}

/**
 * Windows probe: USERPROFILE, CPU arch, the agent builds already in `.waw/bin`,
 * and the mounted drives.
 *
 * The binary name carries the target arch and the local content hash. Windows
 * holds a lock on a running executable and refuses both overwrite and rename,
 * so a new build is uploaded beside the old one and spawn picks the new name —
 * "installed" therefore means "this exact build is there", not "some agent is
 * there". The probe lists what IS there and the bridge compares, because the
 * expected name depends on the arch this same answer reports.
 *
 * Drives are part of the same round-trip because a Windows host is one root per
 * drive: without them the worker is fenced to its workspace drive and the
 * browser cannot look at another one ("path outside allowed roots").
 *
 * `powershell` is tried first and `pwsh` only if the host refuses it, so a
 * stock Windows pays one round-trip and a 5.1-less image still works.
 */
async function probeWindowsHost(sshHost) {
  const script =
    `$wawHome = $env:USERPROFILE\n` +
    `Write-Output ('__WAWHOME__' + $wawHome)\n` +
    `Write-Output ('__WAWARCH__' + $env:PROCESSOR_ARCHITECTURE)\n` +
    `$wawBinDir = Join-Path $wawHome '.waw\\bin'\n` +
    `if (Test-Path -LiteralPath $wawBinDir) {\n` +
    `  Get-ChildItem -LiteralPath $wawBinDir -Filter 'waw-remote-agent-*.exe' -ErrorAction SilentlyContinue |` +
    ` ForEach-Object { Write-Output ('__WAWBIN__' + $_.Name) }\n` +
    `}\n` +
    `foreach ($d in [IO.DriveInfo]::GetDrives()) {\n` +
    `  if ($d.IsReady) { Write-Output ('__WAWDRIVE__' + $d.Name + '|' + $d.VolumeLabel) }\n` +
    `}\n`
  let psExe = 'powershell'
  let out
  try {
    out = await run('ssh', [...sshBaseArgs(), sshHost, psScript(script, psExe)])
  } catch (err) {
    psExe = 'pwsh'
    try {
      out = await run('ssh', [...sshBaseArgs(), sshHost, psScript(script, psExe)])
    } catch {
      throw err
    }
  }
  const parsed = parseWindowsProbe(out)
  if (!parsed) throw new Error(`cannot resolve remote HOME on ${sshHost} (PowerShell probe)`)
  const { home, arch } = parsed
  if (!arch) throw new Error(`cannot determine CPU architecture on ${sshHost} (PowerShell probe)`)
  const localBin = localBinary('windows', { arch })
  const name = remoteBinName('windows', sha8(localBin), arch)
  const installed = parsed.bins.includes(name)
  // A host that answered the probe but enumerated nothing still has the drive
  // its HOME lives on; never leave the browser with an empty drive list.
  const drives = parsed.drives.length > 0 ? parsed.drives : normalizeDrives([`${home.slice(0, 2)}/`])
  return {
    home,
    remoteBin: joinRemotePath(home, `.waw/bin/${name}`),
    os: 'windows',
    osName: 'windows',
    arch,
    psExe,
    installed,
    drives,
  }
}

/**
 * One SSH round-trip: resolve HOME + OS + whether the agent build is installed.
 * Cached per host for the process lifetime.
 *
 * The POSIX probe runs first, so a Linux remote pays one round-trip. Only when
 * it fails (a Windows host answers cmd.exe's "The system cannot find the path
 * specified.") does the PowerShell probe run.
 */
async function resolveHostInstall(sshHost) {
  const cached = hostCache.get(sshHost)
  if (cached) return { ...cached }
  const forced = process.env.WAW_REMOTE_OS?.trim().toLowerCase()
  if (forced === 'windows') {
    const info = await probeWindowsHost(sshHost)
    hostCache.set(sshHost, info)
    return info
  }
  try {
    const info = await probePosixHost(sshHost)
    hostCache.set(sshHost, info)
    return info
  } catch (err) {
    if (forced === 'posix') throw err
    const info = await probeWindowsHost(sshHost)
    hostCache.set(sshHost, info)
    return info
  }
}

async function uploadRemoteBinary(sshHost, localBin, info) {
  const { remoteBin, home: remoteHome, os, psExe = 'powershell' } = info
  if (os === 'windows') {
    const remoteDir = remoteBin.replace(/\/[^/]+$/, '')
    const fileName = remoteBin.slice(remoteBin.lastIndexOf('/') + 1)
    const remoteTmp = `${remoteDir}/${fileName}.tmp`
    try {
      await run('ssh', [
        ...sshBaseArgs(),
        sshHost,
        psScript(psMkdir(psPath(remoteDir)), psExe),
      ])
      // scp resolves a relative target against the login user's home on both
      // OpenSSH builds; an absolute drive path is not portable there.
      await run('scp', [...scpBaseArgs(), localBin, `${sshHost}:.waw/bin/${fileName}.tmp`])
      await run('ssh', [
        ...sshBaseArgs(),
        sshHost,
        psScript(
          `Move-Item -LiteralPath ${psQuote(psPath(remoteTmp))} ` +
            `-Destination ${psQuote(psPath(remoteBin))} -Force`,
          psExe,
        ),
      ])
    } catch {
      throw new Error(
        `remote agent on ${sshHost} is unavailable (install/refresh failed; user command was not run). Retry once; do not diagnose upload tools or remote bin paths.`,
      )
    }
    hostCache.set(sshHost, { ...info, installed: true })
    return remoteBin
  }

  const remoteDir = remoteBin.replace(/\/[^/]+$/, '') || `${remoteHome}/.waw/bin`
  // Upload to a sibling then mv: Linux refuses to open() a running executable for
  // truncate (ETXTBSY). Rename replaces the path while the old inode keeps serving.
  const remoteTmp = `${remoteBin}.new`
  try {
    await run('ssh', [...sshBaseArgs(), sshHost, remoteSh(`mkdir -p ${shQuote(remoteDir)}`)])
    await run('scp', [...scpBaseArgs(), localBin, `${sshHost}:${remoteTmp}`])
    await run('ssh', [
      ...sshBaseArgs(),
      sshHost,
      remoteSh(
        `chmod +x ${shQuote(remoteTmp)} && mv -f ${shQuote(remoteTmp)} ${shQuote(remoteBin)}`,
      ),
    ])
  } catch {
    // Never leak scp/ssh wire text into tool results — models treat it as the
    // user command failing and invent mkdir/permission rituals.
    throw new Error(
      `remote agent on ${sshHost} is unavailable (install/refresh failed; user command was not run). Retry once; do not diagnose upload tools or remote bin paths.`,
    )
  }
  hostCache.set(sshHost, { ...info, installed: true })
  return remoteBin
}

async function ensureRemoteBinary(sshHost, localBin, { force = false } = {}) {
  const info = await resolveHostInstall(sshHost)
  if (!force && info.installed) return info.remoteBin
  return uploadRemoteBinary(sshHost, localBin, info)
}

/**
 * Ensure a helper binary (currently codemap) exists on the remote host.
 *
 * The agent ships these tools; the remote machine must not need them on PATH.
 * Upload once per host into `~/.waw/bin/<name>` and reuse the absolute path.
 * `local` targets use the local binary directly.
 */
export async function ensureRemoteTool(sshHost, localPath, name) {
  const host = String(sshHost || '').trim()
  if (!host) throw new Error('sshHost required')
  if (host === 'local') return localPath
  const key = `${host}\0${name}`
  const cached = toolCache.get(key)
  if (cached) return cached
  const inflight = toolInflight.get(key)
  if (inflight) return inflight

  const job = (async () => {
    const info = await resolveHostInstall(host)
    if (info.os === 'windows') {
      throw new Error(
        `远端 ${name} 在 Windows 主机上尚不支持（随包发布的是 POSIX 构建）；请改用本地工作区或只对远端做文件/命令操作`,
      )
    }
    const remoteDir = `${info.home.replace(/\/+$/, '')}/.waw/bin`
    const remotePath = `${remoteDir}/${name}`
    const localSize = statSync(localPath).size
    const out = await run('ssh', [
      ...sshBaseArgs(),
      host,
      remoteSh(
        `if test -x ${shQuote(remotePath)}; then wc -c < ${shQuote(remotePath)}; else echo missing; fi`,
      ),
    ])
    const lastLine = out.trim().split('\n').pop()?.trim() ?? ''
    const remoteSize = /^\d+$/.test(lastLine) ? Number(lastLine) : -1
    if (remoteSize !== localSize) {
      const remoteTmp = `${remotePath}.new`
      await run('ssh', [...sshBaseArgs(), host, remoteSh(`mkdir -p ${shQuote(remoteDir)}`)])
      await run('scp', [...scpBaseArgs(), localPath, `${host}:${remoteTmp}`])
      await run('ssh', [
        ...sshBaseArgs(),
        host,
        remoteSh(
          `chmod +x ${shQuote(remoteTmp)} && mv -f ${shQuote(remoteTmp)} ${shQuote(remotePath)}`,
        ),
      ])
    }
    toolCache.set(key, remotePath)
    return remotePath
  })().finally(() => {
    toolInflight.delete(key)
  })
  toolInflight.set(key, job)
  return job
}

/** Drop a dead pooled connection so the next ensure spawns fresh. */
export function dropRemoteAgent(conn) {
  if (!conn) return
  const key = conn.key || poolKey(conn.sshHost, conn.workspace)
  if (pool.get(key) === conn) pool.delete(key)
  try {
    conn.rpc.close()
  } catch {
    /* */
  }
  if (conn.child && !conn.child.killed) {
    try {
      conn.child.kill('SIGTERM')
    } catch {
      /* */
    }
  }
}

function isTransportError(err) {
  const msg = err instanceof Error ? err.message : String(err || '')
  return /stdout ended|remote rpc closed|EPIPE|ECONNRESET|write after end|broken pipe/i.test(msg)
}

function poolKey(sshHost, workspace) {
  return `${sshHost}\0${workspace}`
}

/**
 * The shells this host's agent reported, stored where the host-side prompt and
 * snapshot tracker read them synchronously. Same process, same global store
 * convention as `__wawSessionWorkspaces` — the bridge is a runtime-loaded
 * plugin and cannot import the host's TypeScript.
 */
function recordShellCapabilities(sshHost, result) {
  const info = result && typeof result === 'object' ? result : {}
  const os = info.os === 'windows' ? 'windows' : 'posix'
  const shells = Array.isArray(info.shells)
    ? info.shells.map(String)
    : info.shell
      ? [String(info.shell)]
      : []
  const caps = {
    os,
    defaultShell: String(info.shell ?? ''),
    shells,
    posixShell: String(info.posixShell ?? ''),
    // An older worker has no capabilities field; on POSIX it is the only shell,
    // so the POSIX scripts run there by definition.
    posixScripts: info.capabilities ? Boolean(info.capabilities.posixScripts) : os === 'posix',
  }
  globalThis.__wawRemoteCapabilities = globalThis.__wawRemoteCapabilities || {}
  globalThis.__wawRemoteCapabilities[sshHost] = caps
}

async function spawnAgent(sshHost, workspace, token, { forceInstall = false } = {}) {
  if (sshHost === 'local') {
    // `local` means the machine the app runs on, so its own target decides.
    return spawn(
      localBinary(process.platform === 'win32' ? 'windows' : 'posix', localTarget),
      ['--workspace', workspace, '--token', token],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
  }
  const info = await resolveHostInstall(sshHost)
  const remoteBin = await ensureRemoteBinary(sshHost, localBinary(info.os, info), {
    force: forceInstall,
  })
  if (info.os === 'windows') {
    // PowerShell is the parent of the worker here: `&` runs the exe in this
    // console, so the RPC frames on stdin/stdout pass straight through. The
    // path and workspace are quoted for PowerShell, not the POSIX shell.
    //
    // Every mounted drive is an explicit root: the worker fences paths to
    // `--workspace` + `--root`, and a Windows host keeps each drive as its own
    // root, so without these the browser could never open `D:/…`.
    const extraRoots = (info.drives ?? [])
      .filter((drive) => !sameRemotePath(drive, workspace, 'windows'))
      .map((drive) => ` --root ${psQuote(drive)}`)
      .join('')
    const remoteCmd =
      `& ${psQuote(remoteBin)} --workspace ${psQuote(workspace)} --token ${psQuote(token)}${extraRoots}`
    return spawn(
      'ssh',
      [...sshBaseArgs(), sshHost, powershellCommand(`${PS_PRELUDE}${remoteCmd}\n`, info.psExe)],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: sshChildEnv(),
      },
    )
  }
  const remoteCmd = `${shQuote(remoteBin)} --workspace ${shQuote(workspace)} --token ${shQuote(token)}`
  return spawn('ssh', [...sshBaseArgs(), sshHost, remoteSh(remoteCmd)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: sshChildEnv(),
  })
}

/**
 * @param {{ sshHost: string, root: string }} target
 * @param {{ forceInstall?: boolean }} [opts]
 */
export function ensureRemoteAgent(target, opts = {}) {
  const sshHost = String(target?.sshHost || '').trim()
  const workspace = normalizeRemoteRoot(target?.root)
  if (!sshHost) return Promise.reject(new Error('sshHost required'))
  if (!isAbsoluteRemoteRoot(workspace)) {
    return Promise.reject(new Error('remote workspace must be absolute'))
  }
  const key = poolKey(sshHost, workspace)
  if (!opts.forceInstall) {
    const running = ensureInflight.get(key)
    if (running) return running
  }
  const job = openRemoteAgent(target, opts).finally(() => {
    if (ensureInflight.get(key) === job) ensureInflight.delete(key)
  })
  ensureInflight.set(key, job)
  return job
}

async function openRemoteAgent(target, opts = {}) {
  const sshHost = String(target.sshHost || '').trim()
  const workspace = normalizeRemoteRoot(target.root)
  if (!sshHost) throw new Error('sshHost required')
  if (!isAbsoluteRemoteRoot(workspace)) throw new Error('remote workspace must be absolute')

  const key = poolKey(sshHost, workspace)
  const healthTarget = { sshHost, root: workspace }
  const existing = pool.get(key)
  if (!opts.forceInstall && existing && !existing.child.killed && existing.child.exitCode == null) {
    // A live pooled pipe is the healthiest answer there is; record it so a
    // previous error does not outlive the reconnect that fixed it.
    recordRemoteAgentHealth(healthTarget, 'ok')
    return existing
  }
  if (existing) {
    dropRemoteAgent(existing)
  }

  try {
    const token = randomBytes(24).toString('hex')
    const child = await spawnAgent(sshHost, workspace, token, {
      forceInstall: Boolean(opts.forceInstall),
    })
    const rpc = new RemoteRpcClient(child.stdin, child.stdout, token)
    const conn = { key, child, rpc, workspace, sshHost }
    pool.set(key, conn)

    child.on('exit', (code, signal) => {
      // `dropRemoteAgent` / `disconnectRemoteAgent` remove the conn from the
      // pool BEFORE killing it, so "still pooled here" means it died on its
      // own — that is the failure the sidebar should show, not a teardown.
      const unexpected = pool.get(key) === conn
      if (unexpected) pool.delete(key)
      try {
        rpc.close()
      } catch {
        /* */
      }
      if (unexpected) {
        recordRemoteAgentHealth(
          healthTarget,
          'error',
          `远端 agent 已退出（${signal ?? code ?? 'unknown'}）`,
        )
      }
    })
    child.stderr?.on('data', () => {
      /* keep pipe drained; errors surface on ping/call */
    })

    const ping = await rpc.call('ping', {}, { timeoutMs: 20_000 })
    if (!ping.ok) {
      dropRemoteAgent(conn)
      throw new Error(ping.error ?? 'remote agent ping failed')
    }
    recordShellCapabilities(sshHost, ping.result)
    const ver = Number(ping.result?.protocolVersion ?? 0)
    const cachedOs = hostCache.get(sshHost)?.os
    const reportedOs = ping.result?.os === 'windows' ? 'windows' : cachedOs ?? 'posix'
    const required = reportedOs === 'windows' ? REQUIRED_PROTOCOL_VERSION : POSIX_PROTOCOL_VERSION
    if (sshHost !== 'local' && ver < required && !opts.forceInstall) {
      dropRemoteAgent(conn)
      hostCache.delete(sshHost)
      return await ensureRemoteAgent(target, { forceInstall: true })
    }
    recordRemoteAgentHealth(healthTarget, 'ok')
    return conn
  } catch (err) {
    recordRemoteAgentHealth(healthTarget, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

/**
 * Run `fn(conn)` with one silent reconnect if the pipe died before/during the call.
 * Business RPC errors (ok:false) are not retried.
 */
export async function withRemoteAgent(target, fn) {
  let conn = await ensureRemoteAgent(target)
  try {
    return await fn(conn)
  } catch (err) {
    if (!isTransportError(err)) throw err
    dropRemoteAgent(conn)
    conn = await ensureRemoteAgent(target)
    return fn(conn)
  }
}

/**
 * The shells a target's agent reported, waiting out an in-flight warm.
 *
 * The host records capabilities when the agent answers `ping`. A run that
 * starts right after a bind can beat that ping: the workspace snapshot then
 * cannot tell whether the Windows host has Git Bash, and skipping the scripts
 * would silently lose the run-level diff. Awaiting the warm (or opening the
 * agent once) makes the answer deterministic for the first run too.
 */
export async function remoteShellCapabilities(target) {
  const sshHost = String(target?.sshHost ?? '').trim()
  const root = normalizeRemoteRoot(target?.root)
  if (!sshHost || !isAbsoluteRemoteRoot(root)) return null
  const cached = () => globalThis.__wawRemoteCapabilities?.[sshHost] ?? null
  if (cached()) return cached()
  const warm = warmInflight.get(poolKey(sshHost, root))
  try {
    if (warm) await warm
    else await ensureRemoteAgent({ sshHost, root })
  } catch {
    /* unknown stays unknown; the caller degrades rather than guessing */
  }
  return cached()
}

/** Fire-and-forget warm so the first user tool call skips cold SSH. */
export function warmRemoteAgent(target) {
  const sshHost = String(target?.sshHost || '').trim()
  const root = normalizeRemoteRoot(target?.root)
  if (!sshHost || !isAbsoluteRemoteRoot(root)) return
  const key = poolKey(sshHost, root)
  if (pool.has(key) || warmInflight.has(key) || ensureInflight.has(key)) return
  const job = ensureRemoteAgent({ sshHost, root })
    .catch(() => undefined)
    .finally(() => {
      warmInflight.delete(key)
    })
  warmInflight.set(key, job)
}

/** @type {Map<string, Promise<object>>} */
const probeInflight = new Map()

/**
 * Open (or reuse) the remote agent for one workspace and report its health.
 *
 * This is what "the sidebar row is expanded" asks for: the same work
 * `POST /workspace` already does when a conversation binds a remote root, made
 * observable. It never throws and never reports a stale answer — concurrent
 * probes for one target share a single SSH handshake, and a timeout still
 * records the failure (a later success overwrites it through the normal path).
 */
export async function probeRemoteAgent(target, { timeoutMs = 25_000 } = {}) {
  const sshHost = String(target?.sshHost ?? '').trim()
  const root = normalizeRemoteRoot(target?.root)
  if (!sshHost || !isAbsoluteRemoteRoot(root)) {
    return {
      sshHost,
      root,
      state: 'error',
      error: 'remote workspace must be absolute',
      at: Date.now(),
    }
  }
  const norm = { sshHost, root }
  const key = poolKey(sshHost, root)
  const running = probeInflight.get(key)
  if (running) return running

  const job = (async () => {
    let timer
    try {
      await Promise.race([
        ensureRemoteAgent(norm),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`远端探测超时（${Math.round(timeoutMs / 1000)}s）`)),
            timeoutMs,
          )
          timer.unref?.()
        }),
      ])
      return recordRemoteAgentHealth(norm, 'ok')
    } catch (err) {
      return recordRemoteAgentHealth(
        norm,
        'error',
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      clearTimeout(timer)
    }
  })().finally(() => {
    probeInflight.delete(key)
  })

  probeInflight.set(key, job)
  return job
}

/** Cached health of every remote workspace this process has touched. */
export function remoteAgentStatuses() {
  return listRemoteAgentHealth()
}

/** Subscribe to health changes (the host contract's `onRemoteAgentState`). */
export function onRemoteAgentState(listener) {
  return subscribeRemoteAgentHealth(listener)
}

export async function disconnectRemoteAgent(sshHost, workspace) {
  const key = poolKey(sshHost, workspace)
  const conn = pool.get(key)
  if (!conn) return
  pool.delete(key)
  try {
    await conn.rpc.call('shutdown', {}, { timeoutMs: 2_000 })
  } catch {
    /* */
  }
  conn.rpc.close()
  if (!conn.child.killed) conn.child.kill('SIGTERM')
}

export async function disconnectAllRemoteAgents() {
  for (const conn of [...pool.values()]) {
    await disconnectRemoteAgent(conn.sshHost, conn.workspace)
  }
}

function joinRemote(base, name) {
  return joinRemotePath(base, name)
}

/**
 * Reuse a live agent only if its workspace contains `path`; else open one at the
 * browse root (`/` on POSIX, the HOME drive on Windows — a drive root is the
 * only place the worker's path fence lets a browse-only agent look at).
 */
async function agentForBrowse(sshHost, path, info) {
  const within = (root) => remotePathInside(root, path, info.os)
  for (const conn of pool.values()) {
    if (conn.sshHost !== sshHost) continue
    if (conn.child.killed || conn.child.exitCode != null) continue
    // Every Windows worker is spawned with all drives as roots, so a pooled one
    // can list any drive — not only the workspace it was opened for.
    const extra = info.os === 'windows' ? (info.drives ?? []) : []
    if (within(conn.workspace) || extra.some(within)) return conn
  }
  return ensureRemoteAgent({ sshHost, root: browseRoot(info.os, info) })
}

/**
 * Mounted drives of a remote host, for the directory browser's drive switcher.
 *
 * POSIX hosts are one tree from `/`, so they have no entries here. Windows hosts
 * answer with `[{ name: 'C:', path: 'C:/' }, …]`; the browser opens `<path>` and
 * the breadcrumb restarts at that drive.
 */
export async function remoteDrives(sshHost) {
  const host = String(sshHost || '').trim()
  if (!host) return []
  const info = await resolveHostInstall(host)
  if (info.os !== 'windows') return []
  return (info.drives ?? []).map((path) => ({ name: path.replace(/\/$/, ''), path }))
}

/** Browse helpers: HOME via cache/SSH only — no agent spawn just for $HOME. */
export async function remoteHomeDir(sshHost) {
  const cached = hostCache.get(sshHost)
  if (cached?.home) return cached.home
  const info = await resolveHostInstall(sshHost)
  return normalizeRemoteRoot(info.home)
}

function mapListEntries(remote, raw) {
  const entries = (Array.isArray(raw) ? raw : [])
    .map((e) => {
      const name = String(e?.name ?? '')
      if (!name || name === '.' || name === '..' || name.startsWith('.')) return null
      return {
        name,
        path: joinRemote(remote, name),
        isDir: Boolean(e?.isDir),
        size: e?.size,
        modTime: e?.modTime,
      }
    })
    .filter(Boolean)
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

export async function listRemoteDirectory(sshHost, path) {
  const info = await resolveHostInstall(sshHost)
  const asked = String(path ?? '').trim()
  const remote = asked ? normalizeRemoteRoot(asked) : browseRoot(info.os, info)
  if (!isAbsoluteRemoteRoot(remote)) throw new Error('需要远端绝对路径')
  let conn = await agentForBrowse(sshHost, remote, info)
  try {
    const resp = await conn.rpc.call('list_dir', { path: remote }, { timeoutMs: 30_000 })
    if (!resp.ok) throw new Error(resp.error ?? 'list failed')
    return mapListEntries(remote, resp.result?.entries)
  } catch (err) {
    if (!isTransportError(err)) throw err
    dropRemoteAgent(conn)
    conn = await agentForBrowse(sshHost, remote, info)
    const resp = await conn.rpc.call('list_dir', { path: remote }, { timeoutMs: 30_000 })
    if (!resp.ok) throw new Error(resp.error ?? 'list failed')
    return mapListEntries(remote, resp.result?.entries)
  }
}
