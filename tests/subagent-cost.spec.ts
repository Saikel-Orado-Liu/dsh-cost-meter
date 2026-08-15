/**
 * Subagent aggregation coverage: the BFS over the runtime ownership
 * relation (multi-level delegation chains, no root agent, sessions without
 * a cost ledger) and the totals summation.
 */

import { describe, expect, it } from 'vitest'
import { collectSubagentCosts, sumTotals, type SubagentAgentsService, type SubagentProjectionsService, type SubagentSessionsService } from '../src/subagent-cost.ts'
import type { SessionCostTotals } from '../src/types.ts'

const ZERO: SessionCostTotals = { uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0 }
const TOTALS_A: SessionCostTotals = { uncachedCost: 1, cacheReadCost: 0.1, outputCost: 2, cost: 3.1, pricedSteps: 2, unpricedSteps: 0, steps: 2 }
const TOTALS_B: SessionCostTotals = { uncachedCost: 0.5, cacheReadCost: 0, outputCost: 1, cost: 1.5, pricedSteps: 1, unpricedSteps: 0, steps: 1 }

interface FakeSession { id: string }

/** Build a fake agent tree (parents → children) plus per-session projections. */
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
    },
    projections: {
      snapshot: (session: FakeSession) => {
        const totals = ledgers[String(session.id)]
        return { values: totals === undefined ? {} : { sessionCost: { model: null, steps: [], totals } } }
      },
    },
  }
}

describe('collectSubagentCosts', () => {
  it('collects one-level children with their totals', () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a', 'child-b'] },
      { 'child-a': TOTALS_A, 'child-b': TOTALS_B },
    )
    const result = collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(2)
    expect(result.map(entry => entry.sessionId).sort()).toEqual(['child-a', 'child-b'])
    expect(result.find(entry => entry.sessionId === 'child-a')?.totals.cost).toBeCloseTo(3.1)
  })

  it('walks multi-level delegation chains (grandchildren included)', () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a'], 'child-a': ['grandchild'] },
      { 'child-a': TOTALS_A, grandchild: TOTALS_B },
    )
    const result = collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(2)
    expect(result.map(entry => entry.sessionId).sort()).toEqual(['child-a', 'grandchild'])
  })

  it('returns empty for an unknown root or no live descendants', () => {
    const { agents, sessions, projections } = makeTree({ root: [] }, {})
    expect(collectSubagentCosts('missing', agents, sessions, projections)).toEqual([])
    expect(collectSubagentCosts('root', agents, sessions, projections)).toEqual([])
  })

  it('skips descendant sessions whose projection has no cost ledger yet', () => {
    const { agents, sessions, projections } = makeTree(
      { root: ['child-a', 'child-b'] },
      { 'child-a': TOTALS_A },
    )
    const result = collectSubagentCosts('root', agents, sessions, projections)
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('child-a')
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
