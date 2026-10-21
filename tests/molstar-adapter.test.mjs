import assert from 'node:assert/strict'
import test from 'node:test'

import { createMolstarAdapter, OFFLINE_VIEWER_OPTIONS } from '../src/molstar-adapter.mjs'

test('Molstar adapter creates the real Viewer with offline-first UI options', async () => {
  let createArgs
  const viewer = fakeViewer()
  const molstar = {
    Viewer: {
      async create(...args) {
        createArgs = args
        return viewer
      }
    }
  }
  const adapter = await createMolstarAdapter(molstar, 'app')
  assert.equal(createArgs[0], 'app')
  assert.deepEqual(createArgs[1], OFFLINE_VIEWER_OPTIONS)
  assert.deepEqual(OFFLINE_VIEWER_OPTIONS.extensions, [])
  assert.equal(OFFLINE_VIEWER_OPTIONS.layoutShowRemoteState, false)
  assert.equal(OFFLINE_VIEWER_OPTIONS.layoutShowLeftPanel, false)
  assert.equal(OFFLINE_VIEWER_OPTIONS.volumeStreamingDisabled, true)
  adapter.dispose()
})

test('Molstar adapter clears old state, loads data (not a URL), and reports structure counts', async () => {
  const calls = []
  const viewer = fakeViewer(calls)
  const adapter = await createMolstarAdapter({ Viewer: { create: async () => viewer } }, 'app')
  const stats = await adapter.load({ name: 'fixture.cif', format: 'mmcif', data: 'data_x' })
  assert.deepEqual(calls.slice(0, 2), [
    ['clear'],
    ['loadStructureFromData', 'data_x', 'mmcif', { dataLabel: 'fixture.cif' }]
  ])
  assert.deepEqual(stats, { atomCount: 46, modelCount: 2, structureCount: 2 })
})

test('Molstar adapter exposes resize/reset and idempotent disposal', async () => {
  const calls = []
  const viewer = fakeViewer(calls)
  const adapter = await createMolstarAdapter({ Viewer: { create: async () => viewer } }, 'app')
  adapter.resize()
  adapter.reset()
  adapter.dispose()
  adapter.dispose()
  assert.deepEqual(calls, [['resize'], ['reset'], ['dispose']])
})

test('Molstar adapter disposal during delayed clear prevents a later structure load', async () => {
  const calls = []
  let releaseClear
  const clearGate = new Promise(resolve => { releaseClear = resolve })
  const viewer = fakeViewer(calls)
  viewer.plugin.clear = async () => {
    calls.push(['clear-start'])
    await clearGate
    calls.push(['clear-end'])
  }
  const adapter = await createMolstarAdapter({ Viewer: { create: async () => viewer } }, 'app')
  const pending = adapter.load({ name: 'late.pdb', format: 'pdb', data: 'ATOM  X' })
  await new Promise(resolve => setImmediate(resolve))
  adapter.dispose()
  assert.deepEqual(calls, [['clear-start']])
  releaseClear()
  await assert.rejects(pending, /disposed/i)
  assert.deepEqual(calls, [['clear-start'], ['clear-end'], ['dispose']])
})

test('Molstar adapter waits for an in-flight structure load before final destruction', async () => {
  const calls = []
  let releaseLoad
  const loadGate = new Promise(resolve => { releaseLoad = resolve })
  const viewer = fakeViewer(calls)
  viewer.loadStructureFromData = async () => {
    calls.push(['load-start'])
    await loadGate
    calls.push(['load-end'])
  }
  const adapter = await createMolstarAdapter({ Viewer: { create: async () => viewer } }, 'app')
  const pending = adapter.load({ name: 'late.pdb', format: 'pdb', data: 'ATOM  X' })
  await new Promise(resolve => setImmediate(resolve))
  adapter.dispose()
  assert.deepEqual(calls, [['clear'], ['load-start']])
  releaseLoad()
  await assert.rejects(pending, /disposed/i)
  assert.deepEqual(calls, [['clear'], ['load-start'], ['load-end'], ['dispose']])
})

function fakeViewer(calls = []) {
  return {
    plugin: {
      async clear() { calls.push(['clear']) },
      canvas3d: {
        requestCameraReset() { calls.push(['reset']) }
      },
      managers: {
        structure: {
          hierarchy: {
            current: {
              models: [{}, {}],
              structures: [
                { cell: { obj: { data: { elementCount: 12 } } } },
                { cell: { obj: { data: { elementCount: 34 } } } }
              ]
            }
          }
        }
      }
    },
    async loadStructureFromData(...args) { calls.push(['loadStructureFromData', ...args]) },
    handleResize() { calls.push(['resize']) },
    dispose() { calls.push(['dispose']) }
  }
}
