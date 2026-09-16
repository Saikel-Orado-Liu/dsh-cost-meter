/**
 * Subagent cost aggregation: enumerates every subagent session below one root
 * conversation and folds each one's `sessionCost` projection totals into a
 * flat list the route serves to the browser. The client shows the combined
 * conversation spend (root + every nesting level) and a per-subagent
 * breakdown.
 *
 * Enumeration is the durable, session-backed subagent tree
 * (`subagents.listDescendants`, the same listing the product's own subagent
 * catalog uses): it walks `parentSession` lineage recorded on every session
 * header, so a subagent that delegates further, a one-shot child, and a child
 * that has already settled out of the live agent registry are all counted at
 * any depth. The corpus is live-preferred but persistent-backed, which is why
 * nested and finished children no longer depend on an in-memory Agent
 * surviving.
 *
 * The runtime ownership walk over the live agent registry (`agents.isOwnedBy`
 * + `agents.list`) remains as a fallback for a deployment that mounts no
 * `subagents` service; entries it contributes carry `depth: -1` because the
 * runtime relation knows no root-relative distance.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/subagent-cost
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type { SessionCostTotals, SubagentCost } from './types.ts'

/** The subset of the agents service the fallback walk needs. */
export interface SubagentAgentsService {
  get(id: string): { session: Session } | undefined
  isOwnedBy(id: string, owner: { session: Session }): boolean
  list(): { session: Session }[]
}

/** The subset of the sessions service the aggregation needs. */
export interface SubagentSessionsService {
  get(id: string): Session | undefined
  list(): Session[]
}

/** The subset of the sessionProjections service the aggregation needs. */
export interface SubagentProjectionsService {
  snapshot(session: Session): ProjectionSnapshot
}

/** One session-backed descendant row of the product's subagent listing. */
interface SubagentDescendantEntry {
  readonly kind: 'child' | 'diagnostic'
  readonly id: unknown
  readonly label?: string
  readonly parentId?: unknown
  readonly depth?: number
}

/**
 * The subset of the subagents service the durable enumeration needs. The real
 * service answers with branded `SessionId` values and takes one, so the
 * interface stays permissive at both ends and the module brands only what it
 * hands back into the service.
 */
export interface SubagentTreeService {
  listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<readonly SubagentDescendantEntry[]>
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

/** Resolve the ledger of one session, or undefined when it carries none yet. */
function totalsOf(
  session: Session | undefined,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd',
): SessionCostTotals | undefined {
  if (session === undefined) return undefined
  let snapshot: ProjectionSnapshot
  try {
    snapshot = projections.snapshot(session)
  } catch {
    // A session whose fold throws must not take down the whole aggregation.
    return undefined
  }
  return snapshot.values[projectionKey]?.totals
}

/**
 * Index the live session store by id. Read once per request so the durable
 * listing resolves every row without a per-child store lookup.
 */
function liveSessionsById(sessions: SubagentSessionsService): Map<string, Session> {
  const index = new Map<string, Session>()
  for (const session of sessions.list()) {
    const id = String(session.id)
    if (!index.has(id)) index.set(id, session)
  }
  return index
}

/**
 * Fold the durable subagent tree into cost rows. A child whose session carries
 * no ledger yet (never used a model, or a cold session the live store does not
 * hold) is skipped, as is a `diagnostic` row, which names no interpreted
 * child.
 * @param rootSessionId - the root conversation's session id.
 * @param subagents - the subagents service (durable tree enumeration).
 * @param sessions - the sessions service (live session store).
 * @param projections - the sessionProjections service.
 * @param projectionKey - the currency-specific ledger key.
 * @returns one entry per descendant that has a ledger.
 * @throws whatever the listing throws; the caller decides the fallback.
 */
async function collectDurableSubagentCosts(
  rootSessionId: string,
  subagents: SubagentTreeService,
  sessions: SubagentSessionsService,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd',
): Promise<SubagentCost[]> {
  const entries = await subagents.listDescendants(rootSessionId)
  if (entries.length === 0) return []

  const live = liveSessionsById(sessions)
  const result: SubagentCost[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'child') continue
    const sessionId = String(entry.id)
    if (sessionId.length === 0 || sessionId === rootSessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    const totals = totalsOf(live.get(sessionId), projections, projectionKey)
    if (totals === undefined) continue
    result.push({
      sessionId,
      ...(entry.parentId === undefined ? {} : { parentId: String(entry.parentId) }),
      depth: entry.depth ?? 1,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      totals,
    })
  }
  return result
}

/**
 * Walk the live runtime ownership tree (breadth-first) for deployments that
 * mount no subagents service. Rows the durable listing already covered are
 * skipped by id.
 * @param rootSessionId - the root conversation's session id.
 * @param agents - the agents service (live registry).
 * @param sessions - the sessions service.
 * @param projections - the sessionProjections service.
 * @param projectionKey - the currency-specific ledger key.
 * @param already - session ids the durable listing already served.
 * @returns one entry per newly discovered descendant that has a ledger.
 */
function collectRuntimeSubagentCosts(
  rootSessionId: string,
  agents: SubagentAgentsService,
  sessions: SubagentSessionsService,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd',
  already: ReadonlySet<string>,
): SubagentCost[] {
  const rootAgent = agents.get(rootSessionId)
  if (rootAgent === undefined) return []

  const result: SubagentCost[] = []
  const seen = new Set<string>([rootSessionId, ...already])
  const queue: { session: Session }[] = [rootAgent]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const candidate of agents.list()) {
      const candidateId = String(candidate.session.id)
      if (seen.has(candidateId)) continue
      if (!agents.isOwnedBy(candidateId, parent)) continue
      seen.add(candidateId)
      queue.push(candidate)
      const totals = totalsOf(sessions.get(candidateId), projections, projectionKey)
      if (totals === undefined) continue
      result.push({ sessionId: candidateId, depth: -1, totals })
    }
  }
  return result
}

/**
 * Collect every session-backed descendant of `rootSessionId` with its
 * anchored cost totals: the durable subagent tree first (nested, settled, and
 * cold children included), then the live runtime ownership walk for whatever
 * the listing could not reach.
 * @param rootSessionId - the root conversation's session id.
 * @param agents - the agents service (live registry).
 * @param sessions - the sessions service (session store).
 * @param projections - the sessionProjections service.
 * @param projectionKey - the currency-specific ledger key.
 * @param subagents - the subagents service; omitted, only the runtime walk runs.
 * @returns one entry per descendant with a priced or unpriced ledger; empty
 *   when the conversation has no subagents.
 */
export async function collectSubagentCosts(
  rootSessionId: string,
  agents: SubagentAgentsService | undefined,
  sessions: SubagentSessionsService,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd' = 'sessionCost',
  subagents?: SubagentTreeService,
): Promise<SubagentCost[]> {
  let durable: SubagentCost[] = []
  if (subagents !== undefined) {
    try {
      durable = await collectDurableSubagentCosts(rootSessionId, subagents, sessions, projections, projectionKey)
    } catch {
      // A listing failure (no session query, a cancelled read, corrupt log)
      // must not hide the subagents the live registry can still prove.
      durable = []
    }
  }
  if (agents === undefined) return durable
  const already = new Set(durable.map(entry => entry.sessionId))
  return [...durable, ...collectRuntimeSubagentCosts(rootSessionId, agents, sessions, projections, projectionKey, already)]
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
