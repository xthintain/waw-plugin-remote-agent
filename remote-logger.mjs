/**
 * Structured full log system for waw-plugin-remote-agent (Node / tui-host side).
 *
 * Features:
 * - JSONL persistent log file (~/.waw/logs/remote-agent.log or WAW_REMOTE_AGENT_LOG_FILE)
 * - Automatic size-based rotation (default 5 MiB, keeping .1 / .2 backups)
 * - In-memory ring buffer for fast tail/filter queries (`readLogs`, `remote::logs` tool)
 * - Log levels: debug | info | warn | error (WAW_REMOTE_AGENT_LOG_LEVEL, default info)
 * - Automatic secret redaction (tokens, passphrases, Authorization headers, PATs)
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
})

const REDACTED = '[REDACTED]'
const SENSITIVE_KEY_RE = /(token|passphrase|password|secret|authorization|cookie|pat)/i
const SECRET_VALUE_RE = /\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)\b/gi

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_BACKUPS = 2
const DEFAULT_RING_LIMIT = 500

let configuredFile = ''
let configuredLevel = ''
let configuredMaxBytes = DEFAULT_MAX_BYTES
let configuredMaxBackups = DEFAULT_MAX_BACKUPS

/** @type {Array<Record<string, unknown>>} */
const ringBuffer = []

function normalizeLevel(raw) {
  const value = String(raw ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, value) ? value : 'info'
}

export function getLogLevel() {
  return normalizeLevel(configuredLevel || process.env.WAW_REMOTE_AGENT_LOG_LEVEL || 'info')
}

export function getLogFilePath() {
  if (configuredFile) return configuredFile
  const envFile = process.env.WAW_REMOTE_AGENT_LOG_FILE?.trim()
  if (envFile) return envFile
  return join(homedir() || tmpdir(), '.waw', 'logs', 'remote-agent.log')
}

export function configureLogger(opts = {}) {
  if (typeof opts.filePath === 'string') configuredFile = opts.filePath.trim()
  if (typeof opts.level === 'string') configuredLevel = opts.level.trim()
  if (typeof opts.maxBytes === 'number' && opts.maxBytes > 0) configuredMaxBytes = opts.maxBytes
  if (typeof opts.maxBackups === 'number' && opts.maxBackups >= 0) {
    configuredMaxBackups = Math.floor(opts.maxBackups)
  }
}

export function resetLoggerConfig() {
  configuredFile = ''
  configuredLevel = ''
  configuredMaxBytes = DEFAULT_MAX_BYTES
  configuredMaxBackups = DEFAULT_MAX_BACKUPS
}

/** Recursively redact sensitive keys and token patterns before writing logs. */
export function sanitizeLogValue(value, depth = 0) {
  if (depth > 5) return '[Truncated]'
  if (value == null) return value
  if (typeof value === 'string') {
    const cleaned = value.replace(SECRET_VALUE_RE, REDACTED)
    return cleaned.length > 2000 ? `${cleaned.slice(0, 2000)}…[truncated]` : cleaned
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogValue(value.message, depth + 1),
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = REDACTED
      } else if (v !== undefined) {
        out[k] = sanitizeLogValue(v, depth + 1)
      }
    }
    return out
  }
  return String(value)
}

function rotateIfNeeded(filePath) {
  try {
    if (!existsSync(filePath)) return
    const st = statSync(filePath)
    if (st.size < configuredMaxBytes) return
    for (let i = configuredMaxBackups; i >= 1; i--) {
      const older = `${filePath}.${i}`
      if (i === configuredMaxBackups && existsSync(older)) {
        unlinkSync(older)
      }
      const prev = i === 1 ? filePath : `${filePath}.${i - 1}`
      if (existsSync(prev)) {
        renameSync(prev, older)
      }
    }
  } catch {
    /* never crash caller due to log rotation */
  }
}

function writeLogLine(entry) {
  ringBuffer.push(entry)
  if (ringBuffer.length > DEFAULT_RING_LIMIT) {
    ringBuffer.splice(0, ringBuffer.length - DEFAULT_RING_LIMIT)
  }
  const filePath = getLogFilePath()
  if (!filePath || filePath === 'off' || filePath === 'none') return
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    rotateIfNeeded(filePath)
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* logging must never break tool execution */
  }
}

export function logEvent(level, component, event, fields = {}) {
  const normalized = normalizeLevel(level)
  if (LOG_LEVELS[normalized] < LOG_LEVELS[getLogLevel()]) return null
  const safeFields = sanitizeLogValue(fields)
  const entry = {
    ts: new Date().toISOString(),
    level: normalized,
    component: String(component || 'remote-agent'),
    event: String(event || 'log'),
    ...(safeFields && typeof safeFields === 'object' ? safeFields : {}),
  }
  writeLogLine(entry)
  return entry
}

export const logger = {
  debug: (component, event, fields) => logEvent('debug', component, event, fields),
  info: (component, event, fields) => logEvent('info', component, event, fields),
  warn: (component, event, fields) => logEvent('warn', component, event, fields),
  error: (component, event, fields) => logEvent('error', component, event, fields),
}

/**
 * Forward raw stderr lines from the Go native binary into the structured log.
 * If a line is already a JSON log emitted by Go, merge its fields cleanly.
 */
export function logNativeStderr(chunk, meta = {}) {
  const text = String(chunk ?? '')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && parsed.event) {
        const {
          component: nativeComponent,
          ts: nativeTs,
          level: nativeLevel,
          event: nativeEvent,
          ...rest
        } = parsed
        const lvl = normalizeLevel(nativeLevel || 'info')
        logEvent(lvl, 'native-agent', String(nativeEvent), {
          ...meta,
          ...rest,
          nativeComponent,
          nativeTs,
        })
        continue
      }
    } catch {
      /* plain text stderr line */
    }
    logEvent('warn', 'native-agent', 'stderr', { ...meta, message: line })
  }
}

/** Read and filter structured log entries (from disk if available, else ring buffer). */
export function readLogs({ limit = 100, level = '', component = '', search = '', since = '' } = {}) {
  const filePath = getLogFilePath()
  let entries = []
  if (filePath && filePath !== 'off' && filePath !== 'none' && existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          entries.push(JSON.parse(trimmed))
        } catch {
          entries.push({ ts: '', level: 'info', component: 'raw', event: 'line', message: trimmed })
        }
      }
    } catch {
      entries = [...ringBuffer]
    }
  } else {
    entries = [...ringBuffer]
  }

  const minRank = level ? LOG_LEVELS[normalizeLevel(level)] : 0
  const compFilter = String(component || '').trim().toLowerCase()
  const searchFilter = String(search || '').trim().toLowerCase()
  const sinceMs = since ? Date.parse(since) : NaN

  const filtered = entries.filter((e) => {
    if (minRank && (LOG_LEVELS[normalizeLevel(e.level)] ?? 0) < minRank) return false
    if (compFilter && String(e.component || '').toLowerCase() !== compFilter) return false
    if (!Number.isNaN(sinceMs) && e.ts && Date.parse(e.ts) < sinceMs) return false
    if (searchFilter && !JSON.stringify(e).toLowerCase().includes(searchFilter)) return false
    return true
  })

  const max = Math.max(1, Math.min(1000, Number(limit) || 100))
  return filtered.slice(-max)
}

/** Clear both in-memory ring buffer and the active log file. */
export function clearLogs() {
  ringBuffer.length = 0
  const filePath = getLogFilePath()
  if (filePath && filePath !== 'off' && filePath !== 'none' && existsSync(filePath)) {
    try {
      writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 })
    } catch {
      /* ignore */
    }
  }
}
