/**
 * apply() integration: drives the real plugin apply against fake services —
 * the /cost-meter route (GET view, POST settings actions, trust
 * fence, method guard), the sessionCost projection registration, and the
 * pricebook snapshot lifecycle through the route. Network is stubbed so the
 * tests stay hermetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { apply, type Config } from '../src/index.ts'
import type { ConversationCostResponse } from '../src/types.ts'

/** The official pricing page markup the stub fetch serves. */
const PAGE_HTML = `
<table>
<tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr>
<tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>3元</td></tr>
<tr><td>百万tokens输出</td><td>2元</td><td>6元</td></tr>
<tr><td>并发限制</td><td>2500</td><td>500</td></tr>
</table>
<h2>新价格</h2>
<table>
<tr><td>deepseek-v4-flash</td><td>空闲时段</td><td>0.05元</td><td>1.5元</td><td>4.5元</td><td>高峰时段</td><td>0.10元</td><td>3.0元</td><td>9.0元</td></tr>
<tr><td>deepseek-v4-pro</td><td>空闲时段</td><td>0.15元</td><td>4.5元</td><td>13.5元</td><td>高峰时段</td><td>0.30元</td><td>9.0元</td><td>27.0元</td></tr>
</table>
`

interface Harness {
  ctx: Context
  routes: WebRoute[]
  projections: ProjectionDefinition<string, unknown>[]
  disposers: (() => void)[]
}

function makeContext(): Harness {
  const routes: WebRoute[] = []
  const projections: ProjectionDefinition<string, unknown>[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    get: () => undefined,
    effect: (fn: () => unknown) => {
      const disposer = fn() as () => void
      disposers.push(disposer)
      return disposer
    },
    inject: () => { /* the settings service is absent in this harness: the
      installSettingsSection wiring stays dormant, exactly as designed */ },
    webServer: {
      register: (route: WebRoute) => {
        routes.push(route)
        return () => { /* route removals are exercised by the invariant companion */ }
      },
    },
    sessionProjections: {
      register: (definition: ProjectionDefinition<string, unknown>) => {
        projections.push(definition)
        return () => { /* noop */ }
      },
    },
  } as unknown as Context
  return { ctx, routes, projections, disposers }
}

function responder() {
  const state = { status: 0, headers: {} as Record<string, unknown>, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      state.status = status
      state.headers = headers
    },
    end(body: string) {
      state.body = body
    },
  }
  return { state, res }
}

const req = (method: string, host = '127.0.0.1:3080', body?: unknown): IncomingMessageLike => ({
  method,
  headers: { host },
  ...(body === undefined ? {} : { [Symbol.asyncIterator]: async function* () {
    yield Buffer.from(JSON.stringify(body))
  } }),
}) as never

interface IncomingMessageLike {
  method: string
  headers: { host: string }
}

beforeEach(() => {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url.includes('api-docs.deepseek.com')) {
      return { ok: true, status: 200, text: async () => PAGE_HTML }
    }
    if (url.includes('openrouter')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ rates: { CNY: 7.35 } }) }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apply integration', () => {
  it('registers the projection and the trust-fenced route', async () => {
    const harness = makeContext()
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    expect(harness.projections.map(definition => definition.key)).toEqual(['sessionCost', 'sessionCostUsd'])
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')
    expect(route).toBeDefined()
    expect(harness.disposers.length).toBeGreaterThan(0)
  })

  it('serves the pricebook view and an anchored current snapshot over GET', async () => {
    const harness = makeContext()
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')!
    const { state, res } = responder()
    await route.handler(req('GET') as never, res as never)
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as ConversationCostResponse
    expect(body.pricebook.current?.version).toBe(1)
    expect(body.pricebook.current?.source).toBe('official')
    expect(body.pricebook.current?.prices.flash?.single?.inputPerMillion).toBe(1)
    expect(body.pricebook.balanceEnabled).toBe(true)
  })

  it('refreshes the pricebook over POST (the only remaining action)', async () => {
    const harness = makeContext()
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')!
    const post = responder()
    await route.handler(req('POST', '127.0.0.1:3080', { action: 'refresh' }) as never, post.res as never)
    expect(post.state.status).toBe(200)
    const body = JSON.parse(post.state.body) as ConversationCostResponse
    expect(body.pricebook.current?.version).toBe(1)
    expect(body.pricebook.current?.source).toBe('official')
  })

  it('rejects unknown actions with 400 and untrusted hosts with 403', async () => {
    const harness = makeContext()
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')!
    const bad = responder()
    await route.handler(req('POST', '127.0.0.1:3080', { action: 'nope' }) as never, bad.res as never)
    expect(bad.state.status).toBe(400)
    const evil = responder()
    await route.handler(req('GET', 'evil.example') as never, evil.res as never)
    expect(evil.state.status).toBe(403)
    const put = responder()
    await route.handler(req('PUT') as never, put.res as never)
    expect(put.state.status).toBe(405)
  })
})
