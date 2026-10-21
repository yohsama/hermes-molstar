import { FRAME_SCHEMA, createFrameMessage } from './desktop-core.mjs'
import { createViewerLifecycle, validateParentEvent } from './frame-core.mjs'
import { createMolstarAdapter } from './molstar-adapter.mjs'

const nonce = new URLSearchParams(window.location.hash.slice(1)).get('nonce') ?? ''
const parentWindow = window.parent
const lifecycle = createViewerLifecycle(() => createMolstarAdapter(window.molstar, 'app'))
const overlay = document.getElementById('status-overlay')
let generation = 0
let closed = false

function send(type, payload = {}) {
  if (closed) return
  try {
    parentWindow.postMessage(createFrameMessage(nonce, type, payload), '*')
  } catch {
    // A malformed fragment means the frame stays inert and unauthenticated.
  }
}

function show(text) {
  if (!overlay) return
  overlay.textContent = text
  overlay.hidden = !text
}

async function onMessage(event) {
  const validated = validateParentEvent(event, parentWindow, nonce)
  if (!validated.ok) return
  if (validated.type === 'molstar.dispose') {
    closed = true
    lifecycle.dispose()
    return
  }
  if (validated.type === 'molstar.reset') {
    lifecycle.reset()
    return
  }
  const ownGeneration = ++generation
  show(`Loading ${validated.payload.name}…`)
  try {
    const stats = await lifecycle.load(validated.payload)
    if (ownGeneration !== generation || closed) return
    show('')
    send('molstar.loaded', {
      requestId: validated.payload.requestId,
      name: validated.payload.name,
      format: validated.payload.format,
      ...stats,
      canvasCount: document.querySelectorAll('canvas').length
    })
  } catch (error) {
    if (ownGeneration !== generation || closed) return
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048) || 'Mol* load failed'
    show(`Could not load structure: ${message}`)
    send('molstar.error', { requestId: validated.payload.requestId, message })
  }
}

window.addEventListener('message', onMessage)
window.addEventListener('resize', () => lifecycle.resize())
const observer = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => lifecycle.resize())
  : null
observer?.observe(document.documentElement)

function dispose() {
  if (closed) return
  closed = true
  observer?.disconnect()
  window.removeEventListener('message', onMessage)
  lifecycle.dispose()
}

window.addEventListener('pagehide', dispose, { once: true })
window.addEventListener('beforeunload', dispose, { once: true })
send('molstar.ready', { version: window.molstar?.version ?? 'unknown' })
