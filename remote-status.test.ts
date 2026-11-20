/**
 * The host's remote-agent health table.
 *
 * These cases pin the three properties the sidebar depends on: a key is shared
 * by whoever points at the same workspace, an unchanged state does not wake
 * subscribers (a ping every tool call would otherwise repaint every window), and
 * a long error message cannot grow the SSE frame without bound.
 */
import { beforeEach, describe, expect, it } from 'vitest'

type Health = { state: 'ok' | 'error'; error?: string; at: number }
type Event = Health & { sshHost: string; root: string }

const load = async () => {
  const mod = await import('./remote-status.mjs' as string)
  return mod as {
    remoteStatusKey: (t: { sshHost: string; root: string }) => string | null
    recordRemoteAgentHealth: (
      t: { sshHost: string; root: string },
      state: 'ok' | 'error',
      error?: string,
    ) => Event | null
    getRemoteAgentHealth: (t: { sshHost: string; root: string }) => Health | undefined
    listRemoteAgentHealth: () => Event[]
    subscribeRemoteAgentHealth: (cb: (e: Event) => void) => () => void
    resetRemoteAgentHealth: () => void
  }
}

const target = { sshHost: 'oem', root: '/data1/workspace/infra' }

let mod: Awaited<ReturnType<typeof load>>

beforeEach(async () => {
  mod = await load()
  mod.resetRemoteAgentHealth()
})

describe('remote agent health', () => {
  it('keys by host and workspace, ignoring trailing slashes', () => {
    expect(mod.remoteStatusKey(target)).toBe('oem\0/data1/workspace/infra')
    expect(mod.remoteStatusKey({ sshHost: 'oem', root: '/data1/workspace/infra/' })).toBe(
      'oem\0/data1/workspace/infra',
    )
    expect(mod.remoteStatusKey({ sshHost: '', root: '/' })).toBeNull()
    expect(mod.remoteStatusKey({ sshHost: 'oem', root: 'relative' })).toBeNull()
  })

  it('records and reads a health value', () => {
    mod.recordRemoteAgentHealth(target, 'ok')
    expect(mod.getRemoteAgentHealth(target)).toMatchObject({ state: 'ok' })
    expect(mod.listRemoteAgentHealth()).toEqual([
      expect.objectContaining({ sshHost: 'oem', root: target.root, state: 'ok' }),
    ])
  })

  it('notifies subscribers on state change and on a new error message', () => {
    const seen: Event[] = []
    mod.subscribeRemoteAgentHealth((e) => seen.push(e))
    mod.recordRemoteAgentHealth(target, 'ok')
    mod.recordRemoteAgentHealth(target, 'error', 'ssh: connect to host oem port 22: refused')
    mod.recordRemoteAgentHealth(target, 'error', 'ping timeout')
    expect(seen.map((e) => e.state)).toEqual(['ok', 'error', 'error'])
    expect(seen[2]?.error).toBe('ping timeout')
  })

  it('stays quiet when nothing changed', () => {
    let calls = 0
    mod.subscribeRemoteAgentHealth(() => {
      calls += 1
    })
    mod.recordRemoteAgentHealth(target, 'ok')
    mod.recordRemoteAgentHealth(target, 'ok')
    expect(calls).toBe(1)
  })

  it('lets a later ok overwrite an earlier error', () => {
    mod.recordRemoteAgentHealth(target, 'error', 'boom')
    mod.recordRemoteAgentHealth(target, 'ok')
    expect(mod.getRemoteAgentHealth(target)).toMatchObject({ state: 'ok' })
    expect(mod.getRemoteAgentHealth(target)?.error).toBeUndefined()
  })

  it('collapses and truncates an error message for the tooltip', () => {
    mod.recordRemoteAgentHealth(target, 'error', `ssh:\n  connect   failed ${'x'.repeat(400)}`)
    const stored = mod.getRemoteAgentHealth(target)
    expect(stored?.error?.startsWith('ssh: connect failed')).toBe(true)
    expect(stored?.error?.includes('\n')).toBe(false)
    expect(stored?.error?.length).toBeLessThanOrEqual(240)
  })

  it('ignores an unusable target rather than inventing a key', () => {
    expect(mod.recordRemoteAgentHealth({ sshHost: '', root: '/' }, 'ok')).toBeNull()
    expect(mod.listRemoteAgentHealth()).toEqual([])
  })

  it('unsubscribes cleanly', () => {
    let calls = 0
    const off = mod.subscribeRemoteAgentHealth(() => {
      calls += 1
    })
    off()
    mod.recordRemoteAgentHealth(target, 'ok')
    expect(calls).toBe(0)
  })
})
