/**
 * Remote agent health, as this host process remembers it.
 *
 * WHY HERE, AND NOT IN THE UI
 *
 * The SSH child, the connection pool and `child.on('exit')` all live in the
 * host process; the renderer only ever sees a mirror. Keeping the authoritative
 * value here means several windows agree, a reload costs one GET instead of a
 * fresh SSH handshake, and the "the agent died" case can be pushed rather than
 * polled.
 *
 * The value is derived state, not conversation state: it is deliberately not
 * replayed over SSE, and not persisted — a host restart starts unknown, which is
 * the truth.
 *
 * Keys are `sshHost\0root` (matching the pool's key) so two projects that point
 * at the same workspace share one entry.
 */

/** Error text is shown in a tooltip; collapse whitespace and keep it short. */
const ERROR_MAX = 240

/** @typedef {{ state: 'ok' | 'error', error?: string, at: number }} RemoteAgentHealth */
/** @typedef {{ sshHost: string, root: string } & RemoteAgentHealth} RemoteAgentHealthEvent */

/** @type {Map<string, RemoteAgentHealth>} */
const health = new Map()

/** @type {Set<(event: RemoteAgentHealthEvent) => void>} */
const listeners = new Set()

function cleanError(value) {
  if (value == null) return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text
}

/** Normalize a target, or null when it could never name a remote workspace. */
function normalize(target) {
  const sshHost = String(target?.sshHost ?? '').trim()
  const root = String(target?.root ?? '').replace(/\/+$/, '') || '/'
  if (!sshHost || !root.startsWith('/')) return null
  return { sshHost, root }
}

export function remoteStatusKey(target) {
  const norm = normalize(target)
  return norm ? `${norm.sshHost}\0${norm.root}` : null
}

/**
 * Record a health observation and notify subscribers.
 *
 * `at` is refreshed on every call (a healthy ping is news even when the state is
 * unchanged), but a notification fires only when the state or the message
 * changes — otherwise every tool call would wake every window.
 */
export function recordRemoteAgentHealth(target, state, error) {
  const norm = normalize(target)
  if (!norm) return null
  if (state !== 'ok' && state !== 'error') return null
  const next = { state, at: Date.now() }
  const message = cleanError(error)
  if (state === 'error' && message) next.error = message

  const key = `${norm.sshHost}\0${norm.root}`
  const prev = health.get(key)
  health.set(key, next)
  const changed = !prev || prev.state !== next.state || prev.error !== next.error
  const event = { sshHost: norm.sshHost, root: norm.root, ...next }
  if (changed) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* a subscriber must not break the bridge */
      }
    }
  }
  return event
}

/** @returns {RemoteAgentHealth | undefined} */
export function getRemoteAgentHealth(target) {
  const key = remoteStatusKey(target)
  return key ? health.get(key) : undefined
}

/** @returns {RemoteAgentHealthEvent[]} */
export function listRemoteAgentHealth() {
  return [...health.entries()].map(([key, value]) => {
    const [sshHost, root] = key.split('\0')
    return { sshHost, root, ...value }
  })
}

export function subscribeRemoteAgentHealth(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tests only: drop every entry so cases cannot leak into each other. */
export function resetRemoteAgentHealth() {
  health.clear()
}
