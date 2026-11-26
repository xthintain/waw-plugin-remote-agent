/**
 * Spawn / pool waw-remote-agent and talk RPC.
 *
 * SSH is only used to install + run the Go binary on the remote host
 * (same as agent-service SshRemoteService). User commands go through
 * method "exec" / "read_file" / ….
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 */
export const REQUIRED_PROTOCOL_VERSION = 5

/** @type {Map<string, { key: string, child: import('node:child_process').ChildProcess, rpc: RemoteRpcClient, workspace: string, sshHost: string }>} */
const pool = new Map()

/** @type {Map<string, { home: string, remoteBin: string, os: string, arch: string }>} */
const hostCache = new Map()

/** @type {Map<string, Promise<unknown>>} */
const warmInflight = new Map()

/** Remote helper binaries (codemap, …) uploaded once per host. */
const toolCache = new Map()
const toolInflight = new Map()

const CM_DIR = join(homedir() || tmpdir(), '.waw', 'ssh-cm')

/** Map uname -s / process.platform to Go GOOS values (linux | darwin | windows). */
export function normalizeRemoteOs(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'darwin' || value === 'macos') return 'darwin'
  if (value === 'linux') return 'linux'
  if (
    value === 'win32' ||
    value === 'windows' ||
    value.startsWith('mingw') ||
    value.startsWith('msys') ||
    value.startsWith('cygwin')
  ) {
    return 'windows'
  }
  return ''
}

/** Map uname -m / process.arch to Go GOARCH values (amd64 | arm64). */
export function normalizeRemoteArch(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'amd64'
  return ''
}

/** Current host's Go OS/arch pair (for local pipe spawning and fallback). */
export function hostTargetPlatform(platform = process.platform, arch = process.arch) {
  return {
    os: normalizeRemoteOs(platform) || 'linux',
    arch: normalizeRemoteArch(arch) || 'amd64',
  }
}

/** True for POSIX (/...) or Windows drive (C:\... / C:/...) absolute paths. */
export function isAbsoluteWorkspacePath(raw) {
  const value = String(raw ?? '').trim()
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Resolve the SSH ControlMaster socket directory.
 * macOS caps sockaddr_un.sun_path at 104 bytes (and OpenSSH appends ~17 bytes
 * during bind on top of the 40-char %C hash), so long home paths fail with
 * "path too long for Unix domain socket". Fall back to a short /tmp dir there.
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

function ensureAskpassScript(platform = process.platform) {
  try {
    mkdirSync(CM_DIR, { recursive: true })
  } catch {
    /* */
  }
  // Prints WAW_SSH_ASKPASS_PASS — set only for the ssh/scp child env, not process-wide.
  if (platform === 'win32') {
    const cmdPath = join(CM_DIR, 'askpass.cmd')
    writeFileSync(cmdPath, '@echo off\r\necho %WAW_SSH_ASKPASS_PASS%\r\n', { mode: 0o700 })
    return cmdPath
  }
  const shPath = join(CM_DIR, 'askpass.sh')
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

export function multiplexArgs(platform = process.platform, home = homedir()) {
  // Windows OpenSSH does not support Unix domain socket ControlMaster multiplexing.
  if (platform === 'win32') {
    return ['-o', 'ConnectTimeout=15']
  }
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
export function extrasDirs(
  platform = process.platform,
  env = process.env,
  home = homedir(),
) {
  const dirs = [env.WAW_EXTRAS_DIR?.trim()]
  if (platform === 'darwin') {
    dirs.push(join(home, 'Library', 'Application Support', 'waw', 'extras'))
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA?.trim()) dirs.push(join(env.LOCALAPPDATA.trim(), 'waw', 'extras'))
    if (env.APPDATA?.trim()) dirs.push(join(env.APPDATA.trim(), 'waw', 'extras'))
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share')
  dirs.push(join(dataHome, 'waw', 'extras'))
  return [...new Set(dirs.filter(Boolean))]
}

/**
 * Resolve the local waw-remote-agent binary for a target { os, arch }.
 * Prefers target-qualified `waw-remote-agent-<os>-<arch>[.exe]` so macOS / Windows /
 * Linux hosts can cross-bootstrap any remote OS/arch, then falls back to generic
 * `waw-remote-agent[.exe]`.
 */
export function resolveLocalBinary(
  target,
  {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    home = homedir(),
    cwd = process.cwd(),
    here = dirname(fileURLToPath(import.meta.url)),
    exists = existsSync,
  } = {},
) {
  const configured = env.WAW_REMOTE_AGENT_BIN?.trim()
  if (configured && exists(configured)) return configured

  const fallbackTarget = hostTargetPlatform(platform, arch)
  const targetOs = normalizeRemoteOs(target?.os) || fallbackTarget.os
  const targetArch = normalizeRemoteArch(target?.arch) || fallbackTarget.arch
  const ext = targetOs === 'windows' ? '.exe' : ''
  const qualified = `waw-remote-agent-${targetOs}-${targetArch}${ext}`
  const generic = `waw-remote-agent${ext}`

  // Standalone repo root, monorepo (plugins → agent-desktop → desktop → repo),
  // cwd candidates, and installed extras directories.
  const searchDirs = [
    resolve(here, 'native/waw-remote-agent/dist'),
    resolve(here, '../../../../native/waw-remote-agent/dist'),
    resolve(cwd, 'native/waw-remote-agent/dist'),
    resolve(cwd, '../native/waw-remote-agent/dist'),
    ...extrasDirs(platform, env, home).map((dir) => join(dir, 'bin')),
  ]
  const uniqueDirs = [...new Set(searchDirs)]
  const candidates = [
    ...uniqueDirs.map((dir) => join(dir, qualified)),
    ...uniqueDirs.map((dir) => join(dir, generic)),
  ]
  for (const path of candidates) {
    if (exists(path)) return path
  }
  throw new Error(
    `waw-remote-agent binary missing for ${targetOs}/${targetArch} (set WAW_REMOTE_AGENT_BIN or run ./native/waw-remote-agent/build.sh --all). Tried: ${candidates.join(', ')}`,
  )
}

function localBinary(target) {
  return resolveLocalBinary(target)
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
 * One SSH round-trip: resolve HOME + whether the agent binary is already installed.
 * Cached per host for the process lifetime.
 */
async function resolveHostInstall(sshHost) {
  const cached = hostCache.get(sshHost)
  if (cached) return { ...cached, installed: true }

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
        `home=$(printf %s "$HOME"); bin=${binExpr}; if test -x "$bin"; then st=installed; else st=missing; fi; os=$(uname -s 2>/dev/null || echo linux); arch=$(uname -m 2>/dev/null || echo x86_64); printf '%s${marker}%s${marker}%s${marker}%s\\n' "$home" "$st" "$os" "$arch"`,
      ),
    ])
  ).trim()
  const lastLine = out.split('\n').pop() ?? ''
  const parts = lastLine.split(marker)
  if (parts.length < 2) throw new Error(`cannot resolve remote HOME on ${sshHost}`)
  const [home, status, rawOs = '', rawArch = ''] = parts
  const installed = status === 'installed'
  if (!home.startsWith('/')) throw new Error(`cannot resolve remote HOME on ${sshHost}`)
  const os = normalizeRemoteOs(rawOs) || 'linux'
  const arch = normalizeRemoteArch(rawArch) || 'amd64'
  const remoteBin = configured?.startsWith('/') ? configured : remoteAgentPath(home)
  const info = { home, remoteBin, installed, os, arch }
  if (installed) hostCache.set(sshHost, { home, remoteBin, os, arch })
  return info
}

async function uploadRemoteBinary(sshHost, localBin, remoteBin, remoteHome, remoteOs, remoteArch) {
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
  hostCache.set(sshHost, { home: remoteHome, remoteBin, os: remoteOs, arch: remoteArch })
  return remoteBin
}

async function ensureRemoteBinary(sshHost, { force = false } = {}) {
  const info = await resolveHostInstall(sshHost)
  if (!force && (info.installed || hostCache.has(sshHost))) {
    hostCache.set(sshHost, {
      home: info.home,
      remoteBin: info.remoteBin,
      os: info.os,
      arch: info.arch,
    })
    return info.remoteBin
  }
  const localBin = localBinary({ os: info.os, arch: info.arch })
  return uploadRemoteBinary(sshHost, localBin, info.remoteBin, info.home, info.os, info.arch)
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

async function spawnAgent(sshHost, workspace, token, { forceInstall = false } = {}) {
  if (sshHost === 'local') {
    const localBin = localBinary(hostTargetPlatform())
    return spawn(localBin, ['--workspace', workspace, '--token', token], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  const remoteBin = await ensureRemoteBinary(sshHost, { force: forceInstall })
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
export async function ensureRemoteAgent(target, opts = {}) {
  const sshHost = String(target.sshHost || '').trim()
  const workspace = String(target.root || '').replace(/\/+$/, '') || '/'
  if (!sshHost) throw new Error('sshHost required')
  if (!isAbsoluteWorkspacePath(workspace)) throw new Error('remote workspace must be absolute')

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
    const ver = Number(ping.result?.protocolVersion ?? 0)
    if (sshHost !== 'local' && ver < REQUIRED_PROTOCOL_VERSION && !opts.forceInstall) {
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

/** Fire-and-forget warm so the first user tool call skips cold SSH. */
export function warmRemoteAgent(target) {
  const sshHost = String(target?.sshHost || '').trim()
  const root = String(target?.root || '').replace(/\/+$/, '') || '/'
  if (!sshHost || !isAbsoluteWorkspacePath(root)) return
  const key = poolKey(sshHost, root)
  if (pool.has(key) || warmInflight.has(key)) return
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
  const root = String(target?.root ?? '').replace(/\/+$/, '') || '/'
  if (!sshHost || !isAbsoluteWorkspacePath(root)) {
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
  if (base === '/') return `/${name}`
  return `${base.replace(/\/+$/, '')}/${name}`
}

/** Reuse a live agent only if its workspace contains `path`; else open one at `/`. */
async function agentForBrowse(sshHost, path) {
  for (const conn of pool.values()) {
    if (conn.sshHost !== sshHost) continue
    if (conn.child.killed || conn.child.exitCode != null) continue
    const ws = conn.workspace
    if (ws === '/' || path === ws || path.startsWith(`${ws}/`)) return conn
  }
  return ensureRemoteAgent({ sshHost, root: '/' })
}

/** Browse helpers: HOME via cache/SSH only — no agent spawn just for $HOME. */
export async function remoteHomeDir(sshHost) {
  const cached = hostCache.get(sshHost)
  if (cached?.home) return cached.home
  const info = await resolveHostInstall(sshHost)
  if (info.installed) hostCache.set(sshHost, { home: info.home, remoteBin: info.remoteBin, os: info.os, arch: info.arch })
  return info.home.replace(/\/+$/, '') || '/'
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
  const remote = String(path || '/').replace(/\/+$/, '') || '/'
  if (!remote.startsWith('/')) throw new Error('需要远端绝对路径')
  let conn = await agentForBrowse(sshHost, remote)
  try {
    const resp = await conn.rpc.call('list_dir', { path: remote }, { timeoutMs: 30_000 })
    if (!resp.ok) throw new Error(resp.error ?? 'list failed')
    return mapListEntries(remote, resp.result?.entries)
  } catch (err) {
    if (!isTransportError(err)) throw err
    dropRemoteAgent(conn)
    conn = await agentForBrowse(sshHost, remote)
    const resp = await conn.rpc.call('list_dir', { path: remote }, { timeoutMs: 30_000 })
    if (!resp.ok) throw new Error(resp.error ?? 'list failed')
    return mapListEntries(remote, resp.result?.entries)
  }
}
