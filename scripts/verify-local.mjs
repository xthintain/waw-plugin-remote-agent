#!/usr/bin/env node
/**
 * End-to-end local functional completeness verifier for waw-plugin-remote-agent.
 *
 * Exercises:
 * 1. Strict remote/local mode isolation & mutual exclusion
 * 2. Full local native Go agent RPC surface (ping, write_file, read_file, stat, list_dir, exec, remove, symlink fence)
 * 3. Background jobs (job_start, job_status, job_output, job_kill)
 * 4. Mode switch teardown (remote <-> local)
 * 5. Full log system (JSONL persistence, Go stderr aggregation, secret redaction)
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disconnectAllRemoteAgents,
  ensureRemoteAgent,
  getAgentMode,
  getAgentModeStatus,
  switchAgentMode,
} from '../remote-bridge.mjs'
import { createRemoteProvider } from '../remote-exec.mjs'
import { clearLogs, configureLogger, getLogFilePath, readLogs } from '../remote-logger.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'waw-verify-local-'))
const ws = join(tmpRoot, 'ws')
const outside = mkdtempSync(join(tmpdir(), 'waw-verify-outside-'))
const logFile = join(tmpRoot, 'verify.log')

configureLogger({ filePath: logFile, level: 'debug' })
clearLogs()

try {
  // 1. Mode isolation (remote blocks local)
  assert.equal(getAgentMode(), 'remote')
  await assert.rejects(
    () => ensureRemoteAgent({ sshHost: 'local', root: tmpRoot }),
    /已与 local 模式隔离/,
  )
  console.log('[PASS] 1. remote 模式成功隔离 local agent')

  // 2. Switch to local & verify remote is blocked
  const swLocal = await switchAgentMode('local')
  assert.equal(swLocal.mode, 'local')
  await assert.rejects(
    () => ensureRemoteAgent({ sshHost: 'example-host', root: '/tmp' }),
    /已与 remote 模式隔离/,
  )
  console.log('[PASS] 2. 切换至 local 模式并成功隔离 remote SSH 目标')

  // 3. Full local RPC surface
  const provider = createRemoteProvider()
  const local = provider.bind({ kind: 'local', root: tmpRoot })

  const written = await local.writeFile(join(ws, 'hello.txt'), 'waw-local-ok', { mkdir: true })
  assert.equal(written.bytes, Buffer.byteLength('waw-local-ok', 'utf8'))
  const readBack = await local.readFile(join(ws, 'hello.txt'))
  assert.equal(readBack, 'waw-local-ok')

  const st = await local.stat(join(ws, 'hello.txt'))
  assert.equal(st.isDir, false)
  assert.equal(st.size, 12)

  const dir = await local.listDir(ws)
  assert.equal(dir.entries.length, 1)
  assert.equal(dir.entries[0].name, 'hello.txt')

  const ex = await local.exec('printf "local-exec-ok"', { cwd: ws, timeoutMs: 10_000 })
  assert.equal(ex.exitCode, 0)
  assert.equal(ex.stdout, 'local-exec-ok')

  const exErr = await local.exec('echo err-msg >&2; exit 7', { cwd: ws, timeoutMs: 10_000 })
  assert.equal(exErr.exitCode, 7)
  assert.match(exErr.stderr, /err-msg/)

  // Symlink escape fence
  symlinkSync(outside, join(ws, 'escape-link'))
  await assert.rejects(
    () => local.readFile(join(ws, 'escape-link', 'secret.txt')),
    /outside allowed roots/,
  )

  // Root removal guard via raw conn RPC
  const conn = await ensureRemoteAgent({ sshHost: 'local', root: tmpRoot })
  const ping = await conn.rpc.call('ping', {})
  assert.equal(ping.ok, true)
  assert.equal(ping.result.protocolVersion, 5)
  assert.ok(ping.result.os && ping.result.arch)

  const rmRoot = await conn.rpc.call('remove', { path: tmpRoot, recursive: true })
  assert.equal(rmRoot.ok, false)
  assert.match(rmRoot.error, /cannot remove root/)
  console.log(`[PASS] 3. 本地 Go agent 全套 RPC 能力校验通过 (${ping.result.os}/${ping.result.arch}, v${ping.result.protocolVersion})`)

  // 4. Background jobs
  const job = await local.startJob('printf "job-line-1\\n"; sleep 15', { cwd: ws })
  assert.ok(job.jobId)
  await new Promise((r) => setTimeout(r, 150))
  const out = await local.jobOutput(job.jobId, { out: 0, err: 0 })
  assert.match(out.stdout, /job-line-1/)
  assert.equal(out.state, 'running')
  await local.jobKill(job.jobId)
  await new Promise((r) => setTimeout(r, 100))
  const afterKill = await local.jobOutput(job.jobId, { out: out.outNext, err: out.errNext })
  assert.equal(afterKill.state, 'killed')
  console.log('[PASS] 4. 后台任务启动、增量日志读取与进程树终止校验通过')

  // 5. Switch back to remote -> auto teardown & re-isolation
  assert.equal(getAgentModeStatus().activeConnections, 1)
  const swRemote = await switchAgentMode('remote')
  assert.equal(swRemote.mode, 'remote')
  assert.equal(swRemote.disconnected, 1)
  assert.equal(getAgentModeStatus().activeConnections, 0)
  await assert.rejects(() => local.readFile(join(ws, 'hello.txt')), /已与 local 模式隔离/)
  console.log('[PASS] 5. 切回 remote 模式自动回收本地连接并重新隔离')

  // 6. Full log system verification
  const entries = readLogs({ limit: 200 })
  const events = new Set(entries.map((e) => `${e.component}:${e.event}`))
  for (const required of [
    'mode:mode.blocked',
    'mode:mode.switch',
    'bridge:agent.spawn',
    'bridge:agent.ready',
    'exec:rpc.ok',
    'exec:rpc.error',
    'native-agent:agent.start',
    'native-agent:job.start',
    'native-agent:job.kill',
  ]) {
    assert.ok(events.has(required), `missing expected log event ${required}; saw: ${[...events].join(', ')}`)
  }
  const rawLog = readFileSync(getLogFilePath(), 'utf8')
  assert.equal(/--token\s+[0-9a-f]{48}/.test(rawLog), false, 'auth token must never appear in logs')
  console.log(`[PASS] 6. 全链路日志系统校验通过（共捕获 ${entries.length} 条结构化 JSONL 日志，无凭据泄露）`)
  console.log('\nALL LOCAL COMPLETENESS & FULL LOG SYSTEM CHECKS PASSED.')
} finally {
  await disconnectAllRemoteAgents()
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
