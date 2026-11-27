import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  disconnectAllRemoteAgents,
  ensureRemoteAgent,
  ensureRemoteTool,
  getAgentMode,
  getAgentModeStatus,
  probeRemoteAgent,
  remoteHomeDir,
  switchAgentMode,
} from '../remote-bridge.mjs'
import { createRemoteProvider } from '../remote-exec.mjs'
import {
  assertModeAllowsTarget,
  isTargetAllowedInMode,
  resetAgentMode,
} from '../remote-mode.mjs'
import remoteAgentPlugin from '../remote-agent.plugin.mjs'

test.afterEach(async () => {
  await disconnectAllRemoteAgents()
  resetAgentMode('remote')
})

test('remote mode strictly blocks local agent until switched', async () => {
  assert.equal(getAgentMode(), 'remote')
  assert.equal(isTargetAllowedInMode('local'), false)
  assert.equal(isTargetAllowedInMode('dev-server'), true)

  await assert.rejects(
    () => ensureRemoteAgent({ sshHost: 'local', root: '/tmp' }),
    /已与 local 模式隔离/,
  )
  await assert.rejects(() => remoteHomeDir('local'), /已与 local 模式隔离/)
  await assert.rejects(() => ensureRemoteTool('local', '/bin/sh', 'sh'), /已与 local 模式隔离/)

  const probe = await probeRemoteAgent({ sshHost: 'local', root: '/tmp' })
  assert.equal(probe.state, 'error')
  assert.match(probe.error, /已与 local 模式隔离/)
})

test('local mode strictly blocks remote SSH targets and executes locally via native binary', async () => {
  const sw = await switchAgentMode('local')
  assert.deepEqual(sw, { previousMode: 'remote', mode: 'local', switched: true, disconnected: 0 })
  assert.equal(getAgentMode(), 'local')

  // Remote targets are now blocked
  assert.throws(() => assertModeAllowsTarget('prod-box'), /已与 remote 模式隔离/)
  await assert.rejects(
    () => ensureRemoteAgent({ sshHost: 'prod-box', root: '/data/ws' }),
    /已与 remote 模式隔离/,
  )
  const probe = await probeRemoteAgent({ sshHost: 'prod-box', root: '/data/ws' })
  assert.equal(probe.state, 'error')
  assert.match(probe.error, /已与 remote 模式隔离/)

  // Local home dir works without SSH
  const home = await remoteHomeDir('local')
  assert.ok(home && home.length > 0)

  // Real local execution through createRemoteProvider() -> local Go agent pipe
  const ws = mkdtempSync(join(tmpdir(), 'waw-local-mode-'))
  try {
    const provider = createRemoteProvider()
    const primitives = provider.bind({ kind: 'local', root: ws })
    await primitives.writeFile('note.txt', 'hello-local-agent')
    const content = await primitives.readFile('note.txt')
    assert.equal(content, 'hello-local-agent')

    const statusBefore = getAgentModeStatus()
    assert.equal(statusBefore.mode, 'local')
    assert.equal(statusBefore.activeConnections, 1)
    assert.deepEqual(statusBefore.hosts, ['local'])

    // Switching back to remote tears down the active local agent immediately
    const back = await switchAgentMode('remote')
    assert.equal(back.previousMode, 'local')
    assert.equal(back.mode, 'remote')
    assert.equal(back.switched, true)
    assert.equal(back.disconnected, 1)

    const statusAfter = getAgentModeStatus()
    assert.equal(statusAfter.mode, 'remote')
    assert.equal(statusAfter.activeConnections, 0)

    // Local execution is immediately blocked again after switching back
    await assert.rejects(() => primitives.readFile('note.txt'), /已与 local 模式隔离/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('plugin registers remote::mode tool for status inspection and isolated switching', async () => {
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
    assert.ok(registered.has('remote::mode'))
    const modeHandler = registered.get('remote::mode')
    const pingHandler = registered.get('remote::ping')

    const initial = JSON.parse(await modeHandler({ action: 'status' }))
    assert.equal(initial.mode, 'remote')
    assert.equal(initial.isolatedFrom, 'local')

    const toLocal = JSON.parse(await modeHandler({ action: 'switch', mode: 'local' }))
    assert.equal(toLocal.mode, 'local')
    assert.equal(toLocal.switched, true)
    assert.equal(toLocal.isolatedFrom, 'remote')

    const ping = JSON.parse(await pingHandler({}))
    assert.equal(ping.mode, 'local')

    const toRemote = JSON.parse(await modeHandler({ action: 'switch', mode: 'remote' }))
    assert.equal(toRemote.mode, 'remote')
    assert.equal(toRemote.switched, true)
  } finally {
    teardown?.()
  }
})
