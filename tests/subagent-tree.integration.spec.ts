/**
 * Durable-tree aggregation against a REAL DSH session store and projection
 * registry: the deployment shape that matters. Sessions are created exactly
 * as the runtime creates subagents (header metadata with `parentSession`,
 * `origin: 'subagent'`, `delegationDepth`, plus the durable
 * `subagent/descriptor` event), and the tree is enumerated through the same
 * `parentSession` lineage the product's own `listDescendants` walks.
 *
 * This is the regression the live agent-registry walk missed: nested
 * delegation (a subagent that delegates again) and children that already
 * settled out of the live registry. The enumerator below is a test-local
 * stand-in for `subagents.listDescendants` — the DSH listing's own corpus and
 * projection-cache behavior are DSH's contract, while the shape this module
 * consumes from it is what these tests pin.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { collectSubagentCosts, sumTotals, type SubagentSessionsService, type SubagentTreeService } from '../src/subagent-cost.ts'
import type { SessionCostTotals } from '../src/types.ts'

/** The probe ledger's fixed per-token prices (CNY). */
const COST_PER_INPUT = 1 / 1000
const COST_PER_OUTPUT = 2 / 1000

const zeroTotals = (): SessionCostTotals => ({
  uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0,
})

/** A `sessionCost`-shaped ledger unit over the real registry. */
function probeLedgerProjection() {
  const passthrough = { parse: (value: unknown) => value }
  return {
    key: 'sessionCost' as const,
    stateVersion: 1,
    stateSchema: passthrough,
    init: () => ({ totals: zeroTotals(), model: null, steps: [] as unknown[] }),
    apply: (state: { totals: SessionCostTotals; model: null; steps: unknown[] }, event: { type: string; data?: unknown }) => {
      if (event.type !== 'probe/usage') return state
      const usage = event.data as { input: number; output: number }
      const uncachedCost = usage.input * COST_PER_INPUT
      const outputCost = usage.output * COST_PER_OUTPUT
      return {
        ...state,
        totals: {
          uncachedCost: state.totals.uncachedCost + uncachedCost,
          cacheReadCost: 0,
          outputCost: state.totals.outputCost + outputCost,
          cost: state.totals.cost + uncachedCost + outputCost,
          pricedSteps: state.totals.pricedSteps + 1,
          unpricedSteps: 0,
          steps: state.totals.steps + 1,
        },
      }
    },
    wire: {
      viewSchema: passthrough,
      view: (state: { totals: SessionCostTotals; model: null; steps: unknown[] }) => state,
    },
  }
}

/** Build a context with the real session store, projection registry, and probe ledger. */
function makeRuntime() {
  const ctx = new Context()
  const sessions = new SessionStore(ctx)
  const projections = new SessionProjectionRegistry(ctx)
  // The registry types its keys through the DSH module augmentation; the probe
  // registers a test-local key, so the cast is deliberate.
  projections.register(probeLedgerProjection() as never)
  return { ctx, sessions, projections }
}

/** Create a subagent session the way the runtime's continuation manager does. */
function createChild(sessions: SessionStore, id: string, parentSession: string | { toString(): string }, delegationDepth: number, label?: string) {
  // Headers must be lossless JSON: a branded SessionId VALUE is a class
  // instance, so the parent reference is always the plain string.
  const parent = typeof parentSession === 'string' ? parentSession : String(parentSession)
  const session = sessions.create(SessionId(id), {
    meta: {
      parentSession: SessionId(parent),
      origin: 'subagent',
      delegationDepth,
      isSeeded: false,
    },
  })
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: label ?? id })
  return session
}

/**
 * Unique session ids per run: the cold-ledger cache is process-global and
 * keyed by session id, so reusing ids across tests would serve a fold computed
 * by an earlier test.
 */
/** The root conversation id for this run (each test owns its own store). */
let idCounter = 0
function uniqueId(base: string): string {
  idCounter += 1
  return `${base}-${idCounter}`
}
const rootId = uniqueId('root')

/**
 * Enumerate the durable subagent tree from the live store exactly as the
 * product's listing does: origin-classified children keyed by their own
 * `parentSession`, walked depth-first in creation order, carrying `parentId`
 * and root-relative `depth`.
 */
function durableTree(sessions: SessionStore): SubagentTreeService {
  return {
    listDescendants: async (rootSessionId: string): Promise<readonly SubagentDescendantListEntry[]> => {
      const byParent = new Map<string, ReturnType<SessionStore['list']>>()
      for (const session of sessions.list()) {
        const parentSession = session.header.parentSession
        if (parentSession === undefined) continue
        const siblings = byParent.get(String(parentSession)) ?? []
        siblings.push(session)
        byParent.set(String(parentSession), siblings)
      }
      for (const siblings of byParent.values()) {
        siblings.sort((left, right) => left.header.createdAt - right.header.createdAt || String(left.id).localeCompare(String(right.id)))
      }
      const entries: SubagentDescendantListEntry[] = []
      const visited = new Set([rootSessionId])
      const walk = (parentId: string, depth: number): void => {
        for (const session of byParent.get(parentId) ?? []) {
          const id = String(session.id)
          if (visited.has(id)) continue
          visited.add(id)
          if (session.header.origin === 'subagent') {
            entries.push({
              kind: 'child',
              id: session.id,
              parentId: SessionId(parentId),
              depth,
              activity: 'running',
              hasChildren: (byParent.get(id) ?? []).length > 0,
              mode: 'continuable',
              label: id,
            })
          }
          walk(id, depth + 1)
        }
      }
      walk(rootSessionId, 1)
      return entries
    },
  }
}

/** A stored-log reader over the sessions this test created (the cold seam). */
function storedLogs(sessions: SessionStore) {
  const byId = new Map(sessions.list().map(session => [String(session.id), session]))
  return {
    readSession: async (sessionId: string) => {
      const session = byId.get(sessionId)
      if (session === undefined) throw new Error(`no stored session ${sessionId}`)
      return {
        session: session.header,
        inheritedEventCount: session.inheritedEventCount,
        events: [...session.snapshotEvents()],
      }
    },
  }
}

/** A sessions service that exposes NO live session (a freshly restarted host). */
function noLiveSessions(): SubagentSessionsService {
  return { get: () => undefined, list: () => [] }
}

describe('collectSubagentCosts against a real session store + projection registry', () => {
  it('sums a nested delegation chain at every depth', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const child = createChild(sessions, uniqueId('child'), rootId, 1)
    const grandchild = createChild(sessions, uniqueId('grandchild'), String(child.id), 2)
    const great = createChild(sessions, uniqueId('great'), String(grandchild.id), 3)
    child.append('probe/usage', { input: 1000, output: 100 })
    grandchild.append('probe/usage', { input: 2000, output: 200 })
    great.append('probe/usage', { input: 3000, output: 300 })

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )

    expect(result.map(entry => entry.sessionId).sort()).toEqual([String(child.id), String(grandchild.id), String(great.id)].sort())
    expect(result.map(entry => entry.depth).sort()).toEqual([1, 2, 3])
    expect(result.find(entry => entry.sessionId === String(grandchild.id))?.parentId).toBe(String(child.id))
    // 1000×0.001 + 100×0.002 = 1.2 · 2.4 · 3.6
    expect(sumTotals(result.map(entry => entry.totals)).cost).toBeCloseTo(7.2)
  })

  it('counts a settled child whose Agent is no longer live (no agents service at all)', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const settled = createChild(sessions, uniqueId('settled'), rootId, 1, 'probe child')
    settled.append('probe/usage', { input: 500, output: 50 })

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result.map(entry => entry.sessionId)).toEqual([String(settled.id)])
    expect(result[0]?.totals.cost).toBeCloseTo(0.6)
    expect(result[0]?.depth).toBe(1)
  })

  it('ignores an ordinary session and reports nothing for a conversation without subagents', async () => {
    const { sessions, projections } = makeRuntime()
    const root = sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    root.append('probe/usage', { input: 100, output: 10 })
    // A sibling conversation in the same store must never join the totals.
    const sibling = sessions.create(SessionId('sibling'), { meta: { isSeeded: false } })
    sibling.append('probe/usage', { input: 777, output: 77 })

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result).toEqual([])
  })

  it('serves a child that never used a model as an explicit zero row', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const empty = createChild(sessions, uniqueId('empty-child'), rootId, 1)

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result.map(entry => entry.sessionId)).toEqual([String(empty.id)])
    expect(result[0]?.totals.cost).toBe(0)
    expect(result[0]?.depth).toBe(1)
  })

  it('reads the currency-specific ledger key', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const child = createChild(sessions, uniqueId('child'), rootId, 1)
    child.append('probe/usage', { input: 1000, output: 100 })

    const store = sessions as unknown as SubagentSessionsService
    const cny = await collectSubagentCosts(rootId, undefined, store, projections, 'sessionCost', durableTree(sessions))
    const usd = await collectSubagentCosts(rootId, undefined, store, projections, 'sessionCostUsd', durableTree(sessions))
    expect(cny.map(entry => entry.sessionId)).toEqual([String(child.id)])
    // No sessionCostUsd unit is registered here, so the USD read serves no row.
    expect(usd).toEqual([])
  })

  it('walks the tree without a lower bound on the number of delegations', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    let parent = rootId
    for (let depth = 1; depth <= 6; depth += 1) {
      const id = `level-${depth}`
      const session = createChild(sessions, id, parent, depth)
      session.append('probe/usage', { input: 1000, output: 0 })
      parent = id
    }

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result).toHaveLength(6)
    expect(Math.max(...result.map(entry => entry.depth))).toBe(6)
    expect(sumTotals(result.map(entry => entry.totals)).cost).toBeCloseTo(6)
  })
})

describe('collectSubagentCosts cold path (restarted host, no live sessions)', () => {
  it('folds every stored child from its persisted log at every depth', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const child = createChild(sessions, uniqueId('child'), rootId, 1)
    const grandchild = createChild(sessions, uniqueId('grandchild'), String(child.id), 2)
    const great = createChild(sessions, uniqueId('great'), String(grandchild.id), 3)
    child.append('probe/usage', { input: 1000, output: 100 })
    grandchild.append('probe/usage', { input: 2000, output: 200 })
    great.append('probe/usage', { input: 3000, output: 300 })

    // The host RESTARTED: no session is resident, so the live projection face
    // can answer nothing — the entire tree must come from the stored logs.
    const result = await collectSubagentCosts(
      rootId,
      undefined,
      noLiveSessions(),
      projections,
      'sessionCost',
      durableTree(sessions),
      storedLogs(sessions),
    )

    expect(result.map(entry => entry.sessionId).sort()).toEqual([String(child.id), String(grandchild.id), String(great.id)].sort())
    expect(result.map(entry => entry.depth).sort()).toEqual([1, 2, 3])
    expect(sumTotals(result.map(entry => entry.totals)).cost).toBeCloseTo(7.2)
  })

  it('reports nothing when the cold seam is absent (no query service)', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    createChild(sessions, uniqueId('child'), rootId, 1).append('probe/usage', { input: 1000, output: 100 })

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      noLiveSessions(),
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result).toEqual([])
  })

  it('contains one unreadable child log without hiding the others', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const brokenId = uniqueId('broken')
    createChild(sessions, brokenId, rootId, 1).append('probe/usage', { input: 1000, output: 100 })
    const fine = createChild(sessions, uniqueId('fine'), rootId, 1)
    fine.append('probe/usage', { input: 500, output: 50 })
    const logs = storedLogs(sessions)

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      noLiveSessions(),
      projections,
      'sessionCost',
      durableTree(sessions),
      {
        readSession: async (id: string) => {
          if (id === brokenId) throw new Error('log pruned')
          return logs.readSession(id)
        },
      },
    )
    expect(result.map(entry => entry.sessionId)).toEqual([String(fine.id)])
    expect(result[0]?.totals.cost).toBeCloseTo(0.6)
  })

  it('serves a stored child with no model usage as an explicit zero row', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId(rootId), { meta: { isSeeded: false } })
    const idle = createChild(sessions, uniqueId('idle-child'), rootId, 1)

    const result = await collectSubagentCosts(
      rootId,
      undefined,
      noLiveSessions(),
      projections,
      'sessionCost',
      durableTree(sessions),
      storedLogs(sessions),
    )
    expect(result.map(entry => entry.sessionId)).toEqual([String(idle.id)])
    expect(result[0]?.totals.cost).toBe(0)
  })
})
