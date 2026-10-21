import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  SandboxedFrame,
  TRANSCRIPT_DIRECTIVE_AREA,
  host
} from '@hermes/plugin-sdk'
import { VIEWER_DOCUMENT_SHA256 } from 'virtual:viewer-manifest'

import { FRAME_SCHEMA, validateDirectiveAttrs, validateFrameEvent } from './desktop-core.mjs'
import {
  createOpenRequestStore,
  loadBrowserLocalFile,
  loadGatewayStructure,
  loadViewerDocument,
  normalizeGatewayScope
} from './shell-core.mjs'

const ID = 'hermes-molstar'
const ROUTE = '/molstar'
const requests = createOpenRequestStore()

const CSS = `
.hermes-molstar-page{height:100%;min-height:420px;display:flex;flex-direction:column;background:var(--background);color:var(--foreground)}
.hermes-molstar-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border)}
.hermes-molstar-toolbar button,.hermes-molstar-file-label{border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--foreground);font:inherit;padding:6px 10px;cursor:pointer}
.hermes-molstar-toolbar button:hover,.hermes-molstar-file-label:hover{background:var(--accent)}
.hermes-molstar-file-label input{display:none}
.hermes-molstar-meta{min-width:0;flex:1;font-size:12px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hermes-molstar-frame-wrap{position:relative;min-height:0;flex:1;background:#111827}
.hermes-molstar-frame{position:absolute;inset:0;width:100%;height:100%;border:0}
.hermes-molstar-drop{position:absolute;inset:10px;z-index:2;display:grid;place-items:center;border:2px dashed var(--border);border-radius:10px;background:color-mix(in srgb,var(--background) 88%,transparent);font-size:14px;pointer-events:none}
.hermes-molstar-status{padding:5px 12px;border-top:1px solid var(--border);font-size:12px;color:var(--muted-foreground)}
.hermes-molstar-status[data-error=true]{color:var(--destructive,#ef4444)}
.hermes-molstar-card{display:flex;align-items:center;gap:10px;margin:6px 0;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--card)}
.hermes-molstar-card code{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-molstar-card button{border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground);padding:5px 9px;cursor:pointer}
.hermes-molstar-card-error{font-size:12px;color:var(--destructive,#ef4444)}
`

function nonce() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function requestId() {
  return crypto.randomUUID()
}

function useHostValue(atom) {
  return useSyncExternalStore(
    callback => atom.subscribe(callback),
    () => atom.get(),
    () => atom.get()
  )
}

function useGatewayScope() {
  const connectionId = useHostValue(host.state.connectionId)
  const profile = useHostValue(host.state.profile)
  const workspaceRoot = useHostValue(host.state.cwd)
  return useMemo(() => ({
    connectionId: typeof connectionId === 'string' ? connectionId.trim() : '',
    profile: typeof profile === 'string' ? profile.trim() : '',
    workspaceRoot: typeof workspaceRoot === 'string' ? workspaceRoot.trim() : ''
  }), [connectionId, profile, workspaceRoot])
}

function ViewerFrame({ structure, onFrameStatus, resetToken, viewerSrc }) {
  const frameRef = useRef(null)
  const nonceValue = useMemo(nonce, [])
  const src = useMemo(() => `${viewerSrc}#nonce=${nonceValue}`, [nonceValue, viewerSrc])
  const [ready, setReady] = useState(false)

  const post = useCallback((type, payload = {}) => {
    frameRef.current?.contentWindow?.postMessage({ schema: FRAME_SCHEMA, nonce: nonceValue, type, payload }, '*')
  }, [nonceValue])

  useEffect(() => {
    const frameWindow = frameRef.current?.contentWindow
    const listener = event => {
      const checked = validateFrameEvent(event, frameWindow, nonceValue)
      if (!checked.ok) return
      if (checked.type === 'molstar.ready') setReady(true)
      onFrameStatus(checked)
    }
    window.addEventListener('message', listener)
    return () => {
      frameWindow?.postMessage({ schema: FRAME_SCHEMA, nonce: nonceValue, type: 'molstar.dispose', payload: {} }, '*')
      window.removeEventListener('message', listener)
    }
  }, [nonceValue, onFrameStatus])

  useEffect(() => {
    if (ready && structure) {
      post('molstar.load', {
        requestId: structure.requestId,
        name: structure.name,
        format: structure.format,
        data: structure.data
      })
    }
  }, [post, ready, structure])

  useEffect(() => {
    if (ready && resetToken > 0) post('molstar.reset')
  }, [post, ready, resetToken])

  return <SandboxedFrame ref={frameRef} src={src} title="Mol* molecular structure viewer" className="hermes-molstar-frame" />
}

export function MolstarPage({ ctx, requestStore = requests }) {
  const [viewerSrc, setViewerSrc] = useState(null)
  const [structure, setStructure] = useState(null)
  const [status, setStatus] = useState('Loading the staged Mol* viewer…')
  const [error, setError] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const [claimedRequest, setClaimedRequest] = useState(null)
  const requestGeneration = useRef(0)
  const currentRequestId = useRef(null)
  const gatewayTask = useRef(null)
  const previousScopeKey = useRef(null)
  const scope = useGatewayScope()
  const scopeKey = `${scope.connectionId}\u0000${scope.profile}\u0000${scope.workspaceRoot}`
  const normalizedScope = useMemo(() => normalizeGatewayScope(scope), [scopeKey])

  const useStructure = useCallback((value, ownRequestId, gatewayScopeKey = null) => {
    setError(false)
    setStatus(`Sending ${value.name} to the isolated viewer…`)
    setStructure({
      ...value,
      requestId: ownRequestId,
      gatewayScopeKey,
      instance: crypto.randomUUID()
    })
  }, [])

  const fail = useCallback(reason => {
    setError(true)
    setStatus(reason instanceof Error ? reason.message : String(reason))
  }, [])

  useEffect(() => {
    let active = true
    loadViewerDocument(ctx.rest, VIEWER_DOCUMENT_SHA256).then(src => {
      if (!active) return
      setViewerSrc(src)
      setStatus('Starting the isolated Mol* viewer…')
    }).catch(reason => {
      if (active) fail(reason)
    })
    return () => { active = false }
  }, [ctx, fail])

  const openLocal = useCallback(async file => {
    const generation = ++requestGeneration.current
    const ownRequestId = requestId()
    currentRequestId.current = ownRequestId
    setError(false)
    setStatus(`Reading browser-local file ${file?.name ?? ''}…`)
    try {
      const loaded = await loadBrowserLocalFile(file)
      if (generation === requestGeneration.current && currentRequestId.current === ownRequestId) {
        useStructure(loaded, ownRequestId)
      }
    } catch (reason) {
      if (generation === requestGeneration.current) fail(reason)
    }
  }, [fail, useStructure])

  useEffect(() => {
    if (!normalizedScope) {
      requestStore.discard()
      return undefined
    }
    const stop = requestStore.subscribe(normalizedScope, request => {
      if (request.kind === 'gateway') setClaimedRequest({ request, scopeKey })
    })
    return () => {
      requestGeneration.current += 1
      currentRequestId.current = null
      stop()
    }
  }, [normalizedScope, requestStore, scopeKey])

  useEffect(() => {
    if (previousScopeKey.current === null) {
      previousScopeKey.current = scopeKey
      return
    }
    if (previousScopeKey.current === scopeKey) return
    previousScopeKey.current = scopeKey
    requestGeneration.current += 1
    currentRequestId.current = null
    gatewayTask.current = null
    setClaimedRequest(current => current?.scopeKey === scopeKey ? current : null)
    setStructure(current => current?.source === 'gateway-workspace' ? null : current)
    setFrameEpoch(value => value + 1)
    setError(false)
    setStatus(normalizedScope
      ? 'Gateway context changed; choose a structure for the current workspace.'
      : 'Gateway workspace unavailable; browser-local files remain available.')
  }, [normalizedScope, scopeKey])

  useEffect(() => {
    if (!normalizedScope || !claimedRequest || claimedRequest.scopeKey !== scopeKey) return undefined
    const { request } = claimedRequest
    if (request.kind !== 'gateway') return undefined
    const generation = ++requestGeneration.current
    currentRequestId.current = request.requestId
    setError(false)
    setStatus(`Reading ${request.attrs.file} from the active gateway workspace…`)
    if (gatewayTask.current?.requestId !== request.requestId
        || gatewayTask.current?.scopeKey !== scopeKey) {
      gatewayTask.current = {
        requestId: request.requestId,
        scopeKey,
        promise: loadGatewayStructure(request.attrs, request.scope.workspaceRoot, ctx.rest)
      }
    }
    const task = gatewayTask.current
    let active = true
    task.promise.then(loaded => {
      if (active && generation === requestGeneration.current
          && currentRequestId.current === request.requestId) {
        useStructure(loaded, request.requestId, scopeKey)
      }
    }).catch(reason => {
      if (active && generation === requestGeneration.current
          && currentRequestId.current === request.requestId) fail(reason)
    })
    return () => {
      active = false
      requestGeneration.current += 1
      if (currentRequestId.current === request.requestId) currentRequestId.current = null
    }
  }, [claimedRequest, ctx, fail, normalizedScope, scopeKey, useStructure])

  const onFrameStatus = useCallback(message => {
    if (message.type === 'molstar.ready') {
      if (currentRequestId.current === null) {
        setStatus(`Mol* ${message.payload.version} ready; choose a structure.`)
      }
    } else if (message.type === 'molstar.loaded') {
      if (message.payload.requestId !== currentRequestId.current) return
      setError(false)
      setStatus(`${message.payload.name}: ${message.payload.atomCount} atoms, ${message.payload.modelCount} model(s), ${message.payload.canvasCount} canvas`)
    } else if (message.type === 'molstar.error') {
      if (message.payload.requestId !== currentRequestId.current) return
      fail(message.payload.message || 'Mol* could not load the structure')
    }
  }, [fail])

  const onDrop = event => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer?.files?.[0]
    if (file) void openLocal(file)
  }

  return <section
    className="hermes-molstar-page"
    onDragEnter={event => { event.preventDefault(); setDragging(true) }}
    onDragOver={event => event.preventDefault()}
    onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false) }}
    onDrop={onDrop}
  >
    <div className="hermes-molstar-toolbar">
      <label className="hermes-molstar-file-label">
        Open local PDB/mmCIF
        <input type="file" accept=".pdb,.cif,.mmcif,chemical/x-pdb,chemical/x-cif" onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void openLocal(file)
        }} />
      </label>
      <button type="button" onClick={() => setResetToken(value => value + 1)}>Reset camera</button>
      <span className="hermes-molstar-meta" title={structure?.path ?? structure?.name ?? ''}>
        {structure ? `${structure.source === 'browser-local' ? 'Local browser file' : 'Gateway workspace'} · ${structure.path ?? structure.name} · ${structure.bytes.toLocaleString()} bytes` : 'No structure loaded'}
      </span>
    </div>
    <div className="hermes-molstar-frame-wrap">
      {viewerSrc
        ? <ViewerFrame key={frameEpoch} structure={structure} onFrameStatus={onFrameStatus} resetToken={resetToken} viewerSrc={viewerSrc} />
        : <div className="hermes-molstar-drop">Loading the staged viewer…</div>}
      {dragging && <div className="hermes-molstar-drop">Drop one .pdb, .cif, or .mmcif file</div>}
    </div>
    <div className="hermes-molstar-status" data-error={error} role="status" aria-live="polite">{status}</div>
  </section>
}

export function DirectiveCard({ attrs, streaming, requestStore = requests }) {
  const renderedScope = useGatewayScope()
  const [scopeError, setScopeError] = useState('')
  const gatewayAvailable = normalizeGatewayScope(renderedScope) !== null
  const checked = validateDirectiveAttrs(attrs)
  if (!checked.ok) return <div className="hermes-molstar-card hermes-molstar-card-error">Invalid Mol* directive: {checked.error}</div>
  return <div className="hermes-molstar-card">
    <code title={checked.file}>{checked.file}</code>
    <button type="button" disabled={streaming || !gatewayAvailable} onClick={() => {
      const currentScope = normalizeGatewayScope({
        connectionId: host.state.connectionId.get(),
        profile: host.state.profile.get(),
        workspaceRoot: host.state.cwd.get()
      })
      if (!currentScope) {
        setScopeError('A gateway connection and workspace are required to open this path.')
        return
      }
      setScopeError('')
      requestStore.publish({
        kind: 'gateway',
        requestId: requestId(),
        scope: currentScope,
        attrs: { file: checked.file }
      })
      host.navigate(ROUTE)
    }}>Open in Mol*</button>
    {!gatewayAvailable && <span className="hermes-molstar-card-error">A gateway connection and workspace are required.</span>}
    {scopeError && gatewayAvailable && <span className="hermes-molstar-card-error">{scopeError}</span>}
  </div>
}

export default {
  id: ID,
  name: 'Mol* Structure Viewer',
  description: 'Offline-first PDB/mmCIF viewer with browser-local and authorized gateway inputs.',
  defaultEnabled: false,
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: ROUTE },
        render: () => <MolstarPage ctx={ctx} />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Mol* Viewer', codicon: 'beaker' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-molstar.open',
          label: 'Open Mol* Structure Viewer',
          keywords: ['molecule', 'protein', 'pdb', 'mmcif', 'structure'],
          run: () => host.navigate(ROUTE)
        }
      },
      {
        id: 'directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: 'hermes-molstar',
          render: props => <DirectiveCard {...props} />
        }
      }
    ])
  }
}
