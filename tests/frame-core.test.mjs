import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createViewerLifecycle,
  validateParentEvent
} from '../src/frame-core.mjs'

test('frame validates exact parent source, schema, nonce, type, format, and payload size', () => {
  const parentWindow = {}
  const nonce = '0123456789abcdef0123456789abcdef'
  const requestId = '11111111-1111-4111-8111-111111111111'
  const good = {
    schema: 1,
    nonce,
    type: 'molstar.load',
    payload: { requestId, name: '1crn.pdb', format: 'pdb', data: 'HEADER X\nATOM  X\n' }
  }
  assert.equal(validateParentEvent({ source: parentWindow, data: good }, parentWindow, nonce).ok, true)
  assert.equal(validateParentEvent({
    source: parentWindow,
    data: { schema: 1, nonce, type: 'molstar.dispose', payload: {} }
  }, parentWindow, nonce).ok, true)
  assert.equal(validateParentEvent({ source: {}, data: good }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, schema: 2 } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, nonce: 'bad' } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, type: 'other' } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, payload: { ...good.payload, requestId: 'bad' } } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, payload: { ...good.payload, extra: true } } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, payload: { ...good.payload, format: 'xyz' } } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({ source: parentWindow, data: { ...good, payload: { ...good.payload, data: 'x'.repeat(16 * 1024 * 1024 + 1) } } }, parentWindow, nonce).ok, false)
  assert.equal(validateParentEvent({
    source: parentWindow,
    data: { schema: 1, nonce, type: 'molstar.reset', payload: { extra: true } }
  }, parentWindow, nonce).ok, false)
})

test('viewer lifecycle lazy-mounts one instance, reuses it, resizes it, and disposes once', async () => {
  const calls = []
  const viewer = {
    load: async input => calls.push(['load', input.name]),
    resize: () => calls.push(['resize']),
    reset: () => calls.push(['reset']),
    dispose: () => calls.push(['dispose'])
  }
  let creations = 0
  const lifecycle = createViewerLifecycle(async () => {
    creations += 1
    return viewer
  })

  assert.equal(creations, 0)
  await lifecycle.load({ name: 'a.pdb' })
  await lifecycle.load({ name: 'b.cif' })
  lifecycle.resize()
  lifecycle.reset()
  lifecycle.dispose()
  lifecycle.dispose()

  assert.equal(creations, 1)
  assert.deepEqual(calls, [
    ['load', 'a.pdb'],
    ['load', 'b.cif'],
    ['resize'],
    ['reset'],
    ['dispose']
  ])
  await assert.rejects(() => lifecycle.load({ name: 'after-dispose.pdb' }), /disposed/i)
})

test('viewer lifecycle serializes replacement loads to avoid state races', async () => {
  const calls = []
  let releaseFirst
  const first = new Promise(resolve => { releaseFirst = resolve })
  const lifecycle = createViewerLifecycle(async () => ({
    async load(input) {
      calls.push(`start:${input.name}`)
      if (input.name === 'a.pdb') await first
      calls.push(`end:${input.name}`)
    },
    dispose() {}
  }))
  const a = lifecycle.load({ name: 'a.pdb' })
  const b = lifecycle.load({ name: 'b.pdb' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['start:a.pdb'])
  releaseFirst()
  await Promise.all([a, b])
  assert.deepEqual(calls, ['start:a.pdb', 'end:a.pdb', 'start:b.pdb', 'end:b.pdb'])
})

test('viewer lifecycle disposes a viewer whose async factory resolves after teardown', async () => {
  let releaseFactory
  let disposals = 0
  const factoryReady = new Promise(resolve => { releaseFactory = resolve })
  const lifecycle = createViewerLifecycle(async () => {
    await factoryReady
    return {
      async load() {},
      dispose() { disposals += 1 }
    }
  })

  const pendingLoad = lifecycle.load({ name: 'late.pdb' })
  await new Promise(resolve => setImmediate(resolve))
  lifecycle.dispose()
  releaseFactory()

  await assert.rejects(pendingLoad, /disposed/i)
  assert.equal(disposals, 1)
})

test('viewer lifecycle rejects a controlled load that settles after disposal', async () => {
  let releaseLoad
  let loadStarted = false
  let disposals = 0
  const loadGate = new Promise(resolve => { releaseLoad = resolve })
  const lifecycle = createViewerLifecycle(async () => ({
    async load() {
      loadStarted = true
      await loadGate
      return { atomCount: 1 }
    },
    dispose() { disposals += 1 }
  }))

  const pending = lifecycle.load({ name: 'late.pdb' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loadStarted, true)
  lifecycle.dispose()
  releaseLoad()

  await assert.rejects(pending, /disposed/i)
  assert.equal(disposals, 1)
})
