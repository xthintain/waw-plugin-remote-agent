/**
 * Length-prefixed JSON RPC for waw-remote-agent (stdio / SSH pipe).
 * Same framing as agent-service RemoteRpcClient.
 */
import { randomUUID } from 'node:crypto'

const MAX_FRAME = 16 << 20

export function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  if (body.length > MAX_FRAME) throw new Error('frame too large')
  const hdr = Buffer.alloc(4)
  hdr.writeUInt32BE(body.length, 0)
  return Buffer.concat([hdr, body])
}

export class RemoteRpcClient {
  #buf = Buffer.alloc(0)
  #pending = new Map()
  #closed = false
  #stdin
  #token

  constructor(stdin, stdout, token) {
    this.#stdin = stdin
    this.#token = token
    // A dead remote's pipe reports EPIPE as an ASYNCHRONOUS 'error' event. A
    // stream with no listener turns that into an uncaught exception and exits
    // the whole host — every conversation, mid-run. Fail this client instead;
    // callers treat that as a transport error and reconnect (withRemoteAgent).
    stdin.on('error', (err) => this.#fail(err instanceof Error ? err : new Error(String(err))))
    stdin.on('close', () => this.#fail(new Error('remote agent stdin closed')))
    stdout.on('data', (chunk) => this.#onData(chunk))
    stdout.on('end', () => this.#fail(new Error('remote agent stdout ended')))
    stdout.on('error', (err) => this.#fail(err instanceof Error ? err : new Error(String(err))))
  }

  async call(method, params, opts = {}) {
    if (this.#closed) throw new Error('remote rpc closed')
    const id = opts.id ?? randomUUID()
    const timeoutMs = opts.timeoutMs ?? 60_000
    const req = { id, method, token: this.#token, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`remote rpc timeout: ${method}`))
      }, timeoutMs)
      const onAbort = () => {
        this.#pending.delete(id)
        clearTimeout(timer)
        void this.call('cancel', { id }, { timeoutMs: 5_000 }).catch(() => undefined)
        reject(new Error('aborted'))
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer)
          reject(new Error('aborted'))
          return
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#pending.set(id, {
        resolve: (r) => {
          opts.signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          opts.signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          reject(e)
        },
        timer,
      })
      try {
        this.#stdin.write(encodeFrame(req))
      } catch (err) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  close() {
    this.#closed = true
    this.#failAll(new Error('remote rpc closed'))
  }

  /** The pipe is gone; end this client so no later write reaches a dead socket. */
  #fail(err) {
    this.#closed = true
    this.#failAll(err)
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk])
    for (;;) {
      if (this.#buf.length < 4) return
      const n = this.#buf.readUInt32BE(0)
      if (n <= 0 || n > MAX_FRAME) {
        this.#failAll(new Error(`invalid frame size ${n}`))
        return
      }
      if (this.#buf.length < 4 + n) return
      const body = this.#buf.subarray(4, 4 + n)
      this.#buf = this.#buf.subarray(4 + n)
      let resp
      try {
        resp = JSON.parse(body.toString('utf8'))
      } catch {
        continue
      }
      const p = this.#pending.get(resp.id)
      if (!p) continue
      this.#pending.delete(resp.id)
      clearTimeout(p.timer)
      p.resolve(resp)
    }
  }

  #failAll(err) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.#pending.clear()
  }
}
