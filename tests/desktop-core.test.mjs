import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FRAME_SCHEMA,
  MAX_STRUCTURE_BYTES,
  createFrameMessage,
  formatFromName,
  validateDirectiveAttrs,
  validateFrameEvent,
  validateLocalFile,
  validateStructureText
} from '../src/desktop-core.mjs'

test('directive attributes accept one safe gateway-workspace relative structure path', () => {
  assert.deepEqual(validateDirectiveAttrs({ file: 'results/model.pdb' }), {
    ok: true,
    file: 'results/model.pdb',
    format: 'pdb'
  })
  assert.deepEqual(validateDirectiveAttrs({ file: 'models/a.mmcif' }), {
    ok: true,
    file: 'models/a.mmcif',
    format: 'mmcif'
  })
})

test('directive attributes reject traversal, absolute, malformed, and ambiguous input', () => {
  for (const attrs of [
    {},
    { file: '' },
    { file: '../secret.pdb' },
    { file: 'models/../../secret.pdb' },
    { file: '/etc/passwd.pdb' },
    { file: 'C:\\secret.pdb' },
    { file: '\\\\server\\share\\x.pdb' },
    { file: 'payload.txt:hidden.pdb' },
    { file: 'models/C:/secret.pdb' },
    { file: '\nmodel.pdb' },
    { file: 'model.pdb\n' },
    { file: 'CON.pdb' },
    { file: 'models/NUL.cif' },
    { file: 'model.pdb ' },
    { file: 'model.txt' },
    { file: 'model.pdb', extra: 'ignored?' },
    { file: 42 }
  ]) {
    assert.equal(validateDirectiveAttrs(attrs).ok, false, JSON.stringify(attrs))
  }
})

test('local selection is explicitly browser-local and size/extension constrained', () => {
  assert.deepEqual(validateLocalFile({ name: '1crn.pdb', size: 49491 }), {
    ok: true,
    source: 'browser-local',
    name: '1crn.pdb',
    format: 'pdb',
    size: 49491
  })
  assert.equal(validateLocalFile({ name: 'bad.txt', size: 10 }).ok, false)
  assert.equal(validateLocalFile({ name: 'too-big.cif', size: MAX_STRUCTURE_BYTES + 1 }).ok, false)
})

test('format and content validation reject unsupported and malformed structures', () => {
  assert.equal(formatFromName('x.CIF'), 'mmcif')
  assert.equal(formatFromName('x.mmcif'), 'mmcif')
  assert.equal(formatFromName('x.pdb'), 'pdb')
  assert.equal(formatFromName('x.xyz'), null)
  assert.equal(validateStructureText('HEADER X\nATOM      1  N   GLY A   1      0.0 0.0 0.0\nEND\n', 'pdb').ok, true)
  assert.equal(validateStructureText('data_x\nloop_\n_atom_site.id\n1\n', 'mmcif').ok, true)
  assert.equal(validateStructureText('this is not pdb', 'pdb').ok, false)
  assert.equal(validateStructureText('data_x\n_cell.length_a 1', 'mmcif').ok, false)
  assert.equal(validateStructureText('ATOM\u0000binary', 'pdb').ok, false)
})

test('shell accepts frame messages only from the exact window with schema and nonce', () => {
  const frameWindow = {}
  const nonce = '0123456789abcdef0123456789abcdef'
  const data = createFrameMessage(nonce, 'molstar.ready', { version: '5.13.1' })
  assert.equal(data.schema, FRAME_SCHEMA)
  assert.deepEqual(validateFrameEvent({ source: frameWindow, data }, frameWindow, nonce), {
    ok: true,
    type: 'molstar.ready',
    payload: { version: '5.13.1' }
  })
  assert.equal(validateFrameEvent({ source: {}, data }, frameWindow, nonce).ok, false)
  assert.equal(validateFrameEvent({ source: frameWindow, data: { ...data, schema: 999 } }, frameWindow, nonce).ok, false)
  assert.equal(validateFrameEvent({ source: frameWindow, data: { ...data, nonce: 'wrong' } }, frameWindow, nonce).ok, false)
  assert.equal(validateFrameEvent({ source: frameWindow, data: { ...data, type: 'molstar.evil' } }, frameWindow, nonce).ok, false)
})

test('frame replies enforce exact per-type payload schemas and request ids', () => {
  const source = {}
  const nonce = '0123456789abcdef0123456789abcdef'
  const requestId = '11111111-1111-4111-8111-111111111111'
  const event = payload => ({
    source,
    data: { schema: FRAME_SCHEMA, nonce, type: 'molstar.loaded', payload }
  })
  const loaded = {
    requestId,
    name: 'model.pdb',
    format: 'pdb',
    atomCount: 42,
    modelCount: 1,
    structureCount: 1,
    canvasCount: 1
  }
  assert.equal(validateFrameEvent(event(loaded), source, nonce).ok, true)
  assert.equal(validateFrameEvent(event({}), source, nonce).ok, false)
  assert.equal(validateFrameEvent(event({ ...loaded, requestId: 'bad' }), source, nonce).ok, false)
  assert.equal(validateFrameEvent(event({ ...loaded, atomCount: -1 }), source, nonce).ok, false)
  assert.equal(validateFrameEvent(event({ ...loaded, unexpected: true }), source, nonce).ok, false)

  const error = {
    source,
    data: {
      schema: FRAME_SCHEMA,
      nonce,
      type: 'molstar.error',
      payload: { requestId, message: 'load failed' }
    }
  }
  assert.equal(validateFrameEvent(error, source, nonce).ok, true)
  assert.equal(validateFrameEvent({ ...error, data: { ...error.data, payload: { message: 'missing id' } } }, source, nonce).ok, false)
  assert.throws(() => createFrameMessage(nonce, 'molstar.ready', {}), /payload|version/i)
})
