/**
 * Subagent cost aggregation: walks the live agent tree below one root
 * session and folds every descendant session's `sessionCost` projection
 * totals into a flat list the route serves to the browser. The client shows
 * the combined conversation spend (root + subagents) and a per-subagent
 * breakdown.
 *
 * The walk is a BFS over the runtime ownership relation (`agents.isOwnedBy`
 * answers the exact-parent question; `agents.list` is the live registry), so
 * arbitrarily deep delegation chains are included. Sessions whose projection
 * has no `sessionCost` value (no usage yet) are skipped.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/subagent-cost
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SessionCostTotals, SubagentCost } from './types.ts'

/** The subset of the agents service the aggregation needs. */
export interface SubagentAgentsService {
  get(id: string): { session: Session } | undefined
  isOwnedBy(id: string, owner: { session: Session }): boolean
  list(): { session: Session }[]
}

/** The subset of the sessions service the aggregation needs. */
export interface SubagentSessionsService {
  get(id: string): Session | undefined
}

/** The subset of the sessionProjections service the aggregation needs. */
export interface SubagentProjectionsService {
  snapshot(session: Session): ProjectionSnapshot
}

const ZERO_TOTALS: SessionCostTotals = {
  uncachedCost: 0,
  cacheReadCost: 0,
  outputCost: 0,
  cost: 0,
  pricedSteps: 0,
  unpricedSteps: 0,
  steps: 0,
}

/**
 * Collect every live descendant session of `rootSessionId` (BFS over the
 * runtime ownership relation) with its anchored cost totals.
 * @param rootSessionId - the root conversation's session id.
 * @param agents - the agents service (live registry).
 * @param sessions - the sessions service (session store).
 * @param projections - the sessionProjections service.
 * @returns one entry per descendant with a priced or unpriced ledger;
 *   empty when the root has no live agent or no descendants.
 */
export function collectSubagentCosts(
  rootSessionId: string,
  agents: SubagentAgentsService,
  sessions: SubagentSessionsService,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd' = 'sessionCost',
): SubagentCost[] {
  const rootAgent = agents.get(rootSessionId)
  if (rootAgent === undefined) return []

  const result: SubagentCost[] = []
  const seen = new Set<string>([rootSessionId])
  const queue: { session: Session }[] = [rootAgent]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const candidate of agents.list()) {
      const candidateId = String(candidate.session.id)
      if (seen.has(candidateId)) continue
      if (!agents.isOwnedBy(candidateId, parent)) continue
      seen.add(candidateId)
      queue.push(candidate)
      const session = sessions.get(candidateId)
      if (session === undefined) continue
      const snapshot = projections.snapshot(session)
      const cost = snapshot.values[projectionKey]
      if (cost === undefined) continue
      result.push({
        sessionId: candidateId,
        totals: cost.totals ?? { ...ZERO_TOTALS },
      })
    }
  }
  return result
}

/** Sum several totals into one (empty list → the zero totals). */
export function sumTotals(totals: readonly SessionCostTotals[]): SessionCostTotals {
  const sum = { ...ZERO_TOTALS }
  for (const totalsEntry of totals) {
    sum.uncachedCost += totalsEntry.uncachedCost
    sum.cacheReadCost += totalsEntry.cacheReadCost
    sum.outputCost += totalsEntry.outputCost
    sum.cost += totalsEntry.cost
    sum.pricedSteps += totalsEntry.pricedSteps
    sum.unpricedSteps += totalsEntry.unpricedSteps
    sum.steps += totalsEntry.steps
  }
  return sum
}
