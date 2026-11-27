/**
 * Strict mode isolation between `remote` (SSH) and `local` (local pipe) agent execution.
 *
 * The two modes are mutually exclusive and cannot be active simultaneously:
 * - In `remote` mode, only non-local SSH targets may run; `local` targets are blocked.
 * - In `local` mode, only `local` targets may run; remote SSH targets are blocked.
 * - Switching modes requires an explicit transition and tears down all active
 *   connections from the previous mode before activating the new mode.
 *
 * Zero Node.js imports so both `tui-host` (Node) and desktop webview (browser) can import it.
 */

export const AGENT_MODES = Object.freeze(['remote', 'local'])
export const DEFAULT_AGENT_MODE = 'remote'

/** @type {'remote' | 'local'} */
let currentMode = DEFAULT_AGENT_MODE

/** @type {Set<(event: { mode: 'remote' | 'local', previousMode: 'remote' | 'local', at: number }) => void>} */
const modeListeners = new Set()

/** Normalize and validate an agent mode string. */
export function normalizeAgentMode(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'remote' || value === 'local') return value
  return null
}

/** Return the currently active isolated mode ('remote' | 'local'). */
export function getAgentMode() {
  return currentMode
}

/** True when the given target/sshHost represents a local agent target. */
export function isLocalTarget(targetOrHost) {
  if (typeof targetOrHost === 'string') {
    return targetOrHost.trim() === 'local'
  }
  if (targetOrHost && typeof targetOrHost === 'object') {
    if (String(targetOrHost.authKind ?? '').trim() === 'local') return true
    if (String(targetOrHost.kind ?? '').trim() === 'local') return true
    return String(targetOrHost.sshHost ?? '').trim() === 'local'
  }
  return false
}

/** Required mode ('local' | 'remote') for a given target/sshHost. */
export function requiredModeForTarget(targetOrHost) {
  return isLocalTarget(targetOrHost) ? 'local' : 'remote'
}

/** Check whether a target/sshHost is permitted under the active mode. */
export function isTargetAllowedInMode(targetOrHost, mode = currentMode) {
  return requiredModeForTarget(targetOrHost) === mode
}

/**
 * Throw an explicit isolation error if `targetOrHost` does not belong to the
 * currently active mode.
 */
export function assertModeAllowsTarget(targetOrHost, mode = currentMode) {
  const needed = requiredModeForTarget(targetOrHost)
  if (needed === mode) return
  if (needed === 'local') {
    throw new Error(
      '当前处于 remote 模式，已与 local 模式隔离，无法使用 local agent；请先切换状态至 local 模式后再使用。',
    )
  }
  const host =
    typeof targetOrHost === 'string'
      ? targetOrHost.trim()
      : String(targetOrHost?.sshHost ?? targetOrHost?.host ?? 'remote').trim()
  throw new Error(
    `当前处于 local 模式，已与 remote 模式隔离，无法使用 remote agent（${host || 'ssh'}）；请先切换状态至 remote 模式后再使用。`,
  )
}

/**
 * Set the active mode directly (internal primitive; callers in Node should use
 * `switchAgentMode` from `remote-bridge.mjs` so existing connections are torn down first).
 */
export function setAgentModeRaw(nextMode) {
  const normalized = normalizeAgentMode(nextMode)
  if (!normalized) {
    throw new Error(`invalid agent mode "${nextMode}": must be "remote" or "local"`)
  }
  const previousMode = currentMode
  if (previousMode === normalized) {
    return { previousMode, mode: normalized, switched: false }
  }
  currentMode = normalized
  const event = { previousMode, mode: normalized, at: Date.now() }
  for (const listener of [...modeListeners]) {
    try {
      listener(event)
    } catch {
      /* ignore listener errors */
    }
  }
  return { previousMode, mode: normalized, switched: true }
}

/** Subscribe to mode transitions. Returns an unsubscribe function. */
export function subscribeAgentMode(listener) {
  if (typeof listener !== 'function') return () => {}
  modeListeners.add(listener)
  return () => {
    modeListeners.delete(listener)
  }
}

/** Reset mode back to default (primarily for tests). */
export function resetAgentMode(mode = DEFAULT_AGENT_MODE) {
  const normalized = normalizeAgentMode(mode) ?? DEFAULT_AGENT_MODE
  currentMode = normalized
  return currentMode
}
