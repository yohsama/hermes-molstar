import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test, { afterEach } from 'node:test'

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { build } from 'esbuild'

import { createOpenRequestStore } from '../src/shell-core.mjs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const require = createRequire(import.meta.url)
const VIEWER_DOCUMENT = '<!doctype html><title>component test viewer</title>'
const VIEWER_SHA = createHash('sha256').update(VIEWER_DOCUMENT).digest('hex')

function atom(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener(next)
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(value)
      return () => listeners.delete(listener)
    }
  }
}

function hostFixture({ connectionId = 'conn-a', profile = 'alpha', cwd = '/work/a' } = {}) {
  const state = {
    connectionId: atom(connectionId),
    profile: atom(profile),
    cwd: atom(cwd)
  }
  const navigations = []
  return { state, navigations, navigate: value => navigations.push(value) }
}

function installWindowFixture() {
  const messageListeners = new Set()
  const frameMessages = []
  const frameWindow = { postMessage: message => frameMessages.push(message) }
  globalThis.__HERMES_TEST_FRAME = frameWindow
  globalThis.window = {
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'message') messageListeners.delete(listener)
    }
  }
  return {
    frameMessages,
    frameWindow,
    dispatch(data) {
      for (const listener of messageListeners) listener({ source: frameWindow, data })
    }
  }
}

async function loadPlugin(host) {
  globalThis.__HERMES_TEST_HOST = host
  const result = await build({
    entryPoints: ['src/plugin.jsx'],
    absWorkingDir: process.cwd(),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    write: false,
    external: ['react', 'react/jsx-runtime'],
    plugins: [{
      name: 'component-test-contracts',
      setup(api) {
        api.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'component-test' }))
        api.onLoad({ filter: /^sdk$/, namespace: 'component-test' }, () => ({
          loader: 'jsx',
          contents: `
            import React, { forwardRef, useImperativeHandle } from 'react'
            export const PALETTE_AREA = 'palette'
            export const ROUTES_AREA = 'routes'
            export const SIDEBAR_NAV_AREA = 'sidebar'
            export const TRANSCRIPT_DIRECTIVE_AREA = 'directive'
            export const host = globalThis.__HERMES_TEST_HOST
            export const SandboxedFrame = forwardRef(function SandboxedFrame(props, ref) {
              useImperativeHandle(ref, () => ({ contentWindow: globalThis.__HERMES_TEST_FRAME }))
              globalThis.__HERMES_TEST_FRAME_PROPS = props
              return React.createElement('iframe', { title: props.title, src: props.src })
            })
          `
        }))
        api.onResolve({ filter: /^virtual:viewer-manifest$/ }, () => ({ path: 'viewer', namespace: 'component-test' }))
        api.onLoad({ filter: /^viewer$/, namespace: 'component-test' }, () => ({
          loader: 'js',
          contents: `export const VIEWER_DOCUMENT_SHA256 = ${JSON.stringify(VIEWER_SHA)}`
        }))
      }
    }]
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
  assert.equal(typeof module.exports.MolstarPage, 'function', 'MolstarPage must be component-testable')
  assert.equal(typeof module.exports.DirectiveCard, 'function', 'DirectiveCard must be component-testable')
  return module.exports
}

function structureEnvelope(path = 'model.pdb') {
  const content = 'HEADER X\nATOM      1  CA  GLY A   1       0.0 0.0 0.0\n'
  return {
    source: 'gateway-workspace',
    name: path.split('/').at(-1),
    path,
    format: 'pdb',
    size: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    truncated: false,
    content
  }
}

function viewerResponse(path, restImpl) {
  if (path === '/viewer-document') {
    return Promise.resolve({ schema: 1, sha256: VIEWER_SHA, document: VIEWER_DOCUMENT })
  }
  return restImpl(path)
}

function request(scope, file, requestId) {
  return { kind: 'gateway', requestId, scope, attrs: { file } }
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setImmediate(resolve))
  })
}

afterEach(() => {
  delete globalThis.__HERMES_TEST_HOST
  delete globalThis.__HERMES_TEST_FRAME
  delete globalThis.__HERMES_TEST_FRAME_PROPS
  delete globalThis.window
})

test('DirectiveCard captures the current connection/profile/workspace scope at click time', async () => {
  const host = hostFixture()
  installWindowFixture()
  const { DirectiveCard } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  let captured
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DirectiveCard, {
      attrs: { file: 'model.pdb' }, streaming: false, requestStore
    }))
  })
  renderer.root.findByType('button').props.onClick()
  const stop = requestStore.subscribe(
    { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
    value => { captured = value }
  )
  stop()
  assert.equal(captured.attrs.file, 'model.pdb')
  assert.match(captured.requestId, /^[A-Za-z0-9_-]{16,128}$/)
  assert.deepEqual(captured.scope, {
    connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a'
  })
  assert.deepEqual(host.navigations, ['/molstar'])
  await act(async () => renderer.unmount())
})

test('DirectiveCard disables gateway open without a complete live gateway scope', async () => {
  const host = hostFixture({ connectionId: null, profile: 'alpha', cwd: '' })
  installWindowFixture()
  const { DirectiveCard } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(DirectiveCard, {
      attrs: { file: 'model.pdb' }, streaming: false, requestStore
    }))
  })
  const button = renderer.root.findByType('button')
  assert.equal(button.props.disabled, true)
  await assert.doesNotReject(async () => {
    await act(async () => button.props.onClick())
  })
  assert.deepEqual(host.navigations, [])
  const explanation = renderer.root.findAllByType('span')
    .flatMap(node => node.children).join('')
  assert.match(explanation, /gateway connection and workspace/i)
  await act(async () => renderer.unmount())
})

test('MolstarPage still mounts its local viewer while gateway scope is temporarily invalid', async () => {
  const host = hostFixture({ connectionId: null, profile: 'alpha', cwd: '' })
  installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  const structureCalls = []
  const ctx = { rest: path => viewerResponse(path, value => {
    structureCalls.push(value)
    return Promise.resolve(structureEnvelope())
  }) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(MolstarPage, { ctx, requestStore }))
  })
  await flush()
  assert.equal(renderer.root.findAllByType('iframe').length, 1)
  assert.deepEqual(structureCalls, [])
  await act(async () => renderer.unmount())
})

test('MolstarPage retains a claimed one-shot request through React StrictMode effect replay', async () => {
  const host = hostFixture()
  const frame = installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  const requestId = '33333333-3333-4333-8333-333333333333'
  requestStore.publish(request(
    { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
    'strict.pdb',
    requestId
  ))
  let structureCalls = 0
  const ctx = { rest: path => viewerResponse(path, () => {
    structureCalls += 1
    return Promise.resolve(structureEnvelope('strict.pdb'))
  }) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(
      React.StrictMode,
      null,
      React.createElement(MolstarPage, { ctx, requestStore })
    ))
  })
  await flush()
  const nonce = new URL(globalThis.__HERMES_TEST_FRAME_PROPS.src).hash.slice('#nonce='.length)
  await act(async () => {
    frame.dispatch({ schema: 1, nonce, type: 'molstar.ready', payload: { version: '5.13.1' } })
  })
  await flush()
  const loads = frame.frameMessages.filter(message => message.type === 'molstar.load')
  assert.equal(structureCalls, 1)
  assert.equal(loads.length, 1)
  assert.equal(loads[0].payload.requestId, requestId)
  await act(async () => renderer.unmount())
})

test('MolstarPage discards a pending request from a different workspace scope', async () => {
  const host = hostFixture()
  installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  await act(async () => {
    requestStore.publish(request(
      { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
      'model.pdb',
      '11111111-1111-4111-8111-111111111111'
    ))
  })
  host.state.connectionId.set('conn-b')
  host.state.profile.set('beta')
  host.state.cwd.set('/work/b')
  const structureCalls = []
  const ctx = { rest: path => viewerResponse(path, value => {
    structureCalls.push(value)
    return Promise.resolve(structureEnvelope())
  }) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(MolstarPage, { ctx, requestStore }))
  })
  await flush()
  assert.deepEqual(structureCalls, [])
  await act(async () => renderer.unmount())
})

test('MolstarPage invalidates an in-flight gateway read when connection context changes', async () => {
  const host = hostFixture()
  installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  let resolveStructure
  const delayed = new Promise(resolve => { resolveStructure = resolve })
  const ctx = { rest: path => viewerResponse(path, () => delayed) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(MolstarPage, { ctx, requestStore }))
  })
  await act(async () => {
    requestStore.publish(request(
      { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
      'model.pdb',
      '11111111-1111-4111-8111-111111111111'
    ))
  })
  await flush()
  await act(async () => {
    host.state.connectionId.set('conn-b')
    host.state.profile.set('beta')
    host.state.cwd.set('/work/b')
  })
  resolveStructure(structureEnvelope())
  await flush()
  const status = renderer.root.findByProps({ role: 'status' }).children.join('')
  assert.doesNotMatch(status, /model\.pdb: .*atoms/)
  await act(async () => renderer.unmount())
})

test('MolstarPage remounts the frame and clears gateway provenance after a scope switch', async () => {
  const host = hostFixture()
  const frame = installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  const ctx = { rest: path => viewerResponse(path, () => Promise.resolve(structureEnvelope())) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(MolstarPage, { ctx, requestStore }))
  })
  await flush()
  const nonce = new URL(globalThis.__HERMES_TEST_FRAME_PROPS.src).hash.slice('#nonce='.length)
  await act(async () => {
    frame.dispatch({ schema: 1, nonce, type: 'molstar.ready', payload: { version: '5.13.1' } })
  })
  await act(async () => {
    requestStore.publish(request(
      { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
      'model.pdb',
      '44444444-4444-4444-8444-444444444444'
    ))
  })
  await flush()
  assert.equal(frame.frameMessages.filter(message => message.type === 'molstar.load').length, 1)
  await act(async () => {
    host.state.cwd.set('/work/b')
  })
  await flush()
  assert.equal(frame.frameMessages.filter(message => message.type === 'molstar.dispose').length, 1)
  const meta = renderer.root.findByProps({ className: 'hermes-molstar-meta' }).children.join('')
  assert.match(meta, /No structure loaded/)
  await act(async () => renderer.unmount())
})

test('a stale successful frame reply cannot overwrite a newer gateway read error', async () => {
  const host = hostFixture()
  const frame = installWindowFixture()
  const { MolstarPage } = await loadPlugin(host)
  const requestStore = createOpenRequestStore()
  const ctx = { rest: (path, options) => viewerResponse(path, () => {
    const file = options.body.path
    return file === 'a.pdb'
      ? Promise.resolve(structureEnvelope('a.pdb'))
      : Promise.reject(new Error('B read failed'))
  }) }
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(MolstarPage, { ctx, requestStore }))
  })
  await flush()
  const nonce = new URL(globalThis.__HERMES_TEST_FRAME_PROPS.src).hash.slice('#nonce='.length)
  await act(async () => {
    frame.dispatch({ schema: 1, nonce, type: 'molstar.ready', payload: { version: '5.13.1' } })
  })
  await flush()
  await act(async () => {
    requestStore.publish(request(
      { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
      'a.pdb',
      '11111111-1111-4111-8111-111111111111'
    ))
  })
  await flush()
  const sentA = frame.frameMessages.find(message => message.type === 'molstar.load')
  assert.equal(sentA.payload.requestId, '11111111-1111-4111-8111-111111111111')
  await act(async () => {
    requestStore.publish(request(
      { connectionId: 'conn-a', profile: 'alpha', workspaceRoot: '/work/a' },
      'b.pdb',
      '22222222-2222-4222-8222-222222222222'
    ))
  })
  await flush()
  assert.match(renderer.root.findByProps({ role: 'status' }).children.join(''), /B read failed/)
  await act(async () => {
    frame.dispatch({
      schema: 1,
      nonce,
      type: 'molstar.loaded',
      payload: {
        requestId: sentA.payload.requestId,
        name: 'a.pdb',
        format: 'pdb',
        atomCount: 1,
        modelCount: 1,
        structureCount: 1,
        canvasCount: 1
      }
    })
  })
  await flush()
  assert.match(renderer.root.findByProps({ role: 'status' }).children.join(''), /B read failed/)
  await act(async () => renderer.unmount())
})
