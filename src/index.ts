import { env } from 'cloudflare:workers'
import { proxyCdp } from './cdp'
import { forwardRequestToContainer } from './container'

export { AgentContainer } from './container'

function verifyBasicAuth(request: Request): Response | null {
  const username = env.SERVER_USERNAME
  const password = env.SERVER_PASSWORD

  if (!password) {
    return null
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Basic ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Agent"' },
    })
  }

  const expected = btoa(`${username}:${password}`)
  const provided = authorization.slice(6)

  if (provided !== expected) {
    return new Response('Unauthorized', { status: 401 })
  }

  return null
}

async function handleFetch(request: Request) {
  const url = new URL(request.url)

  // /cloudflare.browser/{token} — token auth via URL path
  const browserMatch = url.pathname.match(/^\/cloudflare\.browser\/([^/]+)(.*)/)
  if (browserMatch) {
    const [, token] = browserMatch
    if (!env.OPENCLAW_GATEWAY_TOKEN || token !== env.OPENCLAW_GATEWAY_TOKEN) {
      return new Response('Unauthorized', { status: 401 })
    }
    const host = request.headers.get('Host') || url.host
    return proxyCdp(env.BROWSER, request, `${url.protocol}//${host}`, token)
  }

  // All other paths use Basic Auth
  const authError = verifyBasicAuth(request)
  if (authError) {
    return authError
  }
  return forwardRequestToContainer(request)
}

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Cloudflare.Env>
