import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clearLogs,
  configureLogger,
  getLogFilePath,
  logNativeStderr,
  logger,
  readLogs,
  resetLoggerConfig,
  sanitizeLogValue,
} from '../remote-logger.mjs'
import remoteAgentPlugin from '../remote-agent.plugin.mjs'

let tempDir

test.beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'waw-log-test-'))
  configureLogger({
    filePath: join(tempDir, 'remote-agent.log'),
    level: 'debug',
    maxBytes: 1024 * 1024,
    maxBackups: 2,
  })
  clearLogs()
})

test.afterEach(() => {
  clearLogs()
  resetLoggerConfig()
  rmSync(tempDir, { recursive: true, force: true })
})

test('writes structured JSONL logs, filters by level/component/search, and redacts secrets', () => {
  logger.info('bridge', 'agent.spawn', {
    sshHost: 'local',
    token: 'super-secret-token-value',
    passphrase: 'my-key-passphrase',
    note: 'Authorization header Bearer secret123 and github_pat_1234567890ABCDEF',
  })
  logger.error('exec', 'rpc.error', { method: 'exec', error: 'timeout' })

  const raw = readFileSync(getLogFilePath(), 'utf8')
  assert.equal(raw.includes('super-secret-token-value'), false)
  assert.equal(raw.includes('my-key-passphrase'), false)
  assert.equal(raw.includes('secret123'), false)
  assert.equal(raw.includes('github_pat_1234567890ABCDEF'), false)
  assert.equal(raw.includes('[REDACTED]'), true)

  const all = readLogs({ limit: 50 })
  assert.equal(all.length, 2)
  assert.equal(all[0].token, '[REDACTED]')
  assert.equal(all[0].passphrase, '[REDACTED]')

  const errorsOnly = readLogs({ level: 'error' })
  assert.equal(errorsOnly.length, 1)
  assert.equal(errorsOnly[0].event, 'rpc.error')

  const byComponent = readLogs({ component: 'bridge' })
  assert.equal(byComponent.length, 1)
  assert.equal(byComponent[0].event, 'agent.spawn')

  const bySearch = readLogs({ search: 'timeout' })
  assert.equal(bySearch.length, 1)

  assert.equal(sanitizeLogValue('Bearer mytok'), '[REDACTED]')
})

test('rotates log files when maxBytes is exceeded', () => {
  const logFile = join(tempDir, 'rotate.log')
  configureLogger({ filePath: logFile, level: 'info', maxBytes: 256, maxBackups: 2 })
  for (let i = 0; i < 15; i++) {
    logger.info('test', 'rotate.entry', { idx: i, payload: 'x'.repeat(80) })
  }
  assert.equal(existsSync(logFile), true)
  assert.equal(existsSync(`${logFile}.1`), true)
})

test('parses native Go JSON stderr lines and forwards them into structured logs', () => {
  logNativeStderr(
    `${JSON.stringify({ ts: '2026-11-26T00:00:00Z', level: 'info', component: 'agent', event: 'agent.start', os: 'linux' })}\nplain warning line\n`,
    { sshHost: 'local', mode: 'local' },
  )
  const entries = readLogs({ component: 'native-agent' })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].event, 'agent.start')
  assert.equal(entries[0].os, 'linux')
  assert.equal(entries[1].event, 'stderr')
  assert.equal(entries[1].message, 'plain warning line')
})

test('remote::logs plugin tool inspects path, tails entries, and clears logs', async () => {
  const registered = new Map()
  const teardown = await remoteAgentPlugin({
    name: 'remote-agent',
    capabilities: { tools: true, modules: false, servers: false, ui: false, extras: false },
    tools: {
      register(def, handler) {
        registered.set(def.name, handler)
      },
      unregister(name) {
        registered.delete(name)
      },
      names() {
        return [...registered.keys()]
      },
    },
  })
  try {
    assert.ok(registered.has('remote::logs'))
    const logsHandler = registered.get('remote::logs')

    logger.info('verify', 'smoke.ping', { ok: true })
    const pathRes = JSON.parse(await logsHandler({ action: 'path' }))
    assert.equal(pathRes.ok, true)
    assert.equal(pathRes.filePath, getLogFilePath())

    const tailRes = JSON.parse(await logsHandler({ action: 'tail', component: 'verify' }))
    assert.equal(tailRes.ok, true)
    assert.equal(tailRes.count, 1)
    assert.equal(tailRes.entries[0].event, 'smoke.ping')

    const clearRes = JSON.parse(await logsHandler({ action: 'clear' }))
    assert.equal(clearRes.cleared, true)
    assert.equal(readLogs().length, 0)
  } finally {
    teardown?.()
  }
})
