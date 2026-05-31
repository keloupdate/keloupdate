// In-memory stand-in for the Supabase REST + Storage (TUS) endpoints that kelo
// touches. Lets `kelo update`/`publish` upload a bundle and the client download
// the SAME bytes over the loopback interface — no real Supabase, no secrets.
//
// Implements only what the kelo code actually calls:
//   GET  /rest/v1/kelo_releases       -> latest release row(s), filtered/sorted
//   POST /rest/v1/kelo_releases       -> record an inserted release
//   POST /storage/v1/upload/resumable -> TUS creation (+ creation-with-upload)
//   PATCH/HEAD <upload-url>           -> TUS append / resume
//   GET  /storage/v1/object/public/<bucket>/<path> -> serve stored bytes

import { createServer, type Server, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ReleaseRow {
  version: string
  download_url: string
  sha256: string | null
  release_type: string
  platform: string
  created_at: number // monotonic sequence — avoids Date and gives stable ordering
}

interface PendingUpload {
  length: number
  offset: number
  objectName: string
  chunks: Buffer[]
}

export interface FakeBackend {
  origin: string
  port: number
  releases: () => ReleaseRow[]
  storedObject: (objectName: string) => Buffer | undefined
  objectKeys: () => string[]
  seedRelease: (row: Partial<ReleaseRow> & { version: string; download_url: string; platform: string }) => void
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c) => parts.push(Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

// Upload-Metadata is a comma-separated list of "key base64(value)" pairs.
function parseTusMetadata(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(',')) {
    const [key, b64] = pair.trim().split(' ')
    if (key) out[key] = b64 ? Buffer.from(b64, 'base64').toString('utf-8') : ''
  }
  return out
}

const TUS_HEADERS = {
  'Tus-Resumable': '1.0.0',
  'Tus-Version': '1.0.0',
  'Tus-Extension': 'creation,creation-with-upload',
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const releases: ReleaseRow[] = []
  const storage = new Map<string, Buffer>() // objectName -> bytes
  const uploads = new Map<string, PendingUpload>()
  let seq = 1
  let uploadId = 0

  let origin = ''

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', origin)
      const path = url.pathname
      const method = req.method || 'GET'
      if (process.env.KELO_FAKE_LOG) console.error(`[fake] ${method} ${path}`)

      // ── REST: kelo_releases ──
      if (path === '/rest/v1/kelo_releases' && method === 'GET') {
        const platform = (url.searchParams.get('platform') || '').replace(/^eq\./, '')
        const releaseType = (url.searchParams.get('release_type') || '').replace(/^eq\./, '')
        const limit = parseInt(url.searchParams.get('limit') || '0', 10)
        let rows = releases.slice()
        if (platform) rows = rows.filter((r) => r.platform === platform)
        if (releaseType) rows = rows.filter((r) => r.release_type === releaseType)
        rows.sort((a, b) => b.created_at - a.created_at) // order=created_at.desc
        if (limit > 0) rows = rows.slice(0, limit)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rows))
        return
      }

      if (path === '/rest/v1/kelo_releases' && method === 'POST') {
        const body = await readBody(req)
        const row = JSON.parse(body.toString('utf-8') || '{}')
        releases.push({
          version: row.version,
          download_url: row.download_url,
          sha256: row.sha256 ?? null,
          release_type: row.release_type ?? 'update',
          platform: row.platform ?? 'mac',
          created_at: seq++,
        })
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end('[]') // Prefer: return=minimal — body ignored by client
        return
      }

      // ── TUS: create an upload ──
      if (path === '/storage/v1/upload/resumable' && method === 'POST') {
        const meta = parseTusMetadata(req.headers['upload-metadata'] as string)
        const length = parseInt((req.headers['upload-length'] as string) || '0', 10)
        const id = String(++uploadId)
        const upload: PendingUpload = { length, offset: 0, objectName: meta.objectName || `obj-${id}`, chunks: [] }
        // creation-with-upload: data may ride along on the POST
        const initial = await readBody(req)
        if (initial.length > 0) {
          upload.chunks.push(initial)
          upload.offset += initial.length
        }
        uploads.set(id, upload)
        if (upload.length > 0 && upload.offset >= upload.length) {
          storage.set(upload.objectName, Buffer.concat(upload.chunks))
        }
        res.writeHead(201, {
          ...TUS_HEADERS,
          Location: `${origin}/storage/v1/upload/resumable/${id}`,
          'Upload-Offset': String(upload.offset),
        })
        res.end()
        return
      }

      // ── TUS: append / resume on a specific upload ──
      const tusMatch = path.match(/^\/storage\/v1\/upload\/resumable\/(\d+)$/)
      if (tusMatch) {
        const upload = uploads.get(tusMatch[1])
        if (!upload) {
          res.writeHead(404, TUS_HEADERS)
          res.end()
          return
        }
        if (method === 'HEAD') {
          res.writeHead(200, {
            ...TUS_HEADERS,
            'Upload-Offset': String(upload.offset),
            'Upload-Length': String(upload.length),
            'Cache-Control': 'no-store',
          })
          res.end()
          return
        }
        if (method === 'PATCH') {
          const chunk = await readBody(req)
          upload.chunks.push(chunk)
          upload.offset += chunk.length
          if (upload.length > 0 && upload.offset >= upload.length) {
            storage.set(upload.objectName, Buffer.concat(upload.chunks))
          }
          res.writeHead(204, { ...TUS_HEADERS, 'Upload-Offset': String(upload.offset) })
          res.end()
          return
        }
      }

      // ── Storage: serve a stored object ──
      const objMatch = path.match(/^\/storage\/v1\/object\/public\/[^/]+\/(.+)$/)
      if (objMatch && method === 'GET') {
        const objectName = decodeURIComponent(objMatch[1])
        const bytes = storage.get(objectName)
        if (!bytes) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
        return
      }

      res.writeHead(404)
      res.end('no route')
    } catch (err: any) {
      res.writeHead(500)
      res.end(String(err?.message || err))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`

  return {
    origin,
    port,
    releases: () => releases.slice(),
    storedObject: (objectName: string) => storage.get(objectName),
    objectKeys: () => Array.from(storage.keys()),
    seedRelease: (row) => {
      releases.push({
        version: row.version,
        download_url: row.download_url,
        sha256: row.sha256 ?? null,
        release_type: row.release_type ?? 'update',
        platform: row.platform,
        created_at: seq++,
      })
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}
