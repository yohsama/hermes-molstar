import {
  MAX_STRUCTURE_BYTES,
  formatFromName,
  isValidRequestId,
  validateDirectiveAttrs,
  validateLocalFile,
  validateStructureText
} from './desktop-core.mjs'

export const MAX_VIEWER_DOCUMENT_BYTES = 3 * 1024 * 1024

function viewerDocumentDataUrl(document) {
  // Preserve the compact base64 vendor payload. Only characters that can
  // terminate or reinterpret a data URL are escaped.
  const encoded = document.replace(/[%#<>"]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return `data:text/html;charset=utf-8,${encoded}`
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable for viewer integrity verification')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

export async function loadViewerDocument(rest, expectedSha256) {
  if (typeof rest !== 'function') throw new Error('Hermes plugin backend is unavailable')
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('Invalid staged viewer integrity value')
  }
  const response = await rest('/viewer-document', { method: 'GET', timeoutMs: 30_000 })
  if (!response || typeof response !== 'object' || response.schema !== 1
      || typeof response.document !== 'string' || typeof response.sha256 !== 'string') {
    throw new Error('Invalid backend response for viewer document')
  }
  const bytes = new TextEncoder().encode(response.document)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_VIEWER_DOCUMENT_BYTES) {
    throw new Error(`Viewer document size must be between 1 and ${MAX_VIEWER_DOCUMENT_BYTES} bytes`)
  }
  if (response.sha256 !== expectedSha256 || await sha256Hex(bytes) !== expectedSha256) {
    throw new Error('Viewer document integrity verification failed')
  }
  if (!/^<!doctype html>/i.test(response.document)) {
    throw new Error('Invalid backend response for viewer document')
  }
  return viewerDocumentDataUrl(response.document)
}

export function createOpenRequestStore() {
  let pending = null
  const listeners = new Set()

  const consumeFor = subscription => {
    if (pending === null) return
    const request = pending
    pending = null
    if (sameGatewayScope(request.scope, subscription.scope)) subscription.listener(request)
  }

  return {
    publish(value) {
      const scope = normalizeGatewayScope(value?.scope)
      if (!value || value.kind !== 'gateway' || !isValidRequestId(value.requestId) || !scope) {
        throw new Error('invalid scoped open request')
      }
      pending = { ...value, scope }
      const matching = [...listeners].find(subscription => sameGatewayScope(scope, subscription.scope))
      if (matching) {
        consumeFor(matching)
      } else if (listeners.size > 0) {
        // An already-mounted page in another context has observed and refused
        // this one-shot request. Never retain it for a later context switch.
        pending = null
      }
    },
    subscribe(scopeValue, listener) {
      const scope = normalizeGatewayScope(scopeValue)
      if (!scope || typeof listener !== 'function') throw new Error('invalid open request subscription')
      const subscription = { scope, listener }
      listeners.add(subscription)
      consumeFor(subscription)
      return () => listeners.delete(subscription)
    },
    discard() {
      pending = null
    }
  }
}

export function normalizeGatewayScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const connectionId = typeof value.connectionId === 'string' ? value.connectionId.trim() : ''
  const profile = typeof value.profile === 'string' ? value.profile.trim() : ''
  const workspaceRoot = typeof value.workspaceRoot === 'string' ? value.workspaceRoot.trim() : ''
  if (!connectionId || !profile || !workspaceRoot) return null
  return { connectionId, profile, workspaceRoot }
}

export function sameGatewayScope(left, right) {
  const a = normalizeGatewayScope(left)
  const b = normalizeGatewayScope(right)
  return Boolean(a && b
    && a.connectionId === b.connectionId
    && a.profile === b.profile
    && a.workspaceRoot === b.workspaceRoot)
}

export async function loadBrowserLocalFile(file) {
  const metadata = validateLocalFile(file)
  if (!metadata.ok) throw new Error(metadata.error)
  let buffer
  try {
    buffer = await file.arrayBuffer()
  } catch (error) {
    throw new Error(`could not read browser-local file: ${error instanceof Error ? error.message : String(error)}`)
  }
  let data
  try {
    data = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error('browser-local structure is not valid UTF-8 text')
  }
  const content = validateStructureText(data, metadata.format)
  if (!content.ok) throw new Error(content.error)
  return { ...metadata, data, bytes: content.bytes }
}

export async function loadGatewayStructure(attrs, workspaceRoot, rest) {
  const directive = validateDirectiveAttrs(attrs)
  if (!directive.ok) throw new Error(directive.error)
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('No gateway workspace is active; open a workspace before using this directive.')
  }
  if (typeof rest !== 'function') throw new Error('Hermes plugin backend is unavailable')
  const response = await rest('/structure', {
    method: 'POST',
    body: {
      source: 'gateway-workspace',
      path: directive.file,
      workspace_root: workspaceRoot
    },
    timeoutMs: 30_000
  })
  const validEnvelope = response && typeof response === 'object'
    && response.source === 'gateway-workspace'
    && response.path === directive.file
    && response.format === directive.format
    && response.truncated === false
    && typeof response.content === 'string'
    && typeof response.name === 'string'
    && formatFromName(response.name) === directive.format
    && Number.isSafeInteger(response.size)
    && response.size > 0
    && response.size <= MAX_STRUCTURE_BYTES
    && typeof response.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(response.sha256)
  if (!validEnvelope) throw new Error('Invalid backend response for gateway structure')
  const content = validateStructureText(response.content, response.format)
  if (!content.ok) throw new Error(`Invalid backend structure: ${content.error}`)
  const bytes = new TextEncoder().encode(response.content)
  if (response.size !== content.bytes || await sha256Hex(bytes) !== response.sha256) {
    throw new Error('Gateway structure size or SHA-256 integrity verification failed')
  }
  return {
    source: 'gateway-workspace',
    name: response.name,
    path: response.path,
    format: response.format,
    size: response.size,
    sha256: response.sha256,
    data: response.content,
    bytes: content.bytes
  }
}
