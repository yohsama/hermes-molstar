import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexPath = path.join(root, 'dist', 'browser-smoke', 'index.html')
const port = Number.parseInt(process.env.HERMES_MOLSTAR_SMOKE_PORT ?? '4173', 10)

if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('HERMES_MOLSTAR_SMOKE_PORT must be an integer between 1024 and 65535')
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' || !['/', '/index.html'].includes(request.url ?? '')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('not found')
    return
  }
  try {
    const body = await readFile(indexPath)
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(body)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`SMOKE_SERVER_READY http://127.0.0.1:${port}/`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
