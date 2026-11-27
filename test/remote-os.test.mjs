import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browseRoot,
  isAbsoluteRemoteRoot,
  isWindowsRoot,
  joinRemotePath,
  normalizeArch,
  normalizeDrives,
  normalizeRemoteRoot,
  parsePosixProbe,
  parseWindowsProbe,
  powershellCommand,
  psMkdir,
  psPath,
  psQuote,
  psScript,
  remoteBinName,
  remoteFlavorOf,
  remoteLocation,
  remotePathInside,
  sameRemotePath,
  toForwardSlashes,
} from '../remote-os.mjs'

/**
 * The cross-platform rules the bridge and the TUI host share. They decide which
 * binary is uploaded, which root a worker is fenced to and how a command reaches
 * PowerShell — each one is silent when it is wrong, so they are pinned here.
 */

test('spells remote roots with forward slashes and keeps drive roots', () => {
  assert.equal(toForwardSlashes('C:\\Users\\alice'), 'C:/Users/alice')
  assert.equal(isWindowsRoot('C:\\'), true)
  assert.equal(isWindowsRoot('c:/ws'), true)
  // `C:` alone means "that drive's current directory", not the root.
  assert.equal(isWindowsRoot('C:'), false)
  assert.equal(isWindowsRoot('/home/u'), false)
  assert.equal(remoteFlavorOf('d:/ws'), 'windows')
  assert.equal(remoteFlavorOf('/home/u'), 'posix')
  assert.equal(isAbsoluteRemoteRoot('/home/u'), true)
  assert.equal(isAbsoluteRemoteRoot('C:/ws'), true)
  assert.equal(isAbsoluteRemoteRoot('relative/path'), false)
})

test('normalises roots without inventing a different place', () => {
  assert.equal(normalizeRemoteRoot('C:\\Users\\alice\\'), 'C:/Users/alice')
  assert.equal(normalizeRemoteRoot('c:/'), 'C:/')
  assert.equal(normalizeRemoteRoot('/a/b/'), '/a/b')
  assert.equal(normalizeRemoteRoot(''), '/')
  assert.equal(normalizeRemoteRoot('/'), '/')
})

test('maps ps/host spellings to Go arch names', () => {
  assert.equal(normalizeArch('x86_64'), 'amd64')
  assert.equal(normalizeArch('AMD64'), 'amd64')
  assert.equal(normalizeArch('aarch64'), 'arm64')
  assert.equal(normalizeArch('i686'), '386')
  // Unknown spellings pass through so the caller can refuse them.
  assert.equal(normalizeArch('riscv64'), 'riscv64')
})

test('keeps one entry per drive and nothing that is not a drive', () => {
  assert.deepEqual(normalizeDrives(['C:', 'd:\\', 'C:\\', 'E:/ws', '//server/share']), [
    'C:/',
    'D:/',
  ])
  assert.deepEqual(normalizeDrives(undefined), [])
})

test('parses the POSIX probe, tolerating an older remote that omits os/arch', () => {
  assert.deepEqual(parsePosixProbe('/home/alice__WAW__installed__WAW__Linux__WAW__x86_64'), {
    home: '/home/alice',
    installed: true,
    osName: 'linux',
    arch: 'amd64',
  })
  assert.deepEqual(parsePosixProbe('/home/alice__WAW__missing'), {
    home: '/home/alice',
    installed: false,
    osName: '',
    arch: '',
  })
  assert.equal(parsePosixProbe('not a probe'), null)
})

test('parses the line-oriented Windows probe', () => {
  const output = [
    '__WAWHOME__C:\\Users\\alice',
    '__WAWARCH__AMD64',
    '__WAWDRIVE__C:\\|System',
    '__WAWDRIVE__D:\\|Data',
    '__WAWBIN__waw-remote-agent-windows-amd64-abcd1234.exe',
  ].join('\r\n')
  assert.deepEqual(parseWindowsProbe(output), {
    home: 'C:/Users/alice',
    arch: 'amd64',
    drives: ['C:/', 'D:/'],
    bins: ['waw-remote-agent-windows-amd64-abcd1234.exe'],
  })
  assert.equal(parseWindowsProbe('__WAWARCH__AMD64'), null)
})

test('fences paths inside their root, case-insensitively on Windows', () => {
  assert.equal(remotePathInside('/a', '/a'), true)
  assert.equal(remotePathInside('/a', '/a/b'), true)
  assert.equal(remotePathInside('/a', '/ab'), false)
  assert.equal(remotePathInside('/', '/anything'), true)
  assert.equal(remotePathInside('C:/ws', 'c:/WS/sub', 'windows'), true)
  assert.equal(remotePathInside('C:/ws', 'D:/ws', 'windows'), false)
  assert.equal(sameRemotePath('C:\\X', 'c:/x'), true)
  assert.equal(sameRemotePath('/A', '/a'), false)
})

test('joins and locates remote paths without losing the drive root', () => {
  assert.equal(joinRemotePath('C:/', 'ws'), 'C:/ws')
  assert.equal(joinRemotePath('/a', '/b'), '/a/b')
  assert.equal(joinRemotePath('/a/', ''), '/a')
  assert.equal(remoteLocation('host1', '/home/u'), 'ssh://host1/home/u')
  assert.equal(remoteLocation('host1', 'C:/ws'), 'ssh://host1/C:/ws')
  assert.equal(remoteLocation('bad host', '/x'), null)
  assert.equal(remoteLocation('host1', 'relative'), null)
})

test('quotes for PowerShell the way PowerShell escapes', () => {
  assert.equal(psQuote("a'b"), "'a''b'")
  assert.equal(psPath('C:/Users/alice'), 'C:\\Users\\alice')
  assert.match(psMkdir('C:\\ws'), /^\[IO\.Directory\]::CreateDirectory\('C:\\ws'\)/u)
})

test('carries a script as base64 so cmd.exe never sees quotes', () => {
  const command = powershellCommand("Write-Output 'hi'", 'pwsh')
  assert.ok(command.startsWith('pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '))
  const encoded = command.slice(command.lastIndexOf(' ') + 1)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), "Write-Output 'hi'")
  // The bootstrap wrapper keeps the prelude and turns a failure into plain text.
  // Spelling the prelude out here rather than comparing against PS_PRELUDE: the
  // point is that the wrapper *carries* it, and a same-module comparison would
  // pass even if the constant were emptied.
  const script = psScript('Get-ChildItem', 'powershell')
  const body = Buffer.from(script.slice(script.lastIndexOf(' ') + 1), 'base64').toString('utf16le')
  assert.ok(body.startsWith('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n'))
  assert.ok(body.includes("$ProgressPreference='SilentlyContinue'\n"))
  assert.ok(body.includes("$ErrorActionPreference='Stop'\n"))
  assert.match(body, /try \{[\s\S]*Get-ChildItem[\s\S]*\} catch \{/u)
})

test('names the remote binary per protocol: fixed on POSIX, versioned on Windows', () => {
  assert.equal(remoteBinName('posix', 'abcd1234'), 'waw-remote-agent')
  assert.equal(
    remoteBinName('windows', 'abcd1234', 'aarch64'),
    'waw-remote-agent-windows-arm64-abcd1234.exe',
  )
  // Windows refuses to replace a running exe, so the name must carry the arch.
  assert.throws(() => remoteBinName('windows', 'abcd1234'), /arch is required/u)
})

test('starts the directory browser at the drive HOME lives on', () => {
  assert.equal(browseRoot('posix'), '/')
  assert.equal(browseRoot('windows', { home: 'D:/Users/alice', drives: ['C:/', 'D:/'] }), 'D:/')
  assert.equal(browseRoot('windows', { home: 'D:/Users/alice', drives: ['C:/'] }), 'C:/')
  assert.equal(browseRoot('windows', {}), '/')
})
