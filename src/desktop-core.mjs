export const FRAME_SCHEMA = 1
export const MAX_STRUCTURE_BYTES = 16 * 1024 * 1024
export const MAX_GATEWAY_PATH_CHARS = 1024

const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const WINDOWS_RESERVED_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i
const FRAME_MESSAGE_TYPES = new Set([
  'molstar.ready',
  'molstar.loaded',
  'molstar.error',
  'molstar.disposed'
])

export function formatFromName(name) {
  if (typeof name !== 'string') return null
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdb')) return 'pdb'
  if (lower.endsWith('.cif') || lower.endsWith('.mmcif')) return 'mmcif'
  return null
}

function invalid(error) {
  return { ok: false, error }
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index])
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
}

export function isValidRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_RE.test(value)
}

function safeGatewayRelativePath(value) {
  if (typeof value !== 'string') return invalid('file must be a string')
  if (!value || value.length > MAX_GATEWAY_PATH_CHARS) return invalid('file path is empty or too long')
  if (CONTROL_RE.test(value)) return invalid('file path contains control characters')
  if (value !== value.trim()) return invalid('file path must not have leading or trailing whitespace')
  const file = value
  // Directive paths are gateway paths, not paths on the Desktop host. Use a
  // single portable slash spelling so Windows drive/UNC forms cannot be
  // confused with remote POSIX paths.
  if (file.includes('\\')) return invalid('file path must use forward slashes')
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return invalid('file path must be relative')
  const segments = file.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    return invalid('file path contains unsafe segments')
  }
  if (segments.some(segment => segment.includes(':') || segment.endsWith(' ') || segment.endsWith('.') || WINDOWS_RESERVED_RE.test(segment))) {
    return invalid('file path contains a Windows-reserved or ambiguous segment')
  }
  const format = formatFromName(file)
  if (!format) return invalid('only .pdb, .cif, and .mmcif files are supported')
  return { ok: true, file, format }
}

export function validateDirectiveAttrs(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return invalid('attributes must be an object')
  const keys = Object.keys(attrs)
  if (keys.length !== 1 || keys[0] !== 'file') return invalid('the directive requires exactly one file attribute')
  return safeGatewayRelativePath(attrs.file)
}

export function validateLocalFile(file) {
  if (!file || typeof file !== 'object') return invalid('no file selected')
  const name = typeof file.name === 'string' ? file.name.trim() : ''
  const size = Number(file.size)
  const format = formatFromName(name)
  if (!name || !format) return invalid('select a .pdb, .cif, or .mmcif file')
  if (!Number.isSafeInteger(size) || size < 0) return invalid('file size is invalid')
  if (size > MAX_STRUCTURE_BYTES) return invalid(`file exceeds the ${MAX_STRUCTURE_BYTES} byte limit`)
  return { ok: true, source: 'browser-local', name, format, size }
}

export function validateStructureText(text, format) {
  if (typeof text !== 'string' || !text.trim()) return invalid('structure is empty')
  if (text.includes('\u0000')) return invalid('structure contains binary data')
  if (!['pdb', 'mmcif'].includes(format)) return invalid('unsupported structure format')
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes > MAX_STRUCTURE_BYTES) return invalid(`structure exceeds the ${MAX_STRUCTURE_BYTES} byte limit`)
  if (format === 'pdb' && !/^(?:ATOM  |HETATM)/m.test(text)) {
    return invalid('PDB has no ATOM or HETATM records')
  }
  if (format === 'mmcif' && (!/^data_\S*/m.test(text) || !/^_atom_site\./m.test(text))) {
    return invalid('mmCIF has no data block or atom_site category')
  }
  return { ok: true, bytes }
}

export function createFrameMessage(nonce, type, payload = {}) {
  if (!NONCE_RE.test(nonce)) throw new Error('invalid frame nonce')
  if (!FRAME_MESSAGE_TYPES.has(type)) throw new Error(`unsupported frame message type: ${type}`)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object')
  const checked = validateFramePayload(type, payload)
  if (!checked.ok) throw new Error(checked.error)
  return { schema: FRAME_SCHEMA, nonce, type, payload }
}

function validateFramePayload(type, payload) {
  if (type === 'molstar.ready') {
    if (!hasExactKeys(payload, ['version'])
        || typeof payload.version !== 'string'
        || !payload.version.trim()
        || payload.version.length > 128
        || CONTROL_RE.test(payload.version)) {
      return invalid('invalid molstar.ready payload')
    }
    return { ok: true, payload: { version: payload.version } }
  }
  if (type === 'molstar.loaded') {
    const keys = ['requestId', 'name', 'format', 'atomCount', 'modelCount', 'structureCount', 'canvasCount']
    if (!hasExactKeys(payload, keys)
        || !isValidRequestId(payload.requestId)
        || typeof payload.name !== 'string'
        || !payload.name.trim()
        || payload.name.length > 512
        || CONTROL_RE.test(payload.name)
        || !['pdb', 'mmcif'].includes(payload.format)
        || formatFromName(payload.name) !== payload.format
        || !validCount(payload.atomCount)
        || !validCount(payload.modelCount)
        || !validCount(payload.structureCount)
        || !validCount(payload.canvasCount)) {
      return invalid('invalid molstar.loaded payload')
    }
    return { ok: true, payload }
  }
  if (type === 'molstar.error') {
    if (!hasExactKeys(payload, ['requestId', 'message'])
        || !isValidRequestId(payload.requestId)
        || typeof payload.message !== 'string'
        || !payload.message.trim()
        || payload.message.length > 2048) {
      return invalid('invalid molstar.error payload')
    }
    return { ok: true, payload }
  }
  if (type === 'molstar.disposed') {
    return hasExactKeys(payload, []) ? { ok: true, payload: {} } : invalid('invalid molstar.disposed payload')
  }
  return invalid('unsupported message type')
}

export function validateFrameEvent(event, expectedSource, nonce) {
  if (!event || event.source !== expectedSource) return invalid('unexpected message source')
  const data = event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid('message must be an object')
  if (data.schema !== FRAME_SCHEMA) return invalid('unsupported message schema')
  if (!NONCE_RE.test(nonce) || data.nonce !== nonce) return invalid('message nonce mismatch')
  if (!FRAME_MESSAGE_TYPES.has(data.type)) return invalid('unsupported message type')
  if (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) {
    return invalid('message payload must be an object')
  }
  const checked = validateFramePayload(data.type, data.payload)
  if (!checked.ok) return checked
  return { ok: true, type: data.type, payload: checked.payload }
}
