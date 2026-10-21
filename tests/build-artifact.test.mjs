import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const stage = new URL('../dist/hermes-molstar/', import.meta.url)

test('staged unified package has all public-contract entry points', async () => {
  for (const relative of [
    'plugin.yaml', '__init__.py', 'dashboard/manifest.json', 'dashboard/plugin_api.py',
    'desktop/plugin.js', 'dashboard/viewer-document.json',
    'skills/molstar-viewer/SKILL.md', 'THIRD_PARTY_NOTICES.md',
    'third_party/molstar-LICENSE.txt', 'BUILD_MANIFEST.json'
  ]) {
    assert.equal((await stat(new URL(relative, stage))).isFile(), true, relative)
  }
})

test('desktop artifact stays under Hermes limit and imports only supported runtime modules', async () => {
  const file = new URL('desktop/plugin.js', stage)
  const bytes = (await stat(file)).size
  assert.ok(bytes < 16 * 1024 * 1024, `${bytes} exceeds the Hermes plugin source cap`)
  assert.ok(bytes < 512 * 1024, `${bytes} is not a thin Desktop shell`)
  const source = await readFile(file, 'utf8')
  const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*)(["'])([^"']+)\1/g)].map(match => match[2])
  assert.ok(imports.length > 0)
  assert.ok(imports.every(value => value === 'react' || value.startsWith('react/') || value === '@hermes/plugin-sdk'))
  assert.doesNotMatch(source, /<script\b/i)
  assert.doesNotMatch(source, /createElement\(["']script["']\)/i)
  assert.doesNotMatch(source, /DecompressionStream|atob\(/)
})

test('controlled backend viewer document is self-contained and integrity-addressed', async () => {
  const raw = await readFile(new URL('dashboard/viewer-document.json', stage), 'utf8')
  const artifact = JSON.parse(raw)
  assert.equal(artifact.schema, 1)
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
  assert.equal(typeof artifact.document, 'string')
  assert.match(artifact.document, /^<!doctype html>/i)
  assert.equal(createHash('sha256').update(artifact.document).digest('hex'), artifact.sha256)
  assert.match(artifact.document, /script-src 'unsafe-inline' 'unsafe-eval'/)
  assert.match(artifact.document, /connect-src data:/)
  assert.doesNotMatch(artifact.document, /https?:\/\//i)
})

test('lockfile pins exact Molstar release and build dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
  assert.equal(manifest.engines.node, '>=22')
  assert.equal(lock.packages[''].engines.node, '>=22')
  assert.equal(lock.packages['node_modules/molstar'].version, '5.13.1')
  assert.equal(lock.packages['node_modules/esbuild'].version, '0.25.11')
  const readme = await readFile(new URL('README.md', root), 'utf8')
  assert.match(readme, /Requirements are Node\.js 22 or newer/)
})

test('README keeps installation profile-aware with two independent opt-ins', async () => {
  const readme = await readFile(new URL('README.md', root), 'utf8')
  assert.doesNotMatch(readme, /\$env:USERPROFILE|Join-Path\s+\$env:USERPROFILE/i)
  assert.match(readme, /effective `HERMES_HOME`/)
  assert.match(readme, /hermes -p \$profileName plugins enable hermes-molstar/)
  assert.match(readme, /Desktop half has a \*\*separate opt-in\*\*/)
  assert.match(readme, /Both switches default off/)
  assert.match(readme, /browser-local viewing needs the Python\/backend half enabled and reachable/)
  assert.match(readme, /Desktop half must also be installed on the Desktop machine/)
})

test('browser smoke harness embeds the same opaque sandboxed offline viewer', async () => {
  const smoke = await readFile(new URL('../dist/browser-smoke/index.html', import.meta.url), 'utf8')
  const embeddedUrl = smoke.match(/viewer\.src="([^"]+)"/)?.[1]
  assert.ok(embeddedUrl)
  const decoded = decodeURIComponent(embeddedUrl)
  assert.match(smoke, /sandbox="allow-scripts"/)
  assert.match(smoke, /data:text\/html;charset=utf-8,/)
  // Mol* 5.13.1 contains an Emscripten helper that constructs a function at
  // runtime; confine that permission to the opaque, no-network viewer frame.
  assert.match(decoded, /script-src 'unsafe-inline' 'unsafe-eval'/)
  assert.match(decoded, /connect-src data:/)
  assert.match(smoke, /event\.source!==viewer\.contentWindow/)
  assert.match(smoke, /data\.nonce!==nonce/)
  assert.match(smoke, /requestId/)
  assert.match(smoke, /data\.payload\.requestId!==pending\.requestId/)
  assert.match(smoke, /viewerStartedOnline=navigator\.onLine/)
})

test('browser evidence pins the exact staged shell and viewer-document artifacts', async () => {
  const evidence = JSON.parse(await readFile(new URL('docs/evidence/browser-smoke.json', root), 'utf8'))
  for (const [key, relative] of [
    ['desktopPlugin', 'dist/hermes-molstar/desktop/plugin.js'],
    ['viewerDocument', 'dist/hermes-molstar/dashboard/viewer-document.json']
  ]) {
    const bytes = await readFile(new URL(relative, root))
    assert.equal(evidence.artifacts?.[key]?.path, relative)
    assert.equal(evidence.artifacts?.[key]?.bytes, bytes.byteLength)
    assert.equal(evidence.artifacts?.[key]?.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
})
