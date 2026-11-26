import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  extrasDirs,
  hostTargetPlatform,
  isAbsoluteWorkspacePath,
  multiplexArgs,
  normalizeRemoteArch,
  normalizeRemoteOs,
  resolveControlMasterDir,
  resolveLocalBinary,
} from '../remote-bridge.mjs'

test('normalizes OS and architecture identifiers across macOS, Linux, and Windows', () => {
  assert.equal(normalizeRemoteOs('Darwin'), 'darwin')
  assert.equal(normalizeRemoteOs('darwin'), 'darwin')
  assert.equal(normalizeRemoteOs('Linux'), 'linux')
  assert.equal(normalizeRemoteOs('win32'), 'windows')
  assert.equal(normalizeRemoteOs('MINGW64_NT-10.0'), 'windows')

  assert.equal(normalizeRemoteArch('arm64'), 'arm64')
  assert.equal(normalizeRemoteArch('aarch64'), 'arm64')
  assert.equal(normalizeRemoteArch('x86_64'), 'amd64')
  assert.equal(normalizeRemoteArch('x64'), 'amd64')

  assert.deepEqual(hostTargetPlatform('darwin', 'arm64'), { os: 'darwin', arch: 'arm64' })
  assert.deepEqual(hostTargetPlatform('darwin', 'x64'), { os: 'darwin', arch: 'amd64' })
  assert.deepEqual(hostTargetPlatform('win32', 'x64'), { os: 'windows', arch: 'amd64' })
  assert.deepEqual(hostTargetPlatform('linux', 'arm64'), { os: 'linux', arch: 'arm64' })
})

test('extrasDirs includes macOS Application Support and Windows AppData locations', () => {
  const macDirs = extrasDirs('darwin', {}, '/Users/alice')
  assert.ok(macDirs.includes('/Users/alice/Library/Application Support/waw/extras'))
  assert.ok(macDirs.includes('/Users/alice/.local/share/waw/extras'))

  const winDirs = extrasDirs(
    'win32',
    { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
    'C:\\Users\\alice',
  )
  assert.ok(winDirs.some((d) => d.includes('AppData\\Local') && d.endsWith(join('waw', 'extras'))))
  assert.ok(winDirs.some((d) => d.includes('AppData\\Roaming') && d.endsWith(join('waw', 'extras'))))
})

test('resolveControlMasterDir and multiplexArgs handle macOS socket path cap and Windows', () => {
  const shortMac = resolveControlMasterDir('darwin', '/Users/al')
  assert.equal(shortMac, '/Users/al/.waw/ssh-cm')

  const longMac = resolveControlMasterDir('darwin', '/Users/very-long-macos-username-example-account')
  assert.match(longMac, /^\/tmp\/waw-cm-/)

  const winArgs = multiplexArgs('win32', 'C:\\Users\\alice')
  assert.deepEqual(winArgs, ['-o', 'ConnectTimeout=15'])

  const macArgs = multiplexArgs('darwin', '/Users/al')
  assert.ok(macArgs.includes('ControlMaster=auto'))
  assert.ok(macArgs.some((a) => a.startsWith('ControlPath=')))
})

test('resolveLocalBinary prefers target-qualified binary for cross-platform SSH and falls back to generic', () => {
  const repoRoot = '/repo'
  const files = new Set([
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-darwin-arm64',
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-linux-amd64',
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-windows-amd64.exe',
    '/repo/native/waw-remote-agent/dist/waw-remote-agent',
  ])
  const baseOpts = {
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    home: '/Users/alice',
    cwd: '/other',
    here: repoRoot,
    exists: (p) => files.has(p),
  }

  assert.equal(
    resolveLocalBinary({ os: 'darwin', arch: 'arm64' }, baseOpts),
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-darwin-arm64',
  )
  assert.equal(
    resolveLocalBinary({ os: 'linux', arch: 'amd64' }, baseOpts),
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-linux-amd64',
  )
  assert.equal(
    resolveLocalBinary({ os: 'windows', arch: 'amd64' }, baseOpts),
    '/repo/native/waw-remote-agent/dist/waw-remote-agent-windows-amd64.exe',
  )
  // Fallback to generic binary when exact target-qualified binary is absent
  assert.equal(
    resolveLocalBinary({ os: 'darwin', arch: 'amd64' }, baseOpts),
    '/repo/native/waw-remote-agent/dist/waw-remote-agent',
  )
})

test('isAbsoluteWorkspacePath accepts POSIX/macOS and Windows drive paths', () => {
  assert.equal(isAbsoluteWorkspacePath('/Users/alice/project'), true)
  assert.equal(isAbsoluteWorkspacePath('/data/ws'), true)
  assert.equal(isAbsoluteWorkspacePath('C:\\Users\\alice\\project'), true)
  assert.equal(isAbsoluteWorkspacePath('D:/work/repo'), true)
  assert.equal(isAbsoluteWorkspacePath('relative/path'), false)
  assert.equal(isAbsoluteWorkspacePath(''), false)
})
