/**
 * Subagent aggregation coverage: the durable session-backed tree
 * (`subagents.listDescendants`: nested delegation, settled children, cold
 * sessions, live-preferred dedupe), the runtime ownership walk that backs a
 * deployment without a subagents service, and the totals summation.
 */

import { describe, expect, it } from 'vitest'
import {
  collectSubagentCosts,
  sumTotals,
  type SubagentAgentsService,
  type SubagentProjectionsService,
  type SubagentSessionsService,
  type SubagentTreeService,
} from '../src/subagent-cost.ts'
import type { SessionCostTotals } from '../src/types.ts'

const ZERO: SessionCostTotals = { uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0 }
const TOTALS_A: SessionCostTotals = { uncachedCost: 1, cacheReadCost: 0.1, outputCost: 2, cost: 3.1, pricedSteps: 2, unpricedSteps: 0, steps: 2 }
const TOTALS_B: SessionCostTotals = { uncachedCost: 0.5, cacheReadCost: 0, outputCost: 1, cost: 1.5, pricedSteps: 1, unpricedSteps: 0, steps: 1 }

interface FakeSession { id: string }

/** Build a fake agent tree (parents → children) plus per-session ledgers. */
function makeTree(
  parents: Record<string, string[]>,
  ledgers: Record<string, SessionCostTotals>,
): {
  agents: SubagentAgentsService
  sessions: SubagentSessionsService
  projections: SubagentProjectionsService
} {
  const agents = new Map<string, { session: FakeSession }>()
  const ownerOf = new Map<string, { session: FakeSession }>()
  // Create every agent once, then wire ownership with the SAME objects.
  const ids = new Set([...Object.keys(parents), ...Object.values(parents).flat()])
  for (const id of ids) agents.set(id, { session: { id } })
  for (const [parent, children] of Object.entries(parents)) {
    const parentAgent = agents.get(parent)!
    for (const child of children) ownerOf.set(child, parentAgent)
  }
  const sessions = new Map<string, FakeSession>()
  for (const id of Object.keys(ledgers)) sessions.set(id, { id })
  return {
    agents: {
      get: (id: string) => agents.get(id) as unknown,
      isOwnedBy: (id: string, owner: { session: unknown }) => ownerOf.get(id) === owner,
      list: () => [...agents.values()] as unknown,
    },
    sessions: {
      get: (id: string) => sessions.get(id) as unknown,
      list: () => [...sessions.values()] as unknown,
    },
    projections: {
      snapshot: (session: FakeSession) => {
        const totals = ledgers[String(session.id)]
        return { values: totals === undefined ? {} : { sessionCost: { model: null, steps: [], totals } } }
      },
    },
  }
}

/**
 * Build the host-side shape of the real deployment: a durable session store
 * holding every session (only some with a ledger) plus the durable
 * `listDescendants` rows. No live agent registry is provided, which is the
 * point — nested and settled children must still be found.
 */
function makeDurableTree(
  descendants: { id: string; parentId: string; depth: number; label?: string; kind?: 'child' | 'diagnostic' }[],
  ledgers: Record<string, SessionCostTotals>,
  options: { missing?: string[]; throwing?: string[] } = {},
): {
  sessions: SubagentSessionsService
  projections: SubagentProjectionsService
  subagents: SubagentTreeService
  calls: string[]
} {
  const missing = new Set(options.missing ?? [])
  const throwing = new Set(options.throwing ?? [])
  const live = new Set(['root', ...Object.keys(ledgers)])
  for (const id of missing) live.delete(id)
  const sessions: FakeSession[] = [...live].map(id => ({ id }))
  const calls: string[] = []
  return {
    sessions: {
      get: (id: string) => sessions.find(session => session.id === id) as unknown,
      list: () => sessions as unknown,
    },
    projections: {
      snapshot: (session: FakeSession) => {
        const id = String(session.id)
        if (throwing.has(id)) throw new Error(`fold failed for ${id}`)
        const totals = ledgers[id]
        return { values: totals === undefined ? {} : { sessionCost: { model: null, steps: [], totals } } }
      },
    },
    subagents: {
      listDescendants: async (rootSessionId: string) => {
        calls.push(rootSessionId)
        return descendants.map(entry => ({
          kind: entry.kind ?? 'child',
          id: entry.id,
          parentId: entry.parentId,
          depth: entry.depth,
          ...(entry.label === undefined ? {} : { label: entry.label }),
        }))
      },
    },
    calls,
  }
}

describe('collectSubagentCosts — durable session-backed tree', () => {
  it('counts nested delegation at every depth', async () => {
    const tree = makeDurableTree(
      [
        { id: 'child', parentId: 'root', depth: 1 },
        { id: 'grandchild', parentId: 'child', depth: 2 },
        { id: 'great-grandchild', parentId: 'grandchild', depth: 3 },
      ],
      { child: TOTALS_A, grandchild: TOTALS_B, 'great-grandchild': TOTALS_A },
    )
    const result = await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(result.map(entry => entry.sessionId)).toEqual(['child', 'grandchild', 'great-grandchild'])
    expect(result.map(entry => entry.depth)).toEqual([1, 2, 3])
    expect(result[1]?.parentId).toBe('child')
    expect(sumTotals(result.map(entry => entry.totals)).cost).toBeCloseTo(7.7)
  })

  it('keeps a settled child whose session is still resident in the store', async () => {
    // A one-shot child that already finished: its Agent is gone from the live
    // registry, which is exactly what the old aggregation missed.
    const tree = makeDurableTree(
      [{ id: 'settled', parentId: 'root', depth: 1, label: 'probe' }],
      { settled: TOTALS_A },
    )
    const result = await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(result).toHaveLength(1)
    expect(result[0]?.sessionId).toBe('settled')
    expect(result[0]?.label).toBe('probe')
    expect(result[0]?.totals.cost).toBeCloseTo(3.1)
  })

  it('skips a child the live store does not hold and diagnostics, and never counts the root', async () => {
    const tree = makeDurableTree(
      [
        { id: 'cold', parentId: 'root', depth: 1 },
        { id: 'corrupt', parentId: 'root', depth: 1, kind: 'diagnostic' },
        { id: 'root', parentId: 'root', depth: 0 },
        { id: 'known', parentId: 'root', depth: 1 },
      ],
      { cold: TOTALS_A, root: TOTALS_A, known: TOTALS_B },
      { missing: ['cold'] },
    )
    const result = await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(result.map(entry => entry.sessionId)).toEqual(['known'])
  })

  it('contains one child whose fold throws', async () => {
    const tree = makeDurableTree(
      [{ id: 'broken', parentId: 'root', depth: 1 }, { id: 'fine', parentId: 'root', depth: 1 }],
      { broken: TOTALS_A, fine: TOTALS_B },
      { throwing: ['broken'] },
    )
    const result = await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(result.map(entry => entry.sessionId)).toEqual(['fine'])
  })

  it('reads the currency-specific projection key', async () => {
    const sessions: SubagentSessionsService = { get: () => ({ id: 'child' }) as never, list: () => [{ id: 'child' }] as never }
    const projections: SubagentProjectionsService = {
      snapshot: () => ({ values: { sessionCostUsd: { model: null, steps: [], totals: TOTALS_B } } }) as never,
    }
    const subagents: SubagentTreeService = { listDescendants: async () => [{ kind: 'child', id: 'child', parentId: 'root', depth: 1 }] }
    const result = await collectSubagentCosts('root', undefined, sessions, projections, 'sessionCostUsd', subagents)
    expect(result[0]?.totals.cost).toBeCloseTo(1.5)
  })

  it('queries the tree once per call', async () => {
    const tree = makeDurableTree([{ id: 'child', parentId: 'root', depth: 1 }], { child: TOTALS_A })
    await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(tree.calls).toEqual(['root'])
  })
})

describe('collectSubagentCosts — runtime ownership fallback', () => {
  it('collects one-level children with their totals', async () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a', 'child-b'] },
      { 'child-a': TOTALS_A, 'child-b': TOTALS_B },
    )
    const result = await collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(2)
    expect(result.map(entry => entry.sessionId).sort()).toEqual(['child-a', 'child-b'])
    expect(result.find(entry => entry.sessionId === 'child-a')?.totals.cost).toBeCloseTo(3.1)
    // The runtime relation states no root-relative distance.
    expect(result.every(entry => entry.depth === -1)).toBe(true)
  })

  it('walks multi-level delegation chains (grandchildren included)', async () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a'], 'child-a': ['grandchild'] },
      { 'child-a': TOTALS_A, grandchild: TOTALS_B },
    )
    const result = await collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(2)
    expect(result.map(entry => entry.sessionId).sort()).toEqual(['child-a', 'grandchild'])
  })

  it('returns empty for an unknown root or no live descendants', async () => {
    const { agents, sessions, projections } = makeTree({ root: [] }, {})
    expect(await collectSubagentCosts('missing', agents, sessions, projections)).toEqual([])
    expect(await collectSubagentCosts('root', agents, sessions, projections)).toEqual([])
  })

  it('skips descendant sessions whose projection has no cost ledger yet', async () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a', 'child-b'] },
      { 'child-a': TOTALS_A },
    )
    const result = await collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(1)
    expect(result[0]?.sessionId).toBe('child-a')
  })
})

describe('collectSubagentCosts — durable listing plus runtime registry', () => {
  it('adds a row only one source can prove, without double counting', async () => {
    // Shared ledger fixture: both sides resolve a row by session id.
    const ledgers = { 'durable-child': TOTALS_A, 'runtime-child': TOTALS_B }
    const tree = makeDurableTree([{ id: 'durable-child', parentId: 'root', depth: 1 }], ledgers)
    const runtime = makeTree({ root: ['durable-child', 'runtime-child'] }, ledgers)
    // The durable store must hold the runtime-only child too, since the row is
    // read from that store (the real deployment keeps every live session there).
    const sessions: SubagentSessionsService = {
      get: id => tree.sessions.get(id) ?? runtime.sessions.get(id),
      list: () => [...tree.sessions.list(), ...runtime.sessions.list()],
    }
    const result = await collectSubagentCosts(
      'root',
      runtime.agents,
      sessions,
      tree.projections,
      'sessionCost',
      tree.subagents,
    )
    expect(result.map(entry => entry.sessionId).sort()).toEqual(['durable-child', 'runtime-child'])
    expect(result.find(entry => entry.sessionId === 'runtime-child')?.depth).toBe(-1)
  })

  it('falls back to the live registry when the durable listing fails', async () => {
    const runtime = makeTree({ root: ['child'] }, { child: TOTALS_A })
    const subagents: SubagentTreeService = {
      listDescendants: async () => { throw new Error('sessionQuery unavailable') },
    }
    const result = await collectSubagentCosts('root', runtime.agents, runtime.sessions, runtime.projections, 'sessionCost', subagents)
    expect(result.map(entry => entry.sessionId)).toEqual(['child'])
    expect(result[0]?.totals.cost).toBeCloseTo(3.1)
  })

  it('returns the durable rows when no live agent registry is mounted', async () => {
    const tree = makeDurableTree([{ id: 'child', parentId: 'root', depth: 1 }], { child: TOTALS_A })
    const result = await collectSubagentCosts('root', undefined, tree.sessions, tree.projections, 'sessionCost', tree.subagents)
    expect(result).toHaveLength(1)
  })
})

describe('sumTotals', () => {
  it('sums every field and returns zeros for an empty list', () => {
    const sum = sumTotals([TOTALS_A, TOTALS_B])
    expect(sum.cost).toBeCloseTo(4.6)
    expect(sum.uncachedCost).toBeCloseTo(1.5)
    expect(sum.cacheReadCost).toBeCloseTo(0.1)
    expect(sum.outputCost).toBeCloseTo(3)
    expect(sum.pricedSteps).toBe(3)
    expect(sumTotals([])).toEqual(ZERO)
  })
})
