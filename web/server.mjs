// session-map: the small local server behind the interactive graph.
// It serves the page, hands it the session data the mod writes, keeps the
// layout, and queues the page's actions for the mod to carry out.
// Usage: node server.mjs <runtimeDir> <port> <token>
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const [dir, portArg, token] = process.argv.slice(2)
if (!dir || !token) {
  console.error('usage: node server.mjs <runtimeDir> <port> <token>')
  process.exit(2)
}
const port = Number(portArg) || 47821
const file = (...parts) => path.join(dir, ...parts)
fs.mkdirSync(file('actions'), { recursive: true })
fs.mkdirSync(file('results'), { recursive: true })

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 2_000_000) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const readOr = (p, fallback) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback)
const ACTIONS = new Set(['move', 'pin', 'archive', 'nest', 'open', 'create', 'refresh'])

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, readOr(file('index.html'), 'Not ready yet.'), 'text/html; charset=utf-8')
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, '{"error":"not found"}')
    // Every API call carries the token from the page's address: no other page can act.
    if (req.headers['x-session-map-token'] !== token) return send(res, 403, '{"error":"bad token"}')

    if (req.method === 'GET' && url.pathname === '/api/ping') return send(res, 200, '{"ok":true}')
    if (req.method === 'GET' && url.pathname === '/api/data') {
      return send(res, 200, readOr(file('data.json'), '{"rows":[],"sections":[],"loadedAt":0}'))
    }
    if (url.pathname === '/api/layout') {
      if (req.method === 'GET') return send(res, 200, readOr(file('layout.json'), '{}'))
      if (req.method === 'PUT') {
        const body = await readBody(req)
        JSON.parse(body)
        fs.writeFileSync(file('layout.json'), body)
        return send(res, 200, '{"ok":true}')
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = JSON.parse(await readBody(req))
      if (!body || !ACTIONS.has(body.type)) return send(res, 400, '{"error":"unknown action"}')
      const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
      fs.writeFileSync(file('actions', `${id}.json`), JSON.stringify({ ...body, id }))
      return send(res, 200, JSON.stringify({ id }))
    }
    if (req.method === 'GET' && url.pathname === '/api/result') {
      const id = (url.searchParams.get('id') ?? '').replace(/[^\w-]/g, '')
      const result = file('results', `${id}.json`)
      if (!id || !fs.existsSync(result)) return send(res, 200, '{"pending":true}')
      const out = fs.readFileSync(result, 'utf8')
      fs.rmSync(result, { force: true })
      fs.rmSync(file('actions', `${id}.json`), { force: true })
      return send(res, 200, out)
    }
    send(res, 404, '{"error":"not found"}')
  } catch (err) {
    send(res, 400, JSON.stringify({ error: String(err?.message ?? err) }))
  }
})

server.on('error', err => {
  console.error(`session-map server failed: ${err.message}`)
  process.exit(1)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`session-map server on http://127.0.0.1:${port}`)
  // A heartbeat the mod reads to tell a running server from a stopped one.
  const beat = () => fs.writeFileSync(file('alive.json'), JSON.stringify({ port, at: Date.now(), pid: process.pid }))
  beat()
  setInterval(beat, 5_000).unref()
})

// Actions nobody answered within an hour are dropped.
setInterval(() => {
  const cutoff = Date.now() - 3_600_000
  for (const sub of ['actions', 'results']) {
    for (const name of fs.readdirSync(file(sub))) {
      const p = file(sub, name)
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true })
      } catch {}
    }
  }
}, 600_000).unref()

// Stay up while the heartbeat timer is unref'd: the server itself keeps the process alive.
