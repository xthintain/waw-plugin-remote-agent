import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  POSIX_PROTOCOL_VERSION,
  REQUIRED_PROTOCOL_VERSION,
  binaryNamesFor,
  multiplexArgs,
  resolveControlMasterDir,
} from '../remote-bridge.mjs'

/**
 * Which local build gets uploaded for a remote target, plus the two SSH details
 * that differ per platform. A name that forgets the arch uploads a binary the
 * host cannot execute; a wrong control socket breaks every ssh call on macOS.
 */
const local = { osName: 'linux', arch: 'amd64' }

test('names the build for the probed target, never another arch', () => {
  assert.deepEqual(binaryNamesFor('windows', { arch: 'amd64' }, local), [
    'waw-remote-agent-windows-amd64.exe',
    'waw-remote-agent.exe',
  ])
  // PROCESSOR_ARCHITECTURE spellings are normalised, not passed through, and the
  // legacy unversioned exe is only ever offered to this desktop's own target.
  assert.deepEqual(binaryNamesFor('windows', { arch: 'ARM64' }, local), [
    'waw-remote-agent-windows-arm64.exe',
  ])
  assert.deepEqual(binaryNamesFor('posix', { osName: 'darwin', arch: 'arm64' }, local), [
    'waw-remote-agent-darwin-arm64',
  ])
  // A probe that said nothing falls back to this desktop's own target.
  assert.deepEqual(binaryNamesFor('posix', {}, local), [
    'waw-remote-agent-linux-amd64',
    'waw-remote-agent',
  ])
})

test('pins the protocol versions the mirror ships', () => {
  // A mirror that silently drifts to an older protocol installs a binary the
  // app refuses to use. Bump these together with native/waw-remote-agent.
  assert.equal(REQUIRED_PROTOCOL_VERSION, 6)
  assert.equal(POSIX_PROTOCOL_VERSION, 5)
})

test('moves the macOS control socket to /tmp only when the path cannot fit', () => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u'
  const longHome = '/Users/avery.very.long.account.name.here'
  // macOS caps sockaddr_un.sun_path at 104 bytes; ~/.waw/ssh-cm/<40-char hash>
  // plus OpenSSH's own suffix overflows it, and every ssh call fails.
  assert.equal(resolveControlMasterDir('darwin', longHome), `/tmp/waw-cm-${uid}`)
  // A short home still fits, and Linux is not capped at all.
  assert.equal(resolveControlMasterDir('darwin', '/home/u'), join('/home/u', '.waw', 'ssh-cm'))
  assert.equal(resolveControlMasterDir('linux', longHome), join(longHome, '.waw', 'ssh-cm'))
})

test('asks Windows OpenSSH for no control socket, and points ControlPath at the resolved dir', () => {
  assert.deepEqual(multiplexArgs('win32', 'C:\\Users\\alice'), ['-o', 'ConnectTimeout=15'])
  // A real temp home, so the assertion also covers the directory ssh needs to
  // exist before the first connection (a hardcoded /home/u would mkdir a path
  // outside the test on Windows and prove nothing).
  const home = mkdtempSync(join(tmpdir(), 'waw-cm-'))
  try {
    const dir = resolveControlMasterDir('linux', home)
    const args = multiplexArgs('linux', home)
    assert.ok(args.includes('ControlMaster=auto'))
    assert.ok(args.includes(`ControlPath=${dir}/%C`))
    assert.ok(args.includes('ControlPersist=120'))
    assert.ok(existsSync(dir), `control socket directory was not created: ${dir}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
