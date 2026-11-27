import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The contract that makes this repository installable as a drop-in: the runtime
 * `.mjs` files only reference each other, and everything that ships is listed in
 * exactly the same places. A file that reaches outside the mirror still works
 * inside the app (where `../components` exists) and fails on a user's machine.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relative = (file) => file.slice(root.length + 1).split('\\').join('/')

/** Every root-level runtime module — the plugin halves are loaded dynamically. */
function runtimeFiles() {
  return readdirSync(root)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort()
}

/** Relative specifiers the file names, static (`from`) or literal (`import('…')`). */
function relativeSpecifiers(file) {
  const text = readFileSync(file, 'utf8')
  const out = new Set()
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)) out.add(match[1])
  for (const match of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/gu)) out.add(match[1])
  for (const match of text.matchAll(/new URL\(\s*['"](\.[^'"]+)['"]/gu)) out.add(match[1])
  return [...out]
}

test('every sibling runtime reference resolves inside the mirror', () => {
  // `./x.mjs` is the drop-in half and must be shipped; `../x` is the app half
  // (components, tui-host-api) that only resolves inside the desktop build.
  const sibling = (specifier) => specifier.startsWith('./') && specifier.endsWith('.mjs')
  for (const name of runtimeFiles()) {
    for (const specifier of relativeSpecifiers(join(root, name)).filter(sibling)) {
      assert.ok(
        existsSync(resolve(root, specifier)),
        `${name} refers to ${specifier}, which the mirror does not ship`,
      )
    }
  }
  // Keep the split honest, both ways: the UI half still reaches into the app,
  // and no other runtime module does — those are the drop-in half.
  const appImports = relativeSpecifiers(join(root, 'remote-agent.plugin.mjs')).filter((specifier) =>
    specifier.startsWith('../'),
  )
  assert.ok(appImports.length > 0, 'the UI half should still declare its app imports')
  for (const name of runtimeFiles().filter((file) => file !== 'remote-agent.plugin.mjs')) {
    const outside = relativeSpecifiers(join(root, name)).filter((specifier) =>
      specifier.startsWith('../'),
    )
    assert.deepEqual(outside, [], `${name} reaches outside the mirror: ${outside.join(', ')}`)
  }
})

test('install.sh copies exactly the runtime set', () => {
  const script = readFileSync(join(root, 'install.sh'), 'utf8')
  const block = script.match(/PLUGIN_FILES=\(([\s\S]*?)\)/u)?.[1] ?? ''
  const listed = [...block.matchAll(/([\w.-]+\.mjs)/gu)].map((match) => match[1]).sort()
  assert.deepEqual(listed, runtimeFiles())
})

test('the sync manifest lists the same plugin set, and every native row exists', () => {
  const rows = readFileSync(join(root, 'scripts/sync-manifest.txt'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
  const plugins = rows
    .filter((line) => line.startsWith('plugin '))
    .map((line) => line.slice('plugin '.length).trim())
    .sort()
  assert.deepEqual(plugins, runtimeFiles())
  for (const line of rows) {
    const [kind, rel] = line.trim().split(/\s+/u)
    if (kind === 'native') {
      assert.ok(existsSync(join(root, 'native', rel)), `native ${rel} is listed but missing`)
    }
  }
})

test('the shipped agent source matches the protocol the bridge requires', () => {
  const source = readFileSync(join(root, 'native', 'waw-remote-agent', 'protocol.go'), 'utf8')
  const version = source.match(/const protocolVersion = (\d+)/u)
  const required = readFileSync(join(root, 'remote-bridge.mjs'), 'utf8').match(
    /export const REQUIRED_PROTOCOL_VERSION = (\d+)/u,
  )
  // A renamed constant must fail loudly here, not as NaN === NaN-style silence.
  assert.ok(version, 'protocol.go lost its `const protocolVersion`')
  assert.ok(required, 'remote-bridge.mjs lost its `REQUIRED_PROTOCOL_VERSION`')
  assert.equal(Number(version[1]), Number(required[1]))
})
