import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  createOpenRequestStore,
  loadBrowserLocalFile,
  loadGatewayStructure,
  loadViewerDocument
} from '../src/shell-core.mjs'

test('open request store consumes a request once in its exact connection/profile/workspace scope', () => {
  const store = createOpenRequestStore()
  const scopeA = { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' }
  const scopeB = { connectionId: 'conn-b', profile: 'beta', workspaceRoot: '/work/b' }
  const seen = []
  store.publish({ requestId: '11111111-1111-4111-8111-111111111111', kind: 'gateway', scope: scopeA, attrs: { file: 'before.pdb' } })
  const stopWrong = store.subscribe(scopeB, value => seen.push(value))
  stopWrong()
  const stop = store.subscribe(scopeA, value => seen.push(value))
  assert.deepEqual(seen, [], 'a request observed in another scope must be discarded, not replayed later')
  store.publish({ requestId: '22222222-2222-4222-8222-222222222222', kind: 'gateway', scope: scopeA, attrs: { file: 'after.cif' } })
  stop()
  const stopAgain = store.subscribe(scopeA, value => seen.push(value))
  stopAgain()
  assert.deepEqual(seen.map(value => value.attrs.file), ['after.cif'])
})

test('open request store never retains a request rejected by an active different scope', () => {
  const store = createOpenRequestStore()
  const scopeA = { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' }
  const scopeB = { connectionId: 'conn-b', profile: 'beta', workspaceRoot: '/work/b' }
  const seen = []
  const stopB = store.subscribe(scopeB, value => seen.push(value))
  store.publish({
    requestId: '33333333-3333-4333-8333-333333333333',
    kind: 'gateway',
    scope: scopeA,
    attrs: { file: 'stale.pdb' }
  })
  stopB()
  const stopA = store.subscribe(scopeA, value => seen.push(value))
  stopA()
  assert.deepEqual(seen, [], 'an active scope mismatch must permanently discard the request')
})

test('browser-local file loading reads the File in the Desktop shell and never calls backend', async () => {
  let backendCalls = 0
  const file = {
    name: 'local.pdb',
    size: 26,
    async arrayBuffer() {
      return new TextEncoder().encode('HEADER X\nATOM  local atom\n').buffer
    }
  }
  const result = await loadBrowserLocalFile(file, async () => { backendCalls += 1 })
  assert.equal(backendCalls, 0)
  assert.equal(result.source, 'browser-local')
  assert.equal(result.name, 'local.pdb')
  assert.equal(result.format, 'pdb')
  assert.match(result.data, /^HEADER/)
})

test('browser-local loading rejects malformed UTF-8 bytes', async () => {
  const bytes = Uint8Array.from([0x48, 0x45, 0x41, 0x44, 0x45, 0x52, 0x0a, 0x41, 0x54, 0x4f, 0x4d, 0x20, 0xff])
  const file = {
    name: 'invalid.pdb',
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.buffer }
  }
  await assert.rejects(() => loadBrowserLocalFile(file), /UTF-8/i)
})

test('gateway loading sends only an authorized relative path and gateway cwd through scoped REST', async () => {
  const calls = []
  const content = 'data_x\nloop_\n_atom_site.id\n1\n'
  const size = Buffer.byteLength(content, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const rest = async (...args) => {
    calls.push(args)
    return {
      source: 'gateway-workspace', name: 'model.cif', path: 'results/model.cif',
      format: 'mmcif', size, sha256, truncated: false, content
    }
  }
  const result = await loadGatewayStructure({ file: 'results/model.cif' }, '/remote/work', rest)
  assert.equal(result.source, 'gateway-workspace')
  assert.equal(result.data, content)
  assert.equal(result.bytes, size)
  assert.equal(result.sha256, sha256)
  assert.deepEqual(calls, [[
    '/structure',
    {
      method: 'POST',
      body: {
        source: 'gateway-workspace',
        path: 'results/model.cif',
        workspace_root: '/remote/work'
      },
      timeoutMs: 30000
    }
  ]])
})

test('gateway loading rejects envelopes whose byte size or SHA-256 does not match content', async () => {
  const content = 'HEADER X\nATOM      1  CA  GLY A   1       0.0 0.0 0.0\n'
  const size = Buffer.byteLength(content, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const envelope = {
    source: 'gateway-workspace', name: 'model.pdb', path: 'model.pdb',
    format: 'pdb', size, sha256, truncated: false, content
  }
  await assert.rejects(
    () => loadGatewayStructure({ file: 'model.pdb' }, '/work', async () => ({ ...envelope, size: size + 1 })),
    /backend response|size|integrity/i
  )
  await assert.rejects(
    () => loadGatewayStructure({ file: 'model.pdb' }, '/work', async () => ({ ...envelope, sha256: '0'.repeat(64) })),
    /backend response|sha|integrity/i
  )
})

test('gateway integrity uses UTF-8 byte length for non-ASCII CRLF content', async () => {
  const content = 'HEADER    CAFÉ\r\nATOM      1  CA  GLY A   1       0.0 0.0 0.0\r\n'
  const size = Buffer.byteLength(content, 'utf8')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const result = await loadGatewayStructure({ file: 'unicode.pdb' }, '/work', async () => ({
    source: 'gateway-workspace', name: 'unicode.pdb', path: 'unicode.pdb',
    format: 'pdb', size, sha256, truncated: false, content
  }))
  assert.equal(result.bytes, size)
  assert.equal(result.sha256, sha256)
  assert.equal(result.data, content)
})

test('gateway loading rejects missing cwd and malformed backend envelopes', async () => {
  await assert.rejects(
    () => loadGatewayStructure({ file: 'x.pdb' }, '', async () => ({})),
    /workspace/i
  )
  await assert.rejects(
    () => loadGatewayStructure(
      { file: 'x.pdb' }, '/work',
      async () => ({ source: 'browser-local', content: 'ATOM X', format: 'pdb' })
    ),
    /backend response/i
  )
})

test('viewer document is accepted only with the staged schema, size, and SHA-256', async () => {
  const document = '<!doctype html><title>viewer</title>'
  const expectedSha256 = 'ffe248f3b1a39a510622e1103139d745df8388ac4e87094fb44e4ee79b90b759'
  const calls = []
  const src = await loadViewerDocument(async (...args) => {
    calls.push(args)
    return { schema: 1, sha256: expectedSha256, document }
  }, expectedSha256)
  assert.equal(src, 'data:text/html;charset=utf-8,%3C!doctype html%3E%3Ctitle%3Eviewer%3C/title%3E')
  assert.deepEqual(calls, [['/viewer-document', { method: 'GET', timeoutMs: 30000 }]])

  await assert.rejects(
    () => loadViewerDocument(async () => ({ schema: 1, sha256: '0'.repeat(64), document }), expectedSha256),
    /integrity/i
  )
  await assert.rejects(
    () => loadViewerDocument(async () => ({ schema: 2, sha256: expectedSha256, document }), expectedSha256),
    /response/i
  )
  await assert.rejects(
    () => loadViewerDocument(async () => ({ schema: 1, sha256: expectedSha256, document: 'x'.repeat(3 * 1024 * 1024 + 1) }), expectedSha256),
    /size/i
  )
})
