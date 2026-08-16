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
 * A `request/header` event records the session's model; the usage events
 * (`assistant/chunk` with `chunk.type === 'usage'`, and `assistant/message`
 * with `usage`) price that step with the recorded model. A second usage
 * sample for the same (turn, step) replaces the first — same-step usage
 * finalization, not a re-price: both samples anchor at their own event
 * times, and the final `assistant/message` sample is authoritative. The
 * totals subtract the replaced step and add the replacement.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/session-cost-projection
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { stepCost, type PricebookHandle, type StepUsage } from './pricebook.ts'
import type { SessionCostProjection, SessionCostStep, SessionCostTotals, UnpricedReason } from './types.ts'

/** Internal fold state: model + the immutable per-step ledger + totals. */
export interface SessionCostState {
  /** Last model seen in a `request/header`. */
  model: { provider: string; model: string } | null
  /** Per-step ledger keyed `${turn}:${step}`. */
  steps: Record<string, SessionCostStep>
  /** Running totals (kept incrementally so replacements stay O(1)). */
  totals: SessionCostTotals
}

const zeroTotals = (): SessionCostTotals => ({
  uncachedCost: 0,
  cacheReadCost: 0,
  outputCost: 0,
  cost: 0,
  pricedSteps: 0,
  unpricedSteps: 0,
  steps: 0,
})

/** Wire schema of the projection value (validated before it leaves the host). */
const projectionSchema = z.object({
  model: z.object({ provider: z.string(), model: z.string() }).nullable(),
  steps: z.array(z.object({
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
    cost: z.number().nullable(),
    priced: z.boolean(),
    unpricedReason: z.enum(['NO_MODEL', 'NO_PRICE']).optional(),
    snapshotVersion: z.number().int().nonnegative().nullable(),
    snapshotEffectiveAt: z.number().int().nonnegative().nullable(),
    band: z.enum(['peak', 'offPeak', 'single']).nullable(),
  }).strict()),
  totals: z.object({
    uncachedCost: z.number().nonnegative(),
    cacheReadCost: z.number().nonnegative(),
    outputCost: z.number().nonnegative(),
    cost: z.number().nonnegative(),
    pricedSteps: z.number().int().nonnegative(),
    unpricedSteps: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
  }).strict(),
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
  const next: SessionCostTotals = {
    uncachedCost: totals.uncachedCost - subtract(previous?.uncachedCost ?? 0) + step.uncachedCost,
    cacheReadCost: totals.cacheReadCost - subtract(previous?.cacheReadCost ?? 0) + step.cacheReadCost,
    outputCost: totals.outputCost - subtract(previous?.outputCost ?? 0) + step.outputCost,
    cost: totals.cost - subtract(previous?.cost ?? 0) + (step.cost ?? 0),
    pricedSteps: totals.pricedSteps - (previous?.priced === true ? 1 : 0) + (step.priced ? 1 : 0),
    unpricedSteps: totals.unpricedSteps - (previous?.priced === false ? 1 : 0) + (step.priced ? 0 : 1),
    steps: totals.steps - (previous === undefined ? 0 : 1) + 1,
  }
  return next
}

function sameStep(left: SessionCostStep, right: SessionCostStep): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.outputTokens === right.outputTokens
    && left.cost === right.cost
    && left.snapshotVersion === right.snapshotVersion
    && left.band === right.band
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
  if (event.type === 'request/header') {
    const header = canonicalHeader(event.data.header)
    const model = { provider: header.config.provider, model: header.config.model }
    if (state.model !== null && state.model.provider === model.provider && state.model.model === model.model) return state
    return { ...state, model }
  }

  let turn: number
  let step: number
  let usage: UsageLike
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    turn = event.data.turn
    step = event.data.step
    usage = event.data.chunk.usage
  } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    turn = event.data.turn
    step = event.data.step
    usage = event.data.usage
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
    cost: hit === null ? null : uncachedCost + cacheReadCost + outputCost,
    priced: hit !== null,
    ...(unpricedReason === undefined ? {} : { unpricedReason }),
    snapshotVersion: hit?.snapshotVersion ?? null,
    snapshotEffectiveAt: hit?.snapshotEffectiveAt ?? null,
    band: hit?.band ?? null,
  }

  if (previous !== undefined && sameStep(previous, record)) return state
  return {
    ...state,
    steps: { ...state.steps, [key]: record },
    totals: replaceTotals(state.totals, record, previous),
  }
}

/** State → wire payload: steps ordered by turn then step. */
export function viewSessionCost(state: SessionCostState): SessionCostProjection {
  const steps = Object.values(state.steps).sort((left, right) => left.turn - right.turn || left.step - right.step)
  return { model: state.model, steps, totals: state.totals }
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
): ProjectionDefinition<K, SessionCostState> {
  return {
    key,
    schema: projectionSchema,
    init: () => ({ model: null, steps: {}, totals: zeroTotals() }),
    apply: (state, event) => foldSessionCost(state, event, pricebook),
    view: viewSessionCost,
    stateVersion: 1,
  }
}
