import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stageRoot = path.join(root, 'dist', 'hermes-molstar')
const viewerDir = path.join(root, 'node_modules', 'molstar', 'build', 'viewer')

async function bundledFrameScript() {
  const result = await build({
    entryPoints: [path.join(root, 'src', 'viewer-frame-entry.mjs')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    write: false,
    legalComments: 'inline'
  })
  return result.outputFiles[0].text
}

async function viewerDocument() {
  const [molstarJs, molstarCss, frameJs] = await Promise.all([
    readFile(path.join(viewerDir, 'molstar.js'), 'utf8'),
    readFile(path.join(viewerDir, 'molstar.css'), 'utf8'),
    bundledFrameScript()
  ])
  const compressed = source => gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64')
  const molstarGzip = compressed(molstarJs)
  const cssGzip = compressed(molstarCss)
  const frameGzip = compressed(frameJs)
  // Chromium refuses very large data: navigations. Gzip the already-minified
  // Mol* distribution and inflate it inside the opaque frame with the browser's
  // native stream API. A non-base64 outer URL avoids base64-on-base64 expansion.
  const bootstrap = `(async()=>{const unzip=async value=>{const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()};const css=await unzip('${cssGzip}');const style=document.createElement('style');style.textContent=css;document.head.append(style);const run=code=>{const script=document.createElement('script');script.textContent=code;document.head.append(script)};run(await unzip('${molstarGzip}'));run(await unzip('${frameGzip}'))})().catch(error=>{const node=document.getElementById('status-overlay');node.textContent='Viewer bootstrap failed: '+String(error);node.hidden=false})`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src data:; worker-src blob: data:; child-src blob: data:">
<title>Hermes Mol* Viewer</title><style>*{box-sizing:border-box}html,body,#app{position:absolute;inset:0;width:100%;height:100%;margin:0;overflow:hidden;background:#111827}#status-overlay{position:absolute;z-index:20;inset:0;display:grid;place-items:center;padding:24px;background:#111827;color:#e5e7eb;font:14px system-ui,sans-serif;text-align:center}#status-overlay[hidden]{display:none}</style></head>
<body><div id="app"></div><div id="status-overlay">Waiting for a structure…</div><script>${bootstrap}</script></body></html>`
  return html
}

function viewerDataUrl(html) {
  // Keep the canonical base64 payload verbatim. Escape URL/markup delimiters,
  // but not '+' and '/': encodeURIComponent would expand those by roughly
  // 140 KiB and push Chromium's navigation URL over its limit.
  const encodedHtml = html.replace(/[%#<>"]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return `data:text/html;charset=utf-8,${encodedHtml}`
}

await rm(path.join(root, 'dist'), { recursive: true, force: true })
await mkdir(path.join(stageRoot, 'desktop'), { recursive: true })

const document = await viewerDocument()
const documentSha256 = createHash('sha256').update(document).digest('hex')
const dataUrl = viewerDataUrl(document)
await build({
  entryPoints: [path.join(root, 'src', 'plugin.jsx')],
  outfile: path.join(stageRoot, 'desktop', 'plugin.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  minify: true,
  legalComments: 'inline',
  external: ['react', 'react/*', '@hermes/plugin-sdk', '@hermes/plugin-sdk/*'],
  plugins: [{
    name: 'viewer-manifest',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^virtual:viewer-manifest$/ }, () => ({ path: 'viewer-manifest', namespace: 'molstar' }))
      buildApi.onLoad({ filter: /.*/, namespace: 'molstar' }, () => ({
        contents: `export const VIEWER_DOCUMENT_SHA256 = ${JSON.stringify(documentSha256)};`,
        loader: 'js'
      }))
    }
  }]
})

for (const name of ['plugin.yaml', '__init__.py']) {
  await cp(path.join(root, 'plugin', name), path.join(stageRoot, name))
}
await cp(path.join(root, 'plugin', 'dashboard'), path.join(stageRoot, 'dashboard'), { recursive: true })
await writeFile(
  path.join(stageRoot, 'dashboard', 'viewer-document.json'),
  `${JSON.stringify({ schema: 1, sha256: documentSha256, document })}\n`,
  'utf8'
)
await cp(path.join(root, 'plugin', 'skills'), path.join(stageRoot, 'skills'), { recursive: true })
for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) {
  await cp(path.join(root, name), path.join(stageRoot, name))
}
await mkdir(path.join(stageRoot, 'third_party'), { recursive: true })
await cp(path.join(root, 'node_modules', 'molstar', 'LICENSE'), path.join(stageRoot, 'third_party', 'molstar-LICENSE.txt'))

const pluginBytes = (await stat(path.join(stageRoot, 'desktop', 'plugin.js'))).size
const manifest = {
  artifact: 'dist/hermes-molstar',
  molstarVersion: '5.13.1',
  desktopPluginBytes: pluginBytes,
  desktopPluginLimitBytes: 16 * 1024 * 1024,
  viewerDocument: {
    transport: 'authenticated ctx.rest JSON to opaque data:text/html frame',
    path: 'dashboard/viewer-document.json',
    sha256: documentSha256,
    bytes: Buffer.byteLength(document, 'utf8')
  }
}
await writeFile(path.join(stageRoot, 'BUILD_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const smokeDir = path.join(root, 'dist', 'browser-smoke')
await mkdir(smokeDir, { recursive: true })
const smokeHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Hermes Mol* offline smoke</title><style>html,body{height:100%;margin:0;font:14px system-ui;background:#111827;color:#e5e7eb}body{display:grid;grid-template-rows:auto auto 1fr;gap:8px;padding:8px}iframe{width:100%;height:100%;border:1px solid #374151}#status{white-space:pre-wrap}</style></head><body><input id="file" type="file" accept=".pdb,.cif,.mmcif"><div id="status" role="status">booting</div><iframe id="viewer" sandbox="allow-scripts" title="Molstar smoke viewer"></iframe><script>
const schema=1,nonce=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
const viewer=document.getElementById('viewer'),status=document.getElementById('status'),input=document.getElementById('file');
const state=window.__molstarSmoke={ready:false,events:[],last:null,loads:0,viewerStartedOnline:null};let pending=null,viewerStarted=false;
function startViewer(){if(viewerStarted)return;viewerStarted=true;state.viewerStartedOnline=navigator.onLine;viewer.src=${JSON.stringify(dataUrl)}+'#nonce='+nonce}
function send(){if(state.ready&&pending)viewer.contentWindow.postMessage({schema,nonce,type:'molstar.load',payload:pending},'*')}
window.addEventListener('message',event=>{const data=event.data;if(event.source!==viewer.contentWindow||!data||data.schema!==schema||data.nonce!==nonce)return;if((data.type==='molstar.loaded'||data.type==='molstar.error')&&(!pending||!data.payload||data.payload.requestId!==pending.requestId))return;state.events.push(data.type);if(data.type==='molstar.ready'){state.ready=true;status.textContent='ready';send()}if(data.type==='molstar.loaded'){state.last=data.payload;state.loads++;status.textContent=JSON.stringify(data.payload)}if(data.type==='molstar.error'){state.last=data.payload;status.textContent='ERROR '+JSON.stringify(data.payload)}});
input.addEventListener('change',async()=>{const file=input.files[0];if(!file)return;const name=file.name,lower=name.toLowerCase(),format=lower.endsWith('.pdb')?'pdb':(lower.endsWith('.cif')||lower.endsWith('.mmcif'))?'mmcif':null;if(!format){status.textContent='ERROR unsupported';return}pending={requestId:crypto.randomUUID(),name,format,data:new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())};status.textContent='loading '+name;startViewer();send()});
</script></body></html>`
await writeFile(path.join(smokeDir, 'index.html'), smokeHtml, 'utf8')
if (pluginBytes > manifest.desktopPluginLimitBytes) {
  throw new Error(`desktop/plugin.js is ${pluginBytes} bytes; Hermes limit is ${manifest.desktopPluginLimitBytes}`)
}
console.log(`Built ${path.relative(root, stageRoot)} (${pluginBytes} byte desktop/plugin.js)`)
