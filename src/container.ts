import { Container } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

const PORT = 6658

const containerEnv = Object.fromEntries(
  Object.entries(env).filter(([, value]) => typeof value === 'string'),
)

export class AgentContainer extends Container {
  sleepAfter = '10m'
  defaultPort = PORT

  envVars = {
    ...containerEnv,
    PORT: PORT.toString(),
  }

  async watchContainer() {
    try {
      const res = await this.containerFetch('http://container/', {
        headers: { Upgrade: 'websocket' },
      })

      if (res.webSocket === null) {
        throw new Error('WebSocket server error')
      }

      const ws = res.webSocket

      ws.addEventListener('message', (msg) => {
        try {
          const frame = JSON.parse(msg.data as string)

          // Keep-alive only on chat events with state 'final'
          if (frame.event === 'chat' && frame.payload?.state === 'final') {
            console.info('Keep-alive: chat final event')
            this.renewActivityTimeout()
          }

          if (frame.type === 'res' && frame.id === '1') {
            console.info(frame.ok ? 'Gateway connected' : 'Gateway connection failed')
          }
        } catch {
          console.info('Error parsing WebSocket message')
        }
      })

      ws.addEventListener('close', () => {
        console.warn('WebSocket closed, reconnecting in 30s...')
        setTimeout(() => {
          this.watchContainer()
        }, 30_000)
      })

      ws.accept()

      const token = env.OPENCLAW_GATEWAY_TOKEN
      ws.send(
        JSON.stringify({
          type: 'req',
          id: '1',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'cli', version: '1.0.0', platform: 'cloudflare', mode: 'cli' },
            role: 'operator',
            scopes: ['operator.read'],
            auth: token ? { token } : undefined,
          },
        }),
      )
    } catch (error) {
      console.error('WebSocket connection failed:', error)
    }
  }

  override async onStart(): Promise<void> {
    if (this.sleepAfter !== 'never') {
      await this.watchContainer()
    }
  }
}

const SINGLETON_CONTAINER_ID = 'cf-singleton-container'

export async function forwardRequestToContainer(request: Request) {
  const objectId = env.AGENT_CONTAINER.idFromName(SINGLETON_CONTAINER_ID)
  const container = env.AGENT_CONTAINER.get(objectId, { locationHint: 'wnam' })
  return container.fetch(request)
}
