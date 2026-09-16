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
function createChild(sessions: SessionStore, id: string, parentSession: string, delegationDepth: number, label?: string) {
  const session = sessions.create(SessionId(id), {
    meta: {
      parentSession: SessionId(parentSession),
      origin: 'subagent',
      delegationDepth,
      isSeeded: false,
    },
  })
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: label ?? id })
  return session
}

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

describe('collectSubagentCosts against a real session store + projection registry', () => {
  it('sums a nested delegation chain at every depth', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    const child = createChild(sessions, 'child', 'root', 1)
    const grandchild = createChild(sessions, 'grandchild', 'child', 2)
    const great = createChild(sessions, 'great', 'grandchild', 3)
    child.append('probe/usage', { input: 1000, output: 100 })
    grandchild.append('probe/usage', { input: 2000, output: 200 })
    great.append('probe/usage', { input: 3000, output: 300 })

    const result = await collectSubagentCosts(
      'root',
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )

    expect(result.map(entry => entry.sessionId).sort()).toEqual(['child', 'grandchild', 'great'])
    expect(result.map(entry => entry.depth).sort()).toEqual([1, 2, 3])
    expect(result.find(entry => entry.sessionId === 'grandchild')?.parentId).toBe('child')
    // 1000×0.001 + 100×0.002 = 1.2 · 2.4 · 3.6
    expect(sumTotals(result.map(entry => entry.totals)).cost).toBeCloseTo(7.2)
  })

  it('counts a settled child whose Agent is no longer live (no agents service at all)', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    const settled = createChild(sessions, 'settled', 'root', 1, 'probe child')
    settled.append('probe/usage', { input: 500, output: 50 })

    const result = await collectSubagentCosts(
      'root',
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result.map(entry => entry.sessionId)).toEqual(['settled'])
    expect(result[0]?.totals.cost).toBeCloseTo(0.6)
    expect(result[0]?.depth).toBe(1)
  })

  it('ignores an ordinary session and reports nothing for a conversation without subagents', async () => {
    const { sessions, projections } = makeRuntime()
    const root = sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    root.append('probe/usage', { input: 100, output: 10 })
    // A sibling conversation in the same store must never join the totals.
    const sibling = sessions.create(SessionId('sibling'), { meta: { isSeeded: false } })
    sibling.append('probe/usage', { input: 777, output: 77 })

    const result = await collectSubagentCosts(
      'root',
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
    sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    createChild(sessions, 'empty-child', 'root', 1)

    const result = await collectSubagentCosts(
      'root',
      undefined,
      sessions as unknown as SubagentSessionsService,
      projections,
      'sessionCost',
      durableTree(sessions),
    )
    expect(result.map(entry => entry.sessionId)).toEqual(['empty-child'])
    expect(result[0]?.totals.cost).toBe(0)
    expect(result[0]?.depth).toBe(1)
  })

  it('reads the currency-specific ledger key', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    const child = createChild(sessions, 'child', 'root', 1)
    child.append('probe/usage', { input: 1000, output: 100 })

    const store = sessions as unknown as SubagentSessionsService
    const cny = await collectSubagentCosts('root', undefined, store, projections, 'sessionCost', durableTree(sessions))
    const usd = await collectSubagentCosts('root', undefined, store, projections, 'sessionCostUsd', durableTree(sessions))
    expect(cny.map(entry => entry.sessionId)).toEqual(['child'])
    // No sessionCostUsd unit is registered here, so the USD read serves no row.
    expect(usd).toEqual([])
  })

  it('walks the tree without a lower bound on the number of delegations', async () => {
    const { sessions, projections } = makeRuntime()
    sessions.create(SessionId('root'), { meta: { isSeeded: false } })
    let parent = 'root'
    for (let depth = 1; depth <= 6; depth += 1) {
      const id = `level-${depth}`
      const session = createChild(sessions, id, parent, depth)
      session.append('probe/usage', { input: 1000, output: 0 })
      parent = id
    }

    const result = await collectSubagentCosts(
      'root',
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
