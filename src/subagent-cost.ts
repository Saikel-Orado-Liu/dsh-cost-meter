/**
 * Subagent cost aggregation: enumerates every subagent session below one root
 * conversation and folds each one's `sessionCost` projection totals into a
 * flat list the route serves to the browser. The client shows the combined
 * conversation spend (root + every nesting level) and a per-subagent
 * breakdown.
 *
 * Two seams, in this order:
 *
 * 1. **Enumeration** — the durable, session-backed subagent tree
 *    (`subagents.listDescendants`, the same listing the product's own subagent
 *    catalog uses): it walks `parentSession` lineage recorded on every session
 *    header, so a subagent that delegates further, a one-shot child, and a
 *    child whose Agent was unloaded are all found at any depth.
 * 2. **Ledger read** — a resident child's registered projection, otherwise a
 *    COLD restore over its stored log through the session query service
 *    (`readSession` + `sessionProjections.restore`: the framework's own
 *    checkpoint-plus-tail recipe). A freshly restarted process holds no live
 *    session at all, which is exactly the case where counting only resident
 *    children reported zero subagents for a conversation full of them.
 *
 * The runtime ownership walk over the live agent registry (`agents.isOwnedBy`
 * + `agents.list`) remains as a fallback for a deployment that mounts no
 * `subagents` service; entries it contributes carry `depth: -1` because the
 * runtime relation knows no root-relative distance.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/subagent-cost
 */

import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
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

/**
 * The subset of the sessionProjections service the aggregation needs: the live
 * read face plus the cold `restore` face when the registry exposes it.
 */
export interface SubagentProjectionsService {
  snapshot(session: Session): ProjectionSnapshot
  /**
   * Restore one projection cut from stored events without a live session.
   * @param checkpoint - persisted rows, or `{}` for a full fold.
   * @param events - stored events from `baseSeq`, in seq order.
   * @param baseSeq - the seq `events` starts at.
   * @param header - the stored session header.
   * @param inheritedEventCount - exact fork-inherited prefix length.
   * @returns the restored snapshot.
   */
  restore?(
    checkpoint: Record<string, unknown>,
    events: readonly SessionEvent[],
    baseSeq: unknown,
    header: SessionHeader,
    inheritedEventCount: unknown,
  ): { snapshot: ProjectionSnapshot }
}

/**
 * The subset of the sessionQuery service the aggregation needs to read one
 * stored subagent log. Only `readSession` is consulted; a deployment whose
 * query engine does not answer it simply has no cold-ledger source.
 */
export interface SubagentQueryService {
  readSession(sessionId: string): Promise<{ session: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }>
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
 * interface stays permissive at both ends.
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

/** One cold session's folded ledger, with the log watermark it describes. */
interface ColdLedger {
  /** Totals of the restored cut. */
  readonly totals: SessionCostTotals
  /** The restored cut's watermark (never read today; kept for diagnostics). */
  readonly asOfSeq: number
  /** Epoch millis when this fold was computed. */
  readonly at: number
}

/** How long a cold fold is reused before the persisted log is read again. */
const COLD_LEDGER_TTL_MS = 30_000
/** How many cold folds stay cached across requests. */
const COLD_LEDGER_CACHE_LIMIT = 256

/** Cross-request cold-ledger cache, keyed by session id, insertion-ordered. */
const coldLedgerCache = new Map<string, ColdLedger>()

/**
 * Drop every cached cold fold. The cache is process-global and keyed by
 * session id; tests (and any caller that knowingly replaced a session log)
 * use this instead of compensating with synthetic ids.
 */
export function resetColdLedgerCache(): void {
  coldLedgerCache.clear()
}

/**
 * Fold one stored subagent log into its ledger totals through the framework's
 * own cold-read recipe: an empty checkpoint at seq 0, every stored event, and
 * the exact inherited cut. Cached briefly so the route's poll cadence does not
 * refold unchanged logs.
 * @param sessionId - the subagent session to read.
 * @param query - the session query service.
 * @param projections - the projection registry (live + restore face).
 * @param projectionKey - the currency-specific ledger key.
 * @returns the restored totals, or undefined without a cold-read seam.
 */
async function readColdLedger(
  sessionId: string,
  query: SubagentQueryService | undefined,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd',
): Promise<SessionCostTotals | undefined> {
  if (query === undefined || typeof query.readSession !== 'function') return undefined
  if (typeof projections.restore !== 'function') return undefined

  const cached = coldLedgerCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < COLD_LEDGER_TTL_MS) return cached.totals

  const log = await query.readSession(sessionId)
  // The stored log starts at its own seq 0, so an empty checkpoint and
  // `baseSeq` 0 fold every registered unit from `init` across the whole log —
  // the exact same `apply` path a live session runs.
  const restored = projections.restore({}, log.events, 0, log.session, log.inheritedEventCount)
  const value = restored.snapshot.values[projectionKey] as { totals?: SessionCostTotals } | undefined
  const totals = value?.totals
  if (totals === undefined) return undefined

  coldLedgerCache.set(sessionId, { totals, asOfSeq: Number(restored.snapshot.asOfSeq), at: Date.now() })
  if (coldLedgerCache.size > COLD_LEDGER_CACHE_LIMIT) {
    const oldest = coldLedgerCache.keys().next()
    if (!oldest.done) coldLedgerCache.delete(oldest.value)
  }
  return totals
}

/** Resolve the ledger of one resident session, or undefined when it carries none. */
function liveTotalsOf(
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

/** Index the live session store by id, so the durable walk resolves rows cheaply. */
function liveSessionsById(sessions: SubagentSessionsService): Map<string, Session> {
  const index = new Map<string, Session>()
  for (const session of sessions.list()) {
    const id = String(session.id)
    if (!index.has(id)) index.set(id, session)
  }
  return index
}

/**
 * Fold the durable subagent tree into cost rows: the live ledger when the
 * child is resident, else its persisted-log restore. A `diagnostic` row names
 * no interpreted child and is skipped.
 * @param rootSessionId - the root conversation's session id.
 * @param subagents - the subagents service (durable tree enumeration).
 * @param sessions - the sessions service (live session store).
 * @param projections - the sessionProjections service.
 * @param projectionKey - the currency-specific ledger key.
 * @param query - the session query service (cold-ledger source), when mounted.
 * @returns one entry per descendant that has a ledger.
 * @throws whatever the listing throws; the caller decides the fallback.
 */
async function collectDurableSubagentCosts(
  rootSessionId: string,
  subagents: SubagentTreeService,
  sessions: SubagentSessionsService,
  projections: SubagentProjectionsService,
  projectionKey: 'sessionCost' | 'sessionCostUsd',
  query: SubagentQueryService | undefined,
): Promise<SubagentCost[]> {
  const entries = await subagents.listDescendants(rootSessionId)
  if (entries.length === 0) return []

  const live = liveSessionsById(sessions)
  const result: SubagentCost[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    // A `diagnostic` row names a candidate the product's listing could not
    // interpret; only interpreted children carry costs.
    if (entry.kind === 'diagnostic') continue
    const sessionId = String(entry.id)
    if (sessionId.length === 0 || sessionId === rootSessionId || seen.has(sessionId)) continue
    seen.add(sessionId)

    let totals = liveTotalsOf(live.get(sessionId), projections, projectionKey)
    if (totals === undefined) {
      try {
        totals = await readColdLedger(sessionId, query, projections, projectionKey)
      } catch {
        // One unreadable log (damaged, pruned, or a cancelled read) must not
        // hide the other children's costs.
        totals = undefined
      }
    }
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
      const totals = liveTotalsOf(sessions.get(candidateId), projections, projectionKey)
      if (totals === undefined) continue
      result.push({ sessionId: candidateId, depth: -1, totals })
    }
  }
  return result
}

/**
 * Collect every session-backed descendant of `rootSessionId` with its
 * anchored cost totals: the durable subagent tree first (nested, settled, and
 * cold children included — a resident child through its registered
 * projection, a stored one through the cold restore), then the live runtime
 * ownership walk for whatever the listing could not reach.
 * @param rootSessionId - the root conversation's session id.
 * @param agents - the agents service (live registry).
 * @param sessions - the sessions service (session store).
 * @param projections - the sessionProjections service.
 * @param projectionKey - the currency-specific ledger key.
 * @param subagents - the subagents service; omitted, only the runtime walk runs.
 * @param query - the session query service; omitted, cold children are skipped.
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
  query?: SubagentQueryService,
): Promise<SubagentCost[]> {
  let durable: SubagentCost[] = []
  if (subagents !== undefined) {
    try {
      durable = await collectDurableSubagentCosts(rootSessionId, subagents, sessions, projections, projectionKey, query)
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
