/**
 * The `sessionCost` projection unit: folds every usage-carrying event into an
 * immutable per-step ledger anchored to the price snapshot effective at the
 * event's own time.
 *
 * Anchoring contract (hard requirement): a step's cost, band, and snapshot
 * version are computed ONCE from the snapshot effective at the usage event's
 * `time` and then never recomputed. The state is plain JSON (the persisted
 * projection-cache precondition) and the fold is fully synchronous: the only
 * external read is the pricebook's in-memory mirror, which is immutable for
 * past times (snapshots are append-only). A later price change therefore
 * cannot rewrite an already-written row — the ledger grows, it never
 * mutates.
 *
 * A `request/context` event records the session's model; the usage event
 * (`assistant/message` with `usage`) prices that step with the recorded
 * model. A second usage sample for the same (turn, step) replaces the first
 * — same-step usage finalization, not a re-price: both samples anchor at
 * their own event times, and the final `assistant/message` sample is
 * authoritative. The totals subtract the replaced step and add the
 * replacement. DSH 0.1.5 absorbed the old `assistant/chunk` stream events
 * into the single `assistant/message` event (embedded `stream` + `usage`).
 *
 * Search / Fetch are standalone APIs billed per successful request, so the
 * same ledger also counts completed `web_search` / `web_fetch` tool calls
 * (top-level calls and PTC sub-calls) and folds their cost into the step that
 * issued them. Requests are counted even during the official grace period
 * (before 2026-11-01 00:00 Beijing) but priced at zero there.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/session-cost-projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { stepCost, type PricebookHandle, type StepUsage } from './pricebook.ts'
import type { SessionCostProjection, SessionCostStep, SessionCostTotals, UnpricedReason } from './types.ts'

/** One Search / Fetch tool invocation waiting for its result. */
interface PendingWebCall {
  turn: number
  step: number
  time: number
  kind: 'search' | 'fetch'
  requests: number
}

/** Ledger coordinates of one tool call (used to attribute PTC sub-calls). */
interface CallCoordinates {
  turn: number
  step: number
}

/** Internal fold state: model + the immutable per-step ledger + totals. */
export interface SessionCostState {
  /** Last model seen in a `request/context`. */
  model: { provider: string; model: string } | null
  /** Per-step ledger keyed `${turn}:${step}`. */
  steps: Record<string, SessionCostStep>
  /** Running totals (kept incrementally so replacements stay O(1)). */
  totals: SessionCostTotals
  /** Top-level web tool calls awaiting their `tool/result` event. */
  pendingWeb: Record<string, PendingWebCall>
  /** Tool-call coordinates by call id, for attributing PTC sub-calls. */
  callRoots: Record<string, CallCoordinates>
  /** Most recent (turn, step), the fallback when a PTC call has no root. */
  lastCoords: CallCoordinates | null
  /** Whether a web call has been observed after the official billing start. */
  webBillingStarted: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Fold state behind `sessionCost`. */
    sessionCost: SessionCostState
    /** Fold state behind `sessionCostUsd`. */
    sessionCostUsd: SessionCostState
  }
}

const zeroTotals = (): SessionCostTotals => ({
  uncachedCost: 0,
  cacheReadCost: 0,
  outputCost: 0,
  cost: 0,
  pricedSteps: 0,
  unpricedSteps: 0,
  steps: 0,
  webCost: 0,
  searchRequests: 0,
  fetchRequests: 0,
})

/** One ledger step, shared by the persisted state and the wire schemas. */
const stepSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  model: z.string(),
  provider: z.string().optional(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  uncachedCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(),
  outputCost: z.number().nonnegative(),
  cost: z.number().nonnegative().nullable(),
  priced: z.boolean(),
  unpricedReason: z.enum(['NO_MODEL', 'NO_PRICE']).optional(),
  snapshotVersion: z.number().int().nonnegative().nullable(),
  snapshotEffectiveAt: z.number().int().nonnegative().nullable(),
  band: z.enum(['peak', 'offPeak', 'single']).nullable(),
  webCost: z.number().nonnegative().optional(),
  searchRequests: z.number().int().nonnegative().optional(),
  fetchRequests: z.number().int().nonnegative().optional(),
}).strict()

const totalsSchema = z.object({
  uncachedCost: z.number().nonnegative(),
  cacheReadCost: z.number().nonnegative(),
  outputCost: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  pricedSteps: z.number().int().nonnegative(),
  unpricedSteps: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  webCost: z.number().nonnegative().optional(),
  searchRequests: z.number().int().nonnegative().optional(),
  fetchRequests: z.number().int().nonnegative().optional(),
}).strict()

const modelSchema = z.object({ provider: z.string(), model: z.string() }).nullable()
const coordinatesSchema = z.object({ turn: z.number().int().nonnegative(), step: z.number().int().nonnegative() }).strict()
const pendingWebSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  kind: z.enum(['search', 'fetch']),
  requests: z.number().int().nonnegative(),
}).strict()

/** Persisted fold-state schema (`stateSchema` in the projection definition). */
const projectionStateSchema = z.object({
  model: modelSchema,
  steps: z.record(z.string(), stepSchema),
  totals: totalsSchema,
  pendingWeb: z.record(z.string(), pendingWebSchema).default({}),
  callRoots: z.record(z.string(), coordinatesSchema).default({}),
  lastCoords: coordinatesSchema.nullable().default(null),
  webBillingStarted: z.boolean().default(false),
}).strict()

/** Wire schema of the projection value (`wire.viewSchema`). */
const webSummarySchema = z.object({
  searchRequests: z.number().int().nonnegative(),
  fetchRequests: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  billingStarted: z.boolean(),
}).strict()

const projectionSchema = z.object({
  model: modelSchema,
  steps: z.array(stepSchema),
  totals: totalsSchema,
  web: webSummarySchema.optional(),
}).strict()

/** Wire usage shape (subset of `TokenUsage`) the fold prices. */
interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Extract the disjoint token buckets from a wire usage object. */
export function usageBuckets(usage: UsageLike): StepUsage {
  return {
    uncached: usage.inputTokens,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens,
  }
}

function bucketsEmpty(usage: StepUsage): boolean {
  return usage.uncached === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0 && usage.output === 0
}

/** Replace totals with one step, subtracting its predecessor when present. */
function replaceTotals(totals: SessionCostTotals, step: SessionCostStep, previous: SessionCostStep | undefined): SessionCostTotals {
  const subtract = (value: number): number => (previous === undefined ? 0 : value)
  return {
    uncachedCost: totals.uncachedCost - subtract(previous?.uncachedCost ?? 0) + step.uncachedCost,
    cacheReadCost: totals.cacheReadCost - subtract(previous?.cacheReadCost ?? 0) + step.cacheReadCost,
    outputCost: totals.outputCost - subtract(previous?.outputCost ?? 0) + step.outputCost,
    cost: totals.cost - subtract(previous?.cost ?? 0) + (step.cost ?? 0),
    pricedSteps: totals.pricedSteps - (previous?.priced === true ? 1 : 0) + (step.priced ? 1 : 0),
    unpricedSteps: totals.unpricedSteps - (previous?.priced === false ? 1 : 0) + (step.priced ? 0 : 1),
    steps: totals.steps - (previous === undefined ? 0 : 1) + 1,
    webCost: (totals.webCost ?? 0) - subtract(previous?.webCost ?? 0) + (step.webCost ?? 0),
    searchRequests: (totals.searchRequests ?? 0) - subtract(previous?.searchRequests ?? 0) + (step.searchRequests ?? 0),
    fetchRequests: (totals.fetchRequests ?? 0) - subtract(previous?.fetchRequests ?? 0) + (step.fetchRequests ?? 0),
  }
}

function sameStep(left: SessionCostStep, right: SessionCostStep): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.outputTokens === right.outputTokens
    && left.cost === right.cost
    && left.snapshotVersion === right.snapshotVersion
    && left.band === right.band
    && (left.webCost ?? 0) === (right.webCost ?? 0)
    && (left.searchRequests ?? 0) === (right.searchRequests ?? 0)
    && (left.fetchRequests ?? 0) === (right.fetchRequests ?? 0)
}

/** Coordinates carried by an event, when it has them. */
function coordinatesOf(event: SessionEvent): CallCoordinates | null {
  const data = event.data as { turn?: unknown; step?: unknown }
  return typeof data.turn === 'number' && typeof data.step === 'number'
    ? { turn: data.turn, step: data.step }
    : null
}

/** Parse tool arguments from either a JSON string (tool/call) or an object (PTC). */
function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** The number of billable Search requests one `web_search` call issues. */
function searchRequestsOf(args: Record<string, unknown>): number {
  const queries = Array.isArray(args.queries) ? args.queries : []
  const unique = new Set(queries.filter((query): query is string => typeof query === 'string' && query.trim().length > 0))
  return unique.size
}

/**
 * A completed web call's billable request count. Only `web_search` is billed:
 * the shipped web profile serves `web_fetch` through the local
 * `dsh-web-fetch-http` provider, which DeepSeek does not charge for. Fetch API
 * prices remain in the pricebook for deployments that route fetches through
 * DeepSeek, but no tool event identifies that route, so charging every fetch
 * would overbill the common local-fetch profile.
 */
function webRequestsOf(name: unknown, args: Record<string, unknown>): { kind: 'search'; requests: number } | null {
  if (name === 'web_search') return { kind: 'search', requests: searchRequestsOf(args) }
  return null
}

/** A zero-token step, used when a web call has no assistant usage row yet. */
function emptyStep(state: SessionCostState, time: number, turn: number, step: number): SessionCostStep {
  const model = state.model
  return {
    turn,
    step,
    time,
    model: model?.model ?? 'unknown',
    ...(model?.provider === undefined ? {} : { provider: model.provider }),
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    uncachedCost: 0,
    cacheReadCost: 0,
    outputCost: 0,
    cost: null,
    priced: false,
    ...(model === null ? { unpricedReason: 'NO_MODEL' as const } : { unpricedReason: 'NO_PRICE' as const }),
    snapshotVersion: null,
    snapshotEffectiveAt: null,
    band: null,
    webCost: 0,
    searchRequests: 0,
    fetchRequests: 0,
  }
}

/**
 * Fold one completed Search / Fetch call into the step that issued it. The
 * per-request price is anchored at the call's own time; during the official
 * grace period the requests are recorded with zero cost.
 * @returns the next state, or the same reference when nothing is billable.
 */
function addWebCall(state: SessionCostState, call: PendingWebCall, success: boolean, pricebook: PricebookHandle): SessionCostState {
  if (!success || call.requests === 0) return state
  const hit = pricebook.webPriceFor(call.time)
  const perThousand = call.kind === 'search' ? hit.searchPerThousand : hit.fetchPerThousand
  const cost = hit.billingStarted ? call.requests * perThousand / 1_000 : 0
  const key = `${call.turn}:${call.step}`
  const previous = state.steps[key] ?? emptyStep(state, call.time, call.turn, call.step)
  const nextCost = previous.cost === null && cost === 0 ? null : (previous.cost ?? 0) + cost
  const priced = previous.priced || cost > 0
  const record: SessionCostStep = {
    ...previous,
    webCost: (previous.webCost ?? 0) + cost,
    ...(call.kind === 'search'
      ? { searchRequests: (previous.searchRequests ?? 0) + call.requests }
      : { fetchRequests: (previous.fetchRequests ?? 0) + call.requests }),
    cost: nextCost,
    priced,
    ...(priced ? {} : { unpricedReason: previous.unpricedReason }),
    snapshotVersion: previous.snapshotVersion ?? hit.snapshotVersion,
    snapshotEffectiveAt: previous.snapshotEffectiveAt ?? hit.snapshotEffectiveAt,
  }
  if (sameStep(previous, record)) return state
  return {
    ...state,
    steps: { ...state.steps, [key]: record },
    totals: replaceTotals(state.totals, record, state.steps[key]),
    webBillingStarted: state.webBillingStarted || hit.billingStarted,
  }
}

/**
 * Fold one committed event onto the ledger. Pure except for synchronous
 * pricebook mirror reads; returns the same state reference for events the
 * unit does not own (the framework's zero-work contract).
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @param pricebook - the pricebook read face.
 * @returns the next state.
 */
export function foldSessionCost(
  state: SessionCostState,
  event: SessionEvent,
  pricebook: PricebookHandle,
): SessionCostState {
  const type = event.type as string
  if (type === 'request/context') {
    const context = event.data as { provider: string; model: string }
    const model = { provider: context.provider, model: context.model }
    if (state.model !== null && state.model.provider === model.provider && state.model.model === model.model) return state
    return { ...state, model }
  }

  const coords = coordinatesOf(event)
  // Tool-call bookkeeping: remember where each root call was issued so PTC
  // sub-calls can be attributed, and hold web calls until their result says
  // whether the request succeeded.
  if (type === 'tool/call') {
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown }
    if (coords === null || typeof data.callId !== 'string') return state
    const callRoots = { ...state.callRoots, [data.callId]: coords }
    const pendingWeb = { ...state.pendingWeb }
    const web = webRequestsOf(data.name, parseArguments(data.arguments))
    if (web !== null && web.requests > 0) {
      pendingWeb[data.callId] = { ...coords, time: event.time, ...web }
    }
    return { ...state, callRoots, pendingWeb, lastCoords: coords }
  }

  if (type === 'tool/result') {
    const data = event.data as { message?: { toolCallId?: unknown; isError?: unknown } }
    const callId = data.message?.toolCallId
    if (typeof callId !== 'string') return state
    const pending = state.pendingWeb[callId]
    const callRoots = { ...(state.callRoots ?? {}) }
    const pendingWeb = { ...(state.pendingWeb ?? {}) }
    delete callRoots[callId]
    delete pendingWeb[callId]
    const next = pending === undefined
      ? state
      : addWebCall(state, pending, data.message?.isError !== true, pricebook)
    return { ...next, callRoots, pendingWeb, lastCoords: coords ?? next.lastCoords ?? null }
  }

  if (type === 'tool/ptc-dispatch') {
    // `tool/ptc-dispatch` exists in DSH 0.2.1 but is absent from the 0.2.0
    // SessionEvent union this package still typechecks against.
    const data = (event as unknown as { data: { rootCallId?: unknown; parentCallId?: unknown; name?: unknown; arguments?: unknown; isError?: unknown; turn?: number; step?: number } }).data
    const web = webRequestsOf(data.name, parseArguments(data.arguments))
    if (web === null || web.requests === 0) return state
    const root = typeof data.rootCallId === 'string' ? state.callRoots[data.rootCallId] : undefined
    const parent = typeof data.parentCallId === 'string' ? state.callRoots[data.parentCallId] : undefined
    const at = root ?? parent ?? state.lastCoords ?? { turn: 0, step: 0 }
    return addWebCall(state, { ...at, time: event.time, ...web }, data.isError !== true, pricebook)
  }

  let turn: number
  let step: number
  let usage: UsageLike
  const message = event.data as { turn?: unknown; step?: unknown; usage?: UsageLike }
  if (type === 'assistant/message' && message.usage !== undefined
    && typeof message.turn === 'number' && typeof message.step === 'number') {
    turn = message.turn
    step = message.step
    usage = message.usage
  } else {
    return state
  }

  const buckets = usageBuckets(usage)
  if (bucketsEmpty(buckets)) return state

  const key = `${turn}:${step}`
  const previous = state.steps[key]
  const model = state.model
  const hit = model === null ? null : pricebook.priceFor(model.provider, model.model, event.time)
  const unpricedReason: UnpricedReason | undefined = hit === null
    ? (model === null ? 'NO_MODEL' : 'NO_PRICE')
    : undefined

  const uncachedCost = hit === null ? 0 : (buckets.uncached + buckets.cacheWrite) * hit.bucket.inputPerMillion / 1_000_000
  const cacheReadCost = hit === null ? 0 : buckets.cacheRead * hit.bucket.cacheReadPerMillion / 1_000_000
  const outputCost = hit === null ? 0 : buckets.output * hit.bucket.outputPerMillion / 1_000_000
  const tokenCost = hit === null ? null : uncachedCost + cacheReadCost + outputCost
  const webCost = previous?.webCost ?? 0

  const record: SessionCostStep = {
    turn,
    step,
    time: event.time,
    model: model?.model ?? 'unknown',
    ...(model?.provider === undefined ? {} : { provider: model.provider }),
    uncachedInputTokens: buckets.uncached,
    cacheReadTokens: buckets.cacheRead,
    cacheWriteTokens: buckets.cacheWrite,
    outputTokens: buckets.output,
    uncachedCost,
    cacheReadCost,
    outputCost,
    cost: tokenCost === null && webCost === 0 ? null : (tokenCost ?? 0) + webCost,
    priced: hit !== null || webCost > 0,
    ...(tokenCost === null && webCost === 0 && unpricedReason !== undefined ? { unpricedReason } : {}),
    snapshotVersion: hit?.snapshotVersion ?? previous?.snapshotVersion ?? null,
    snapshotEffectiveAt: hit?.snapshotEffectiveAt ?? previous?.snapshotEffectiveAt ?? null,
    band: hit?.band ?? previous?.band ?? null,
    ...(webCost === 0 ? {} : { webCost }),
    ...(previous?.searchRequests === undefined ? {} : { searchRequests: previous.searchRequests }),
    ...(previous?.fetchRequests === undefined ? {} : { fetchRequests: previous.fetchRequests }),
  }

  if (previous !== undefined && sameStep(previous, record)) return state
  return {
    ...state,
    steps: { ...state.steps, [key]: record },
    totals: replaceTotals(state.totals, record, previous),
    lastCoords: coords ?? state.lastCoords ?? null,
  }
}

/** State → wire payload: steps ordered by turn then step. */
export function viewSessionCost(state: SessionCostState): SessionCostProjection {
  const steps = Object.values(state.steps).sort((left, right) => left.turn - right.turn || left.step - right.step)
  return {
    model: state.model,
    steps,
    totals: state.totals,
    web: {
      searchRequests: state.totals.searchRequests ?? 0,
      fetchRequests: state.totals.fetchRequests ?? 0,
      cost: state.totals.webCost ?? 0,
      billingStarted: state.webBillingStarted ?? false,
    },
  }
}

/**
 * The projection unit. The fold reads the pricebook mirror synchronously;
 * the unit never touches the domain itself.
 * @param pricebook - the pricebook read face (in-memory mirror).
 * @returns the definition to register with `ctx.sessionProjections`.
 */
export function sessionCostProjection<K extends 'sessionCost' | 'sessionCostUsd'>(
  pricebook: PricebookHandle,
  key: K,
): {
  key: K
  stateSchema: typeof projectionStateSchema
  init: () => SessionCostState
  apply: (state: SessionCostState, event: SessionEvent) => SessionCostState
  wire: {
    viewSchema: typeof projectionSchema
    view: (state: SessionCostState) => SessionCostProjection
  }
  stateVersion: number
} {
  return {
    key,
    stateSchema: projectionStateSchema,
    init: () => ({
      model: null,
      steps: {},
      totals: zeroTotals(),
      pendingWeb: {},
      callRoots: {},
      lastCoords: null,
      webBillingStarted: false,
    }),
    apply: (state, event) => foldSessionCost(state, event, pricebook),
    wire: {
      viewSchema: projectionSchema,
      view: viewSessionCost,
    },
    stateVersion: 2,
  }
}