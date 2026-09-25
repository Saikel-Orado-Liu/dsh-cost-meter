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
import { apply, Config } from '../src/index.ts'
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
      settings registration wiring stays dormant, exactly as designed */ },
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

/**
 * The subagent half of `makeContext`: a durable subagent listing, a live
 * session store holding the child, and the ledger the projection registry
 * answers for it. Deliberately NO `agents` service — the route must count a
 * nested, already-settled subagent without a live Agent in the registry.
 */
function withSubagentTree(harness: Harness): Harness {
  const child = { id: 'child-1' }
  const root = { id: 'root' }
  const services = new Map<string, unknown>([
    ['subagents', {
      listDescendants: async (rootSessionId: string) => {
        if (rootSessionId !== 'root') return []
        return [{ kind: 'child' as const, id: 'child-1', parentId: 'root', depth: 1, label: 'probe' }]
      },
    }],
    ['sessions', {
      get: (id: string) => (id === 'child-1' ? child : id === 'root' ? root : undefined),
      list: () => [root, child],
    }],
  ])
  const original = harness.ctx.get
  harness.ctx.get = ((name: string) => (services.get(name) ?? original(name))) as Context['get']
  return harness
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
  it('marks exactly the live preferences volatile and leaves deployment config plain', () => {
    // DSH 0.1.7 derives a plugin's configuration page from this schema: a field
    // is editable only beneath a volatile node (see SettingsForms.volatileForm).
    // Losing a volatile marker silently removes the field from the Plugins page,
    // so the split itself is pinned here.
    const schema = Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }
    const volatile = Object.entries(schema.dict)
      .filter(([, node]) => node.meta?.volatile === true)
      .map(([key]) => key)
      .sort()
    expect(volatile).toEqual([
      'aliases',
      'balanceEnabled',
      'cacheReadDiscount',
      'fxMode',
      'manualRate',
      'openRouterEnabled',
      'overrides',
    ])
    // Deployment config stays hand-edited in the profile patch.
    for (const key of ['apiKeyEnv', 'baseURL', 'refreshMs', 'trustedHosts', 'snapshotHistoryLimit']) {
      expect(schema.dict[key]?.meta?.volatile).not.toBe(true)
    }
  })

  it('registers the projections and the trust-fenced route', async () => {
    const harness = makeContext()
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    expect(harness.projections.map(definition => definition.key)).toEqual([
      'sessionCost',
      'sessionCostUsd',
      'sessionCostIndex',
    ])
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

  it('serves the durable subagent tree totals for the requesting session', async () => {
    const harness = makeContext()
    const totals = { uncachedCost: 0.5, cacheReadCost: 0.1, outputCost: 0.3, cost: 0.9, pricedSteps: 2, unpricedSteps: 0, steps: 2 }
    harness.ctx.sessionProjections.snapshot = (session: { id: string }) => ({
      asOfSeq: 0,
      values: String(session.id) === 'child-1'
        ? { sessionCost: { model: null, steps: [], totals }, sessionCostUsd: { model: null, steps: [], totals } }
        : {},
    }) as never
    withSubagentTree(harness)
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')!
    const { state, res } = responder()
    const request = { method: 'GET', headers: { host: '127.0.0.1:3080' }, url: '/cost-meter?session=root' }
    await route.handler(request as never, res as never)
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as ConversationCostResponse
    expect(body.subagents).toHaveLength(1)
    expect(body.subagents[0]?.sessionId).toBe('child-1')
    expect(body.subagents[0]?.parentId).toBe('root')
    expect(body.subagents[0]?.depth).toBe(1)
    expect(body.subagents[0]?.label).toBe('probe')
    expect(body.subagents[0]?.totals.cost).toBeCloseTo(0.9)
  })

  it('answers without subagents when the durable listing fails', async () => {
    const harness = makeContext()
    withSubagentTree(harness)
    harness.ctx.get = ((name: string) => (name === 'subagents'
      ? { listDescendants: async () => { throw new Error('sessionQuery unavailable') } }
      : undefined)) as Context['get']
    await apply(harness.ctx, { pricingRefreshHours: 1 })
    const route = harness.routes.find(candidate => candidate.path === '/cost-meter')!
    const { state, res } = responder()
    await route.handler(req('GET', '127.0.0.1:3080') as never, res as never)
    expect(state.status).toBe(200)
    expect((JSON.parse(state.body) as ConversationCostResponse).subagents).toEqual([])
  })
})
