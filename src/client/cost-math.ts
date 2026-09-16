/**
 * Client-side price lookup and streaming-estimate helpers.
 *
 * The authoritative anchored ledger arrives through the `sessionCost`
 * projection; this module only mirrors the host pricebook math for display
 * and for the live estimate (which by nature uses CURRENT prices and is
 * labeled 估算/estimate). The lookup logic intentionally mirrors
 * `src/pricebook.ts` — keep the two in sync.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/client/cost-math
 */

import { isPeakHour, PEAK_PRICING_START_MS, PEAK_SCHEDULE_ZH } from '../pricing.ts'
import type {
  ModelPrice,
  PeakSchedule,
  PriceBand,
  PriceBucket,
  PricebookSnapshot,
  SessionCostStep,
  SessionCostTotals,
  SubagentCost,
} from '../types.ts'

/** Sum totals (this module's mirror of the host `sumTotals`). */
export function sumTotals(totals: readonly SessionCostTotals[]): SessionCostTotals {
  const sum: SessionCostTotals = {
    uncachedCost: 0,
    cacheReadCost: 0,
    outputCost: 0,
    cost: 0,
    pricedSteps: 0,
    unpricedSteps: 0,
    steps: 0,
  }
  for (const entry of totals) {
    sum.uncachedCost += entry.uncachedCost
    sum.cacheReadCost += entry.cacheReadCost
    sum.outputCost += entry.outputCost
    sum.cost += entry.cost
    sum.pricedSteps += entry.pricedSteps
    sum.unpricedSteps += entry.unpricedSteps
    sum.steps += entry.steps
  }
  return sum
}

/** Total spend of every subagent (CNY); 0 without subagents. */
export function subagentSpend(subagents: readonly SubagentCost[] | undefined): number {
  if (subagents === undefined || subagents.length === 0) return 0
  return sumTotals(subagents.map(entry => entry.totals)).cost
}

/**
 * Select the conversation's main ledger, the host-aggregated subagent rows,
 * and their combined totals together, so no surface has to remember which
 * pointer to compare against which total.
 *
 * All three are derived consistently: `combined` sums the main ledger with
 * EVERY subagent row the host served — including nested ones — and is defined
 * whenever either side has data. A conversation whose own ledger is not
 * materialized yet (a session switch mid-flight, or a host that serves no main
 * ledger) therefore still totals its subagents instead of rendering nothing.
 *
 * `main` is `null` when the main ledger is absent, in which case `mainSpend`
 * is unknown (the dock shows 0 for a session with no spend of its own).
 * @param main - the main session's projection totals, or undefined.
 * @param subagents - the host-aggregated subagent rows.
 * @returns the main readout, the subagent rows, combined totals, and both spend figures.
 */
export function costLookupFor(
  main: SessionCostTotals | undefined,
  subagents: readonly SubagentCost[] | undefined,
): {
  main: SessionCostTotals | undefined
  subagents: readonly SubagentCost[]
  combined: SessionCostTotals | undefined
  mainSpend: number
  subagentTotal: number
} {
  const rows = subagents ?? []
  const combined = combineTotals(main, rows)
  return {
    main,
    subagents: rows,
    combined,
    mainSpend: main?.cost ?? 0,
    subagentTotal: sumTotals(rows.map(entry => entry.totals)).cost,
  }
}

/**
 * The conversation-wide totals: the main session's ledger plus every
 * subagent's ledger (host-aggregated, all nesting levels). Undefined only when
 * neither side carries a ledger.
 * @param main - the main session's projection totals.
 * @param subagents - the host-aggregated subagent totals.
 * @returns the combined totals, or undefined without any ledger.
 */
export function combineTotals(
  main: SessionCostTotals | undefined,
  subagents: readonly SubagentCost[] | undefined,
): SessionCostTotals | undefined {
  const rows = subagents ?? []
  if (main === undefined) {
    return rows.length === 0 ? undefined : sumTotals(rows.map(entry => entry.totals))
  }
  if (rows.length === 0) return main
  return sumTotals([main, ...rows.map(entry => entry.totals)])
}

/**
 * The price band in effect at one instant (mirror of the host helper). The
 * schedule defaults to the zh fallback; live readouts pass the schedule of
 * the pricebook they display (the zh and en pages may state different
 * windows).
 * @param time - epoch millis.
 * @param schedule - the peak-hour schedule to classify against.
 * @returns the band.
 */
export function bandForTime(time: number, schedule: PeakSchedule = PEAK_SCHEDULE_ZH): PriceBand {
  if (time < PEAK_PRICING_START_MS) return 'single'
  return isPeakHour(new Date(time), schedule) ? 'peak' : 'offPeak'
}

/** The bucket of one model's entry for one band (mirror of the host helper). */
export function bucketOf(modelPrice: ModelPrice, band: PriceBand): PriceBucket | undefined {
  if (band === 'single') return modelPrice.single ?? modelPrice.offPeak ?? modelPrice.peak
  if (band === 'peak') return modelPrice.peak ?? modelPrice.offPeak ?? modelPrice.single
  return modelPrice.offPeak ?? modelPrice.peak ?? modelPrice.single
}

/** Map a model id to its official pricing key (mirror of the host helper). */
export function pricingKeyOfModel(model: string): 'pro' | 'flash' {
  const lower = model.toLowerCase()
  return lower.includes('pro') ? 'pro' : 'flash'
}

/** Candidate canonical price keys for one model (mirror of the host helper). */
export function modelKeys(provider: string | undefined, model: string): string[] {
  const keys: string[] = []
  if (provider !== undefined && provider.length > 0) keys.push(`${provider}/${model}`)
  keys.push(model)
  const lower = model.toLowerCase()
  const deepseekish = lower.includes('deepseek')
    || (provider !== undefined && provider.toLowerCase().includes('deepseek'))
  if (deepseekish) keys.push(pricingKeyOfModel(model))
  return keys
}

/** Pick the snapshot effective at `time` (newest ≤ time, else earliest). */
export function snapshotAt(snapshots: readonly PricebookSnapshot[], time: number): PricebookSnapshot | undefined {
  let best: PricebookSnapshot | undefined
  for (const snapshot of snapshots) {
    // `>=` keeps the NEWER snapshot (later in the array) on an effectiveAt tie.
    if (snapshot.effectiveAt <= time && (best === undefined || snapshot.effectiveAt >= best.effectiveAt)) best = snapshot
  }
  return best ?? (snapshots.length > 0 ? snapshots[0] : undefined)
}

/** Resolve one model's price entry in a snapshot through the key chain. */
export function modelPriceOf(
  snapshot: PricebookSnapshot | null | undefined,
  provider: string | undefined,
  model: string,
): ModelPrice | undefined {
  if (snapshot === undefined || snapshot === null) return undefined
  for (const key of modelKeys(provider, model)) {
    const entry = snapshot.prices[key]
    if (entry !== undefined) return entry
  }
  return undefined
}

/** Resolve one model's bucket at one instant from a snapshot. */
export function bucketAt(
  snapshot: PricebookSnapshot | undefined,
  provider: string | undefined,
  model: string,
  time: number,
  schedule: PeakSchedule = PEAK_SCHEDULE_ZH,
): PriceBucket | undefined {
  const entry = modelPriceOf(snapshot, provider, model)
  if (entry === undefined) return undefined
  return bucketOf(entry, bandForTime(time, schedule))
}

/**
 * The peak-to-off-peak price multiplier for one model's entry, when the
 * entry carries both bands. The multiplier is the ratio of the summed peak
 * bucket rates to the summed off-peak bucket rates; official DeepSeek prices
 * scale all buckets by the same factor, so this is a stable “peak is N× the
 * off-peak price” display value.
 * @param snapshot - the pricebook snapshot to read.
 * @param provider - the provider route, when known.
 * @param model - the model id.
 * @returns the peak/off-peak multiplier, or null when either band is absent.
 */
export function peakOffPeakMultiplier(
  snapshot: PricebookSnapshot | null | undefined,
  provider: string | undefined,
  model: string,
): number | null {
  const entry = modelPriceOf(snapshot, provider, model)
  if (entry === undefined) return null
  const peak = entry.peak
  const offPeak = entry.offPeak
  if (peak === undefined || offPeak === undefined) return null
  const offPeakTotal = offPeak.cacheReadPerMillion + offPeak.inputPerMillion + offPeak.outputPerMillion
  if (offPeakTotal === 0) return null
  const peakTotal = peak.cacheReadPerMillion + peak.inputPerMillion + peak.outputPerMillion
  return peakTotal / offPeakTotal
}

/** CJK characters (the /1.5 density class). */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g

/**
 * Heuristic character→token estimate: CJK ÷ 1.5, everything else ÷ 4
 * (the streaming estimate's output side).
 * @param text - the accumulated text.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4)
}

/**
 * Tokens of the streamed text/reasoning blocks of a partial assistant.
 * @param blocks - the partial's content blocks (text/reasoning carry `text`).
 * @returns the estimated token count.
 */
export function blocksOutputTokens(blocks: readonly { kind?: string; text?: string }[] | undefined): number {
  let tokens = 0
  for (const block of blocks ?? []) {
    if ((block.kind === 'text' || block.kind === 'reasoning') && typeof block.text === 'string' && block.text.length > 0) {
      tokens += estimateTokens(block.text)
    }
  }
  return tokens
}

/**
 * The cache-read ratio of the newest completed step (input side of the
 * estimate). Absent history conservatively prices all input as uncached
 * (upper bound).
 * @param steps - the projection's step ledger.
 * @returns the ratio in [0, 1].
 */
export function cacheReadRatioOf(steps: readonly SessionCostStep[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    const total = step.uncachedInputTokens + step.cacheReadTokens + step.cacheWriteTokens
    if (step.priced && total > 0) return step.cacheReadTokens / total
  }
  return 0
}

/**
 * The live estimate of the running reply: input at the projected context
 * size (weighted by the cache ratio) plus output at the streamed-token
 * heuristic, both at CURRENT prices. Always labeled 估算/estimate — it is
 * replaced by the projection's exact anchored value once the step settles.
 * @param bucket - the current price bucket of the session model.
 * @param inputTokens - the projected prompt size for the next request.
 * @param cachedRatio - the cache-read ratio from recent completed steps.
 * @param outputTokens - the streamed output tokens so far.
 * @returns the estimated CNY cost.
 */
export function estimateCost(
  bucket: PriceBucket,
  inputTokens: number,
  cachedRatio: number,
  outputTokens: number,
): number {
  const inputCost = inputTokens / 1_000_000
    * (bucket.cacheReadPerMillion * cachedRatio + bucket.inputPerMillion * (1 - cachedRatio))
  const outputCost = outputTokens / 1_000_000 * bucket.outputPerMillion
  return inputCost + outputCost
}
