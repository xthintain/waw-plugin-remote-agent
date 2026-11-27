/**
 * Remote host OS rules: paths, quoting and the PowerShell bootstrap command.
 *
 * The SSH bridge (this plugin directory) and the TUI host (`tui/src/agent/remote/flavor.ts`)
 * both need these rules. The host cannot import this file and this file cannot import
 * TypeScript, so the logic exists twice and the two test suites share the same vectors.
 *
 * A remote root is ALWAYS written with forward slashes, even on Windows
 * (`C:/Users/qthin/ws`). Windows accepts them in PowerShell cmdlets and git, and one
 * spelling keeps the `ssh://host/C:/…` location, the worker's `--workspace` and the
 * tool adapters in agreement.
 */

const DRIVE_ABS = /^[A-Za-z]:\//

export function toForwardSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** `C:/x` or `c:\x`; `C:` alone is not a root (Windows reads it as that drive's cwd). */
export function isWindowsRoot(value) {
  return DRIVE_ABS.test(toForwardSlashes(value).trim())
}

export function remoteFlavorOf(root) {
  return isWindowsRoot(root) ? 'windows' : 'posix'
}

export function isAbsoluteRemoteRoot(value) {
  const text = toForwardSlashes(value).trim()
  return text.startsWith('/') || DRIVE_ABS.test(text)
}

/**
 * Canonical spelling: forward slashes, trailing slashes removed, drive letter upper-case.
 *
 * A drive root keeps its slash (`C:/`): `C:` means "this drive's current directory" in
 * Windows, a different place. Inside paths keep their case — Windows is case-insensitive
 * but does not report the on-disk spelling back to us.
 */
export function normalizeRemoteRoot(root) {
  const text = toForwardSlashes(root).trim()
  if (!text) return '/'
  if (DRIVE_ABS.test(text)) {
    const drive = `${text[0].toUpperCase()}:`
    const rest = text
      .slice(2)
      .replace(/\/+/g, '/')
      .replace(/\/+$/, '')
    return rest ? `${drive}${rest.startsWith('/') ? '' : '/'}${rest}` : `${drive}/`
  }
  const trimmed = text.replace(/\/+$/, '')
  return trimmed || '/'
}

/**
 * Where the directory browser starts when no path is given.
 *
 * POSIX has one tree from `/`. Windows has one fence per drive, and its system
 * drive is not always `C:` — the drive that holds HOME is the meaningful
 * starting point, and any mounted drive will do when HOME is unavailable.
 */
export function browseRoot(flavor, info = {}) {
  if (flavor !== 'windows') return '/'
  const home = info.home ? normalizeRemoteRoot(info.home) : ''
  const homeDrive = DRIVE_ABS.test(home) ? normalizeRemoteRoot(`${home.slice(0, 2)}/`) : ''
  const drives = normalizeDrives(info.drives ?? [])
  if (homeDrive && drives.some((drive) => sameRemotePath(drive, homeDrive, 'windows'))) {
    return homeDrive
  }
  if (drives.length > 0) return drives[0]
  return homeDrive || '/'
}

/** `uname -m` / `PROCESSOR_ARCHITECTURE` spellings → Go's GOARCH. */
export function normalizeArch(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['amd64', 'x86_64', 'x64', 'amd64_nt'].includes(text)) return 'amd64'
  if (['arm64', 'aarch64'].includes(text)) return 'arm64'
  if (['386', 'x86', 'i386', 'i686'].includes(text)) return '386'
  return text
}

/**
 * The remote's drives, canonicalised for `--root` and for the drive switcher.
 *
 * Windows mounts one root per drive and a worker fenced to `C:/` answers
 * "path outside allowed roots" for `D:/…`, so a mature browser treats mounting
 * drives as separate top-level entries instead of one filesystem tree.
 */
export function normalizeDrives(values) {
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    const text = toForwardSlashes(value).trim()
    // Only a bare drive (`D:`, `D:\`, `D:/`); a path is not a drive. A bare
    // `D:` is that drive's current directory elsewhere, but as a DRIVE it is
    // the root, so put the slash back before normalising.
    if (!/^[A-Za-z]:[\\/]*$/.test(text)) continue
    const root = normalizeRemoteRoot(`${text.slice(0, 2)}/`)
    if (!out.some((drive) => sameRemotePath(drive, root, 'windows'))) out.push(root)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * Parse the Windows probe (see `probeWindowsHost` in the bridge).
 *
 * Line-oriented on purpose: Windows PowerShell 5.1 has no `ConvertTo-Json -AsArray`,
 * so a one-drive host would answer with an object where the code expects a list.
 * Each line carries its own marker; the drive is the field before the label.
 *
 * `bins` is what the remote's `.waw/bin` currently holds. The build to expect
 * depends on the arch the probe just reported and on this desktop's hash, so
 * "installed" is decided by the bridge, not here.
 */
export function parseWindowsProbe(output) {
  const lines = String(output ?? '').split(/\r?\n/)
  const homeLine = lines.find((line) => line.startsWith('__WAWHOME__'))
  if (!homeLine) return null
  const home = normalizeRemoteRoot(homeLine.slice('__WAWHOME__'.length))
  if (!DRIVE_ABS.test(home)) return null
  const archLine = lines.find((line) => line.startsWith('__WAWARCH__'))
  const arch = normalizeArch(archLine?.slice('__WAWARCH__'.length))
  const drives = normalizeDrives(
    lines
      .filter((line) => line.startsWith('__WAWDRIVE__'))
      .map((line) => line.slice('__WAWDRIVE__'.length).split('|')[0]),
  )
  const bins = lines
    .filter((line) => line.startsWith('__WAWBIN__'))
    .map((line) => line.slice('__WAWBIN__'.length).trim())
    .filter(Boolean)
  return { home, arch, drives, bins }
}

/**
 * Parse the POSIX probe: `home__WAW__installed__WAW__Linux__WAW__x86_64`.
 * The OS/arch fields are newer than the first two, so their absence is fine.
 */
export function parsePosixProbe(output) {
  const parts = String(output ?? '')
    .trim()
    .split('__WAW__')
  if (parts.length < 2) return null
  const home = normalizeRemoteRoot(parts[0])
  if (!home.startsWith('/')) return null
  return {
    home,
    installed: parts[1]?.trim() === 'installed',
    osName: String(parts[2] ?? '').trim().toLowerCase(),
    arch: normalizeArch(parts[3]),
  }
}

/** Does `path` sit at or below `root`? Windows compares without case. */
export function remotePathInside(root, path, flavor = remoteFlavorOf(root)) {
  const r = normalizeRemoteRoot(root)
  const p = normalizeRemoteRoot(path)
  if (flavor === 'windows') {
    const rr = r.toLowerCase()
    const pp = p.toLowerCase()
    return pp === rr || (rr.endsWith('/') ? pp.startsWith(rr) : pp.startsWith(`${rr}/`))
  }
  return p === r || r === '/' || p.startsWith(`${r}/`)
}

export function sameRemotePath(a, b, flavor = remoteFlavorOf(a)) {
  const left = normalizeRemoteRoot(a)
  const right = normalizeRemoteRoot(b)
  return flavor === 'windows' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** `base` + `name`, keeping drive roots (`C:/` + `x` → `C:/x`). */
export function joinRemotePath(base, name) {
  const root = normalizeRemoteRoot(base)
  const child = String(name ?? '').replace(/^\/+/, '')
  if (!child) return root
  return root.endsWith('/') ? `${root}${child}` : `${root}/${child}`
}

/**
 * (host, root) → `ssh://host/<root>`, the one spelling projects are stored by.
 * A Windows root needs a separator before the drive letter.
 */
export function remoteLocation(host, root) {
  const name = String(host ?? '').trim()
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || !isAbsoluteRemoteRoot(root)) return null
  const dir = normalizeRemoteRoot(root)
  return dir.startsWith('/') ? `ssh://${name}${dir}` : `ssh://${name}/${dir}`
}

/** PowerShell single-quote. Doubling `'` is the language's own escape. */
export function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** File-system paths inside PowerShell scripts: cmdlets accept `\` everywhere. */
export function psPath(path) {
  return String(path ?? '').replace(/\//g, '\\')
}

/**
 * One PowerShell invocation as an SSH remote command.
 *
 * The remote's default shell is cmd.exe on Windows; `-EncodedCommand` carries the script
 * as base64 (UTF-16LE), so cmd only ever sees `powershell … <base64>` — no quotes,
 * `^`-escapes or backslash mangling to get wrong. `exe` is the binary the probe
 * found (`powershell` on a stock Windows, `pwsh` where 5.1 is absent).
 */
export function powershellCommand(script, exe = 'powershell') {
  const encoded = Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
  return `${exe} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

/**
 * UTF-8 both ways, no progress records, stop at the first error.
 *
 * Windows PowerShell writes its streams as CLIXML when they are redirected
 * (`#< CLIXML … _x000D_`), which turns a one-line failure into unreadable wire
 * text. `SilentlyContinue` drops the "Preparing modules for first use" progress
 * record, and `Stop` makes a cmdlet failure actually fail the remote command
 * (non-terminating errors otherwise leave the exit code at 0).
 */
export const PS_PRELUDE =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' +
  "$ProgressPreference='SilentlyContinue'\n" +
  "$ErrorActionPreference='Stop'\n"

/** Create a directory literally (no wildcard interpretation, unlike -Path). */
export function psMkdir(path) {
  return `[IO.Directory]::CreateDirectory(${psQuote(path)}) | Out-Null`
}

/**
 * A one-shot bootstrap script: prelude + the body, with the failure written as
 * plain text instead of PowerShell's CLIXML error record.
 */
export function psScript(body, exe = 'powershell') {
  return powershellCommand(
    `${PS_PRELUDE}try {\n${String(body ?? '')}\n} catch {\n[Console]::Error.WriteLine($_.Exception.Message)\nexit 1\n}\n`,
    exe,
  )
}

/**
 * The versioned remote binary. Windows refuses to replace a running .exe, so the name
 * carries the target arch and the local content hash; a new build lands beside the
 * old one. POSIX keeps the historical fixed name (the remote file is replaced in
 * place, which POSIX allows).
 */
export function remoteBinName(flavor, sha8, arch = '') {
  if (flavor !== 'windows') return 'waw-remote-agent'
  const target = normalizeArch(arch)
  if (!target) throw new Error('remote arch is required to name a Windows agent binary')
  return `waw-remote-agent-windows-${target}-${sha8}.exe`
}
