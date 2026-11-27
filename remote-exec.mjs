/**
 * The SSH transport for workspace-scoped tools.
 *
 * The kernel owns WHICH tools run remotely (each tool's `scope` + its adapter
 * table) and how a result is shaped. This file only supplies the primitives
 * those adapters call: exec, file I/O, and background jobs over the Go agent's
 * RPC. It used to hold the routing table itself — a hardcoded name set that
 * silently ran any newly added tool on the wrong machine.
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { logger } from './remote-logger.mjs'
import {
  assertModeAllowsTarget,
  getAgentMode,
  disconnectAllRemoteAgents,
  ensureRemoteTool,
  isAbsoluteWorkspacePath,
  shQuote,
  withRemoteAgent,
} from './remote-bridge.mjs'

/** Strip transport/bootstrap noise so the model never sees scp/ssh install text. */
function sanitizeRemoteError(msg) {
  const text = String(msg || '')
  if (/scp\b|dest open|ETXTBSY|waw-remote-agent\.new|failed to upload file/i.test(text)) {
    return 'remote agent unavailable (bootstrap). User command was not run. Retry once; do not diagnose upload or remote bin paths.'
  }
  return text
}

/**
 * The remote workspace of ONE conversation.
 *
 * A process-global single value used to make every conversation share whichever
 * root was posted last; a local conversation posting an empty workspace cleared
 * a remote run's binding mid-turn. The host now files bindings per session (see
 * tui/src/agent/session-workspace.ts), and the tool call carries the session.
 */
export function normalizeWorkspaceTarget(value) {
  if (!value || typeof value !== 'object') return null
  if (!isAbsoluteWorkspacePath(value.root)) return null
  if (value.kind === 'local') {
    return { ...value, sshHost: 'local' }
  }
  if (value.kind === 'remote' && String(value.sshHost || '').trim()) {
    return value
  }
  return null
}

export function activeWorkspace(sessionId) {
  const map = globalThis.__wawSessionWorkspaces
  if (!map || typeof map !== 'object') return null
  const key = String(sessionId ?? '').trim()
  const value = map[key === 'new' ? '' : key]
  return normalizeWorkspaceTarget(value)
}

/** Map model cwd (often "." / relative) onto the remote workspace root. */
export function resolveRemoteCwd(wsRoot, cwd) {
  const root = String(wsRoot || '/').replace(/\/+$/, '') || '/'
  if (cwd == null || cwd === '' || cwd === '.' || cwd === './') return root
  const raw = String(cwd)
  if (isAbsoluteWorkspacePath(raw)) return raw.replace(/[\\/]+$/, '') || '/'
  const base = root === '/' ? '' : root
  return `${base}/${raw.replace(/^\.\//, '')}`.replace(/\/+$/, '') || '/'
}

async function rpc(ws, method, params, opts = {}) {
  const startedAt = Date.now()
  try {
    const result = await withRemoteAgent(ws, async (conn) => {
      const resp = await conn.rpc.call(method, params, {
        timeoutMs: opts.timeoutMs ?? 30_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      if (!resp.ok) throw new Error(resp.error ?? `${method} failed`)
      return resp.result ?? {}
    })
    logger.info('exec', 'rpc.ok', {
      mode: getAgentMode(),
      sshHost: ws.sshHost,
      method,
      durationMs: Date.now() - startedAt,
    })
    return result
  } catch (err) {
    const sanitized = sanitizeRemoteError(err instanceof Error ? err.message : String(err))
    logger.error('exec', 'rpc.error', {
      mode: getAgentMode(),
      sshHost: ws.sshHost,
      method,
      durationMs: Date.now() - startedAt,
      error: sanitized,
    })
    throw new Error(sanitized)
  }
}

function primitivesFor(ws) {
  return {
    async exec(command, opts = {}) {
      const result = await rpc(
        ws,
        'exec',
        {
          command,
          cwd: resolveRemoteCwd(ws.root, opts.cwd),
          timeoutMs: opts.timeoutMs ?? 30_000,
        },
        { timeoutMs: (opts.timeoutMs ?? 30_000) + 5_000, signal: opts.signal },
      )
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
      }
    },
    async readFile(path, opts = {}) {
      const result = await rpc(ws, 'read_file', { path }, opts)
      return String(result.content ?? '')
    },
    async writeFile(path, content, opts = {}) {
      const result = await rpc(
        ws,
        'write_file',
        { path, content, mkdir: opts.mkdir !== false },
        opts,
      )
      return { path: result.path, bytes: Buffer.byteLength(content, 'utf8') }
    },
    async stat(path, opts = {}) {
      return await rpc(ws, 'stat', { path }, opts)
    },
    async listDir(path, opts = {}) {
      const result = await rpc(ws, 'list_dir', { path }, opts)
      const entries = Array.isArray(result.entries) ? result.entries : []
      return {
        path: result.path ?? path,
        entries: entries.map((e) => ({
          name: e.name,
          isDir: Boolean(e.isDir),
          size: e.size,
          modTime: e.modTime,
        })),
      }
    },
    async startJob(command, opts) {
      const result = await rpc(ws, 'job_start', {
        command,
        cwd: resolveRemoteCwd(ws.root, opts?.cwd),
      })
      return {
        jobId: String(result.jobId ?? ''),
        pid: typeof result.pid === 'number' ? result.pid : undefined,
      }
    },
    async jobOutput(jobId, offsets, maxBytes) {
      const result = await rpc(ws, 'job_output', {
        jobId,
        outOffset: offsets?.out ?? 0,
        errOffset: offsets?.err ?? 0,
        ...(maxBytes ? { maxBytes } : {}),
      })
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
        outNext: Number(result.outNext ?? 0),
        errNext: Number(result.errNext ?? 0),
        state: String(result.state ?? 'running'),
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      }
    },
    async jobKill(jobId) {
      await rpc(ws, 'job_kill', { jobId })
    },
  }
}

/** The codemap binary this agent ships is the one bootstrapped to the remote. */
function localCodemapBinary() {
  const env = globalThis.process?.env ?? {}
  const configured = env.WAW_CODEMAP_BIN?.trim()
  if (configured && existsSync(configured)) return configured
  const exe = globalThis.process?.platform === 'win32' ? 'codemap.exe' : 'codemap'
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'codemap binary not found locally (install codemap or set WAW_CODEMAP_BIN); remote code::map needs it to bootstrap',
  )
}

/**
 * Code tools are shell commands on the remote host. Reusing the exec primitive
 * keeps the workspace cwd, timeout handling and error sanitising in one place.
 */
async function remoteCode(ws, call) {
  const primitives = primitivesFor(ws)
  let command = ''
  if (call.name === 'code::map') {
    let bin
    try {
      bin = await ensureRemoteTool(ws.sshHost, localCodemapBinary(), 'codemap')
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `remote codemap bootstrap failed; code::map was not run: ${String(
              err instanceof Error ? err.message : err,
            ).slice(0, 300)}`,
          },
        ],
        isError: true,
      }
    }
    const mode = String(call.args?.mode ?? 'structure')
    const path = String(call.args?.path ?? '.')
    command = `${shQuote(bin)} --exclude node_modules,dist,.git ${JSON.stringify(path)}`
    if (mode === 'deps') {
      command = `${shQuote(bin)} --deps --exclude node_modules,dist,.git ${JSON.stringify(path)}`
    } else if (mode === 'importers') {
      command = `${shQuote(bin)} --importers ${JSON.stringify(path)} --depth 2`
    } else if (mode === 'diff') {
      command = `${shQuote(bin)} --diff --ref ${JSON.stringify(String(call.args?.ref ?? 'main'))}`
    }
  } else {
    const path = String(call.args?.path ?? '')
    if (!path) {
      return { content: [{ type: 'text', text: 'path required' }], isError: true }
    }
    const language = String(call.args?.language ?? '').toLowerCase()
    command =
      language === 'ts' ||
      language === 'typescript' ||
      path.endsWith('.ts') ||
      path.endsWith('.tsx')
        ? `npx --yes tsc --noEmit --pretty false ${JSON.stringify(path)} 2>&1 | head -n 40`
        : `node --check ${JSON.stringify(path)}`
  }
  const result = await primitives.exec(command, { cwd: ws.root, timeoutMs: 60_000 })
  if (result.exitCode === 0) {
    const text =
      result.stderr && !result.stdout
        ? result.stderr
        : result.stdout + (result.stderr ? (result.stdout ? '\n' : '') + result.stderr : '')
    return {
      content: [{ type: 'text', text: text || `(exit 0, empty output @ ${ws.root})` }],
      isError: false,
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { cwd: ws.root, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
          null,
          2,
        ),
      },
    ],
    isError: true,
  }
}

/**
 * The provider the kernel's remote module installs.
 *
 * `bind` is per conversation because the SSH target is per conversation; the
 * kernel calls it with the workspace it looked up for the call.
 */
export function createRemoteProvider() {
  return {
    bind(ws) {
      const normalized = normalizeWorkspaceTarget(ws) ?? ws
      return primitivesFor(normalized)
    },
    extras: {
      names: ['code::map', 'code::syntax'],
      async call(name, args, ctx) {
        const ws = activeWorkspace(ctx.sessionId)
        if (!ws) {
          return {
            content: [{ type: 'text', text: '当前会话没有绑定工作区' }],
            isError: true,
          }
        }
        try {
          assertModeAllowsTarget(ws)
        } catch (err) {
          return {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }
        }
        return remoteCode(ws, { name, args, ctx })
      },
    },
  }
}

/** Kept for the plugin teardown: drop every pooled SSH worker. */
export function disposeRemoteExec() {
  void disconnectAllRemoteAgents()
}
