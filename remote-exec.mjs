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
import {
  isAbsoluteRemoteRoot,
  normalizeRemoteRoot,
  psQuote,
  remoteFlavorOf,
  toForwardSlashes,
} from './remote-os.mjs'
import {
  disconnectAllRemoteAgents,
  ensureRemoteTool,
  remoteShellCapabilities,
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
export function activeWorkspace(sessionId) {
  const map = globalThis.__wawSessionWorkspaces
  if (!map || typeof map !== 'object') return null
  const key = String(sessionId ?? '').trim()
  const value = map[key === 'new' ? '' : key]
  if (!value || value.kind !== 'remote' || !value.sshHost || !isAbsoluteRemoteRoot(value.root)) {
    return null
  }
  return { ...value, root: normalizeRemoteRoot(value.root) }
}

/** Map model cwd (often "." / relative) onto the remote workspace root. */
export function resolveRemoteCwd(wsRoot, cwd) {
  const root = normalizeRemoteRoot(wsRoot)
  const flavor = remoteFlavorOf(root)
  if (cwd == null || cwd === '' || cwd === '.' || cwd === './') return root
  const raw = toForwardSlashes(cwd)
  if (flavor === 'windows') {
    if (/^[A-Za-z]:\//.test(raw)) return normalizeRemoteRoot(raw)
    // `/x` on Windows is the current drive's root, not a path under the root.
    if (raw.startsWith('/')) return normalizeRemoteRoot(`${root.slice(0, 2)}${raw}`)
    return normalizeRemoteRoot(`${root}/${raw.replace(/^\.\//, '')}`)
  }
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/'
  const base = root === '/' ? '' : root
  return `${base}/${raw.replace(/^\.\//, '')}`.replace(/\/+$/, '') || '/'
}

/** Above this a file is not a source edit's line delta; reading it would stall a turn. */
export const LINE_COUNT_MAX_BYTES = 20 << 20

/**
 * The shell the remote agent runs to measure one file for the edit ledger.
 *
 * `wc -l` counts newline bytes, while `tui/src/agent/file-edit-ledger.ts` counts
 * the entries of a `\r?\n` split: every split yields one more entry than there
 * are newlines (an empty file is the special case, and counts as 0). Adding
 * that entry back keeps a remote `+N` the same number the same file would show
 * in a local conversation.
 */
export function lineCountCommand(path, flavor = 'posix') {
  if (flavor === 'windows') {
    // Same arithmetic as the POSIX branch: newline count + 1, empty file 0.
    // `[IO.File]::ReadAllText` is used rather than Get-Content so CRLF and a
    // missing final newline count exactly like the local ledger's `\r?\n` split.
    const p = psQuote(toForwardSlashes(path))
    return (
      `if (Test-Path -LiteralPath ${p} -PathType Leaf) { ` +
      `$s = (Get-Item -LiteralPath ${p}).Length; ` +
      `if ($s -gt ${LINE_COUNT_MAX_BYTES}) { 'TOOBIG' } else { ` +
      `if ($s -eq 0) { 0 } else { ([regex]::Matches([IO.File]::ReadAllText(${p}), "\\r?\\n")).Count + 1 } } ` +
      `} elseif (Test-Path -LiteralPath ${p}) { 'NOTFILE' } else { 'MISSING' }`
    )
  }
  const p = shQuote(path)
  return (
    `if [ -f ${p} ]; then ` +
    `s=$(wc -c < ${p}); ` +
    `if [ "$s" -gt ${LINE_COUNT_MAX_BYTES} ]; then echo TOOBIG; else ` +
    `n=$(wc -l < ${p}); ` +
    `if [ "$s" -gt 0 ]; then n=$((n + 1)); fi; ` +
    `echo "$n"; fi; ` +
    `elif [ -e ${p} ]; then echo NOTFILE; else echo MISSING; fi`
  )
}

/** A count, or why there is none — never a made-up zero. */
export function parseLineCount(stdout) {
  const text = String(stdout ?? '').trim()
  if (/^\d+$/.test(text)) return { lines: Number(text) }
  if (text === 'MISSING') return { reason: 'missing' }
  if (text === 'NOTFILE') return { reason: 'not-file' }
  if (text === 'TOOBIG') return { reason: 'too-large' }
  return { reason: 'error' }
}

async function rpc(ws, method, params, opts = {}) {
  try {
    return await withRemoteAgent(ws, async (conn) => {
      const resp = await conn.rpc.call(method, params, {
        timeoutMs: opts.timeoutMs ?? 30_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      if (!resp.ok) throw new Error(resp.error ?? `${method} failed`)
      return resp.result ?? {}
    })
  } catch (err) {
    throw new Error(sanitizeRemoteError(err instanceof Error ? err.message : String(err)))
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
          ...(opts.shell ? { shell: String(opts.shell) } : {}),
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
        ...(opts?.shell ? { shell: String(opts.shell) } : {}),
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
    /**
     * Deliberately `exec`, not `read_file`/`stat`: the agent fences its file
     * RPCs to the configured roots, while `shell::exec` may redirect anywhere
     * (a /tmp scratch file included). The measurement must reach everything the
     * write could reach, or those rows stay unknown for no reason.
     */
    /**
     * Shells the host offers, resolved through `ping`. The snapshot tracker
     * calls this when a run starts before the bind's warm finished.
     */
    async shellCapabilities() {
      return await remoteShellCapabilities(ws)
    },
    async lineCount(path, opts = {}) {
      const result = await rpc(
        ws,
        'exec',
        {
          command: lineCountCommand(path, remoteFlavorOf(ws.root)),
          cwd: ws.root,
          timeoutMs: 20_000,
        },
        { timeoutMs: 25_000, signal: opts.signal },
      )
      if (result.exitCode !== 0) return { reason: 'error' }
      return parseLineCount(result.stdout)
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
    const typescript =
      language === 'ts' ||
      language === 'typescript' ||
      path.endsWith('.ts') ||
      path.endsWith('.tsx')
    if (remoteFlavorOf(ws.root) === 'windows') {
      const literal = psQuote(toForwardSlashes(path))
      command = typescript
        ? `npx --yes tsc --noEmit --pretty false ${literal} 2>&1 | Select-Object -First 40`
        : `node --check ${literal}`
    } else {
      command = typescript
        ? `npx --yes tsc --noEmit --pretty false ${JSON.stringify(path)} 2>&1 | head -n 40`
        : `node --check ${JSON.stringify(path)}`
    }
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
      return primitivesFor(ws)
    },
    extras: {
      names: ['code::map', 'code::syntax'],
      async call(name, args, ctx) {
        const ws = activeWorkspace(ctx.sessionId)
        if (!ws) {
          return {
            content: [{ type: 'text', text: '当前会话没有绑定远程工作区' }],
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
