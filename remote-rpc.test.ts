import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

type RpcClient = {
  call(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>
  close(): void
}

async function makeClient(): Promise<{ rpc: RpcClient; stdin: PassThrough }> {
  // The plugin files are ESM `.mjs` without types; this is the pattern the
  // sibling remote-status test uses.
  const mod = (await import('./remote-rpc.mjs' as string)) as {
    RemoteRpcClient: new (stdin: PassThrough, stdout: PassThrough, token: string) => RpcClient
  }
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  return { rpc: new mod.RemoteRpcClient(stdin, stdout, 'test-token'), stdin }
}

describe('RemoteRpcClient', () => {
  // Regression: a write to a dead ssh pipe emits EPIPE on the stream, and the
  // missing 'error' listener used to take the whole TUI host down mid-run —
  // the conversation then showed "Running" forever with no terminal event.
  it('fails a pending call when stdin dies instead of escaping as uncaught', async () => {
    const { rpc, stdin } = await makeClient()
    const call = rpc.call('exec', { command: 'true' }, { timeoutMs: 5_000 })
    stdin.destroy(new Error('write EPIPE'))
    await expect(call).rejects.toThrow(/EPIPE/)
  })

  it('refuses later calls once the pipe is gone', async () => {
    const { rpc, stdin } = await makeClient()
    const closed = new Promise((resolve) => stdin.once('close', resolve))
    stdin.destroy(new Error('write EPIPE'))
    await closed
    await expect(rpc.call('ping', {})).rejects.toThrow(/remote rpc closed/)
  })
})
