const CDP_HOST = 'http://cloudflare.browser'
const MAX_CHUNK = 1048575
const HEADER = 4
const MAX_MSG = 100 * 1024 * 1024
const DEFAULT_KEEP_ALIVE = 120_000
const MAX_PENDING = 1024

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function encode(data: string): Uint8Array[] {
  const bytes = textEncoder.encode(data)
  const first = new Uint8Array(Math.min(MAX_CHUNK, HEADER + bytes.length))
  new DataView(first.buffer).setUint32(0, bytes.length, true)
  first.set(bytes.subarray(0, MAX_CHUNK - HEADER), HEADER)

  const chunks: Uint8Array[] = [first]
  for (let i = MAX_CHUNK - HEADER; i < bytes.length; i += MAX_CHUNK)
    chunks.push(bytes.subarray(i, i + MAX_CHUNK))
  return chunks
}

function createDecoder() {
  const pending: Uint8Array[] = []

  return (chunk: Uint8Array): string | null => {
    pending.push(chunk)
    const first = pending[0]

    if (first.length < HEADER) return null

    const expected = new DataView(first.buffer, first.byteOffset).getUint32(0, true)

    if (expected > MAX_MSG) {
      pending.length = 0
      return null
    }
    let total = -HEADER

    for (let i = 0; i < pending.length; i++) {
      total += pending[i].length
      if (total === expected) {
        const parts = pending.splice(0, i + 1)
        parts[0] = first.subarray(HEADER)

        const combined = new Uint8Array(expected)
        let offset = 0
        for (const part of parts) {
          combined.set(part, offset)
          offset += part.length
        }
        return textDecoder.decode(combined)
      }
    }
    return null
  }
}

function send(ws: WebSocket, data: string | Uint8Array) {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(data)
  } catch {}
}

export async function proxyCdp(
  browser: Fetcher,
  request: Request,
  proxyOrigin: string,
  token: string,
): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/cloudflare\.browser\/[^/]+/, '') || '/'

  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()

    const keepAlive = Number(url.searchParams.get('keep_alive')) || DEFAULT_KEEP_ALIVE
    const persistent = url.searchParams.get('persistent') !== 'false'

    const pending: string[] = []
    let upstream: WebSocket | null = null
    let reused = false

    const connectToSession = async (sessionId: string) => {
      const connectUrl = new URL(`${CDP_HOST}/v1/connectDevtools`)
      connectUrl.searchParams.set('browser_session', sessionId)
      if (persistent) connectUrl.searchParams.set('persistent', 'true')
      const res = await browser.fetch(connectUrl.toString(), {
        headers: { Upgrade: 'websocket' },
      })
      return res.webSocket ?? null
    }

    const setupUpstream = (ws: WebSocket) => {
      upstream = ws
      upstream.accept()

      for (const msg of pending) {
        for (const chunk of encode(msg)) send(upstream, chunk)
      }
      pending.length = 0

      const decode = createDecoder()
      upstream.addEventListener('message', (e) => {
        try {
          if (typeof e.data === 'string') return
          const msg = decode(new Uint8Array(e.data as ArrayBuffer))
          if (msg) send(server, msg)
        } catch {}
      })

      upstream.addEventListener('close', () => {
        upstream = null
        if (reused) {
          reused = false
          acquireNew().catch(() => server.close(1011, 'Session recovery failed'))
        } else {
          server.close()
        }
      })
      upstream.addEventListener('error', () => server.close())
    }

    const acquireNew = async () => {
      const acquireUrl = new URL(`${CDP_HOST}/v1/acquire`)
      acquireUrl.searchParams.set('keep_alive', `${keepAlive}`)
      const acquireRes = await browser.fetch(acquireUrl.toString())
      if (!acquireRes.ok) {
        server.close(1011, 'Acquire failed')
        return
      }
      const { sessionId } = await acquireRes.json<{ sessionId: string }>()
      const ws = await connectToSession(sessionId)
      if (!ws) {
        server.close(1011, 'Browser unavailable')
        return
      }
      setupUpstream(ws)
    }

    const connect = async () => {
      // Try reusing an existing idle session
      let ws: WebSocket | null = null
      try {
        const sessionsRes = await browser.fetch(`${CDP_HOST}/v1/sessions`)
        if (sessionsRes.ok) {
          const { sessions } = await sessionsRes.json<{
            sessions: { sessionId: string; connectionId?: string }[]
          }>()
          const idle = sessions.filter((s) => !s.connectionId)
          for (const s of idle) {
            try {
              ws = await connectToSession(s.sessionId)
              if (ws) break
            } catch {}
          }
        }
      } catch {}

      if (ws) {
        reused = true
        setupUpstream(ws)
        return
      }

      await acquireNew()
    }

    connect().catch(() => server.close(1011, 'Connection failed'))

    server.addEventListener('message', (e) => {
      try {
        const data =
          typeof e.data === 'string'
            ? e.data
            : textDecoder.decode(new Uint8Array(e.data as ArrayBuffer))
        if (!upstream) {
          if (pending.length >= MAX_PENDING) {
            server.close(1011, 'Buffer overflow')
            return
          }
          pending.push(data)
          return
        }
        for (const chunk of encode(data)) send(upstream, chunk)
      } catch {}
    })

    server.addEventListener('close', () => upstream?.close())
    server.addEventListener('error', () => upstream?.close())

    return new Response(null, { status: 101, webSocket: client })
  }

  if (path.startsWith('/json/version')) {
    const wsUrl = new URL(proxyOrigin.replace(/^http/, 'ws') + `/cloudflare.browser/${token}`)
    wsUrl.search = url.search
    return Response.json({
      Browser: 'Chrome/Headless',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: wsUrl.toString(),
    })
  }

  const res = await browser.fetch(`${CDP_HOST}${path}`)
  return new Response(res.body, res)
}
