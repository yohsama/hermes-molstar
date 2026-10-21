import {
  FRAME_SCHEMA,
  MAX_STRUCTURE_BYTES,
  formatFromName,
  isValidRequestId,
  validateStructureText
} from './desktop-core.mjs'

const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/

function invalid(error) {
  return { ok: false, error }
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index])
}

export function validateParentEvent(event, expectedParent, nonce) {
  if (!event || event.source !== expectedParent) return invalid('unexpected parent source')
  const message = event.data
  if (!message || typeof message !== 'object' || Array.isArray(message)) return invalid('message must be an object')
  if (message.schema !== FRAME_SCHEMA) return invalid('unsupported message schema')
  if (!NONCE_RE.test(nonce) || message.nonce !== nonce) return invalid('message nonce mismatch')
  if (!['molstar.load', 'molstar.reset', 'molstar.dispose'].includes(message.type)) {
    return invalid('unsupported message type')
  }
  if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
    return invalid('message payload must be an object')
  }
  if (message.type !== 'molstar.load') {
    return hasExactKeys(message.payload, [])
      ? { ok: true, type: message.type, payload: {} }
      : invalid(`invalid ${message.type} payload`)
  }

  if (!hasExactKeys(message.payload, ['requestId', 'name', 'format', 'data'])) {
    return invalid('invalid molstar.load payload')
  }
  const { requestId, name, format, data } = message.payload
  if (!isValidRequestId(requestId)) return invalid('invalid request id')
  if (typeof name !== 'string' || !name.trim() || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) return invalid('invalid structure name')
  if (format !== 'pdb' && format !== 'mmcif') return invalid('invalid structure format')
  if (formatFromName(name) !== format) return invalid('structure name does not match format')
  if (typeof data !== 'string' || !data.length || data.includes('\u0000')) return invalid('invalid structure data')
  if (new TextEncoder().encode(data).byteLength > MAX_STRUCTURE_BYTES) return invalid('structure data is too large')
  const content = validateStructureText(data, format)
  if (!content.ok) return invalid(content.error)
  return { ok: true, type: message.type, payload: { requestId, name, format, data } }
}

export function createViewerLifecycle(factory) {
  if (typeof factory !== 'function') throw new TypeError('viewer factory must be a function')
  let instancePromise = null
  let instance = null
  let disposed = false
  let queue = Promise.resolve()

  const getInstance = async () => {
    if (disposed) throw new Error('viewer lifecycle is disposed')
    if (!instancePromise) {
      instancePromise = Promise.resolve(factory()).then(value => {
        if (!value || typeof value.load !== 'function' || typeof value.dispose !== 'function') {
          throw new Error('viewer factory returned an invalid viewer')
        }
        if (disposed) {
          value.dispose()
          throw new Error('viewer lifecycle is disposed')
        }
        instance = value
        return value
      })
    }
    return instancePromise
  }

  return {
    load(input) {
      if (disposed) return Promise.reject(new Error('viewer lifecycle is disposed'))
      const operation = queue.then(async () => {
        const viewer = await getInstance()
        if (disposed) throw new Error('viewer lifecycle is disposed')
        const result = await viewer.load(input)
        if (disposed) throw new Error('viewer lifecycle is disposed')
        return result
      })
      queue = operation.catch(() => undefined)
      return operation
    },
    resize() {
      if (!disposed) instance?.resize?.()
    },
    reset() {
      if (!disposed) instance?.reset?.()
    },
    dispose() {
      if (disposed) return
      disposed = true
      instance?.dispose()
      instance = null
      instancePromise = null
    }
  }
}
