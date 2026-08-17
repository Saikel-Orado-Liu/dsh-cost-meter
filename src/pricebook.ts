/**
 * The pricebook: the durable price source with append-only snapshot history.
 *
 * Every model resolves its price through a fixed priority chain — manual
 * override > official pricing page > built-in fallback > OpenRouter (fallback
 * only, USD→CNY) > none. Any change to the resolved per-model table starts a
 * new immutable {@link PricebookSnapshot} (monotonic `version`); every
 * session-cost fold anchors to the snapshot effective at the priced event's
 * own time, so a later price change never rewrites an already-written row.
 *
 * The pricebook state persists on the `pricebook` storage domain (global
 * slot): snapshot history plus the editable configuration (overrides,
 * aliases, cache-read discount, exchange rate, toggles). The in-memory
 * mirror is the synchronous read face for the projection fold; the domain
 * write is a queued, fail-soft side effect.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/pricebook
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { FALLBACK_CURRENT, FALLBACK_CURRENT_USD, FALLBACK_PEAK, FALLBACK_PEAK_USD, fetchPricing, isPeakHour, PEAK_PRICING_START_MS, PEAK_SCHEDULE_EN, PEAK_SCHEDULE_ZH } from './pricing.ts'
import type {
  Currency,
  CurrentPricing,
  FxConfig,
  ModelPrice,
  PeakPricing,
  PeakSchedule,
  PriceBand,
  PricebookSnapshot,
  PricebookState,
  PricebookView,
  PriceBucket,
  PriceSource,
  PricingSnapshot,
} from './types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Defaults and well-known sources
// ─────────────────────────────────────────────────────────────────────────────

/** Default manual rate used when auto-fetch fails and nothing was ever fetched. */
export const DEFAULT_FX_RATE = 7.2
/** Default OpenRouter cache-read fraction of the uncached input price. */
export const DEFAULT_CACHE_READ_DISCOUNT = 0.25
/** Default OpenRouter model-id → canonical key aliases (editable). */
export const DEFAULT_ALIASES: Record<string, string> = {
  'deepseek/deepseek-chat': 'deepseek-v4-flash',
  'deepseek/deepseek-reasoner': 'deepseek-v4-pro',
}
/** Free exchange-rate endpoint (no key); returns `rates.CNY` for USD base. */
export const FX_API_URL = 'https://open.er-api.com/v6/latest/USD'
/** OpenRouter models directory (prices in USD per token). */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** Default cap on the persisted snapshot history. */
export const DEFAULT_SNAPSHOT_HISTORY_LIMIT = 50

// ─────────────────────────────────────────────────────────────────────────────
// Domain declaration
// ─────────────────────────────────────────────────────────────────────────────

const bucketSchema = z.object({
  cacheReadPerMillion: z.number().nonnegative(),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
}).strict()

const modelPriceSchema = z.object({
  source: z.enum(['manual', 'official', 'fallback', 'openrouter', 'none']),
  single: bucketSchema.optional(),
  offPeak: bucketSchema.optional(),
  peak: bucketSchema.optional(),
}).strict()

const snapshotSchema = z.object({
  version: z.number().int().positive(),
  currency: z.enum(['CNY', 'USD']).default('CNY'),
  effectiveAt: z.number().int().nonnegative(),
  source: z.enum(['manual', 'official', 'fallback', 'openrouter', 'none']),
  usdCnyRate: z.number().nullable(),
  prices: z.record(z.string(), modelPriceSchema),
}).strict()

const fxSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  manualRate: z.number().positive(),
  lastAutoRate: z.number().positive().optional(),
  rateFetchedAt: z.number().int().nonnegative().optional(),
}).strict()

const pricebookStateSchema = z.object({
  snapshots: z.array(snapshotSchema),
  overrides: z.record(z.string(), modelPriceSchema),
  aliases: z.record(z.string(), z.string()),
  cacheReadDiscount: z.number().min(0).max(1),
  fx: fxSchema,
  balanceEnabled: z.boolean(),
  openRouterEnabled: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** Fresh pricebook state before any user configuration exists. */
export function initialPricebookState(): PricebookState {
  return {
    snapshots: [],
    overrides: {},
    aliases: { ...DEFAULT_ALIASES },
    cacheReadDiscount: DEFAULT_CACHE_READ_DISCOUNT,
    fx: { mode: 'auto', manualRate: DEFAULT_FX_RATE },
    balanceEnabled: true,
    openRouterEnabled: true,
    updatedAt: 0,
  }
}

/**
 * The pricebook storage domain. One global slot holds the whole state; the
 * domain name (`pricebook`) is unused by any shipped row, so the open never
 * collides with `already-open`.
 */
export const PRICEBOOK_DOMAIN = defineDomain({
  name: 'pricebook',
  version: 1,
  global: { schema: pricebookStateSchema, initial: initialPricebookState() },
  tables: {},
})

/** USD pricebook storage domain, kept separate from the CNY domain. */
export const PRICEBOOK_DOMAIN_USD = defineDomain({
  name: 'pricebook_usd',
  version: 1,
  global: { schema: pricebookStateSchema, initial: initialPricebookState() },
  tables: {},
})

// ─────────────────────────────────────────────────────────────────────────────
// Model key resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a model id to its official pricing key: anything containing `pro`
 * prices as pro, `flash` as flash. Mirror of the client-side helper.
 * @param model - the model id.
 * @returns the pricing key.
 */
export function pricingKeyOfModel(model: string): 'pro' | 'flash' {
  const lower = model.toLowerCase()
  return lower.includes('pro') ? 'pro' : 'flash'
}

/**
 * Candidate canonical price keys for one model, most specific first. The
 * pricing-key fallbacks (`pro`/`flash`) only apply to DeepSeek-family models
 * (id or provider names deepseek): an unrelated model must NOT silently pick
 * up the flash list price — it either resolves through an override, an
 * OpenRouter alias, or stays unpriced.
 * @param provider - the provider route, when known.
 * @param model - the model id.
 * @returns candidate keys in lookup order.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Band selection and bucket lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The price band in effect at one instant: pre-rollout single price, or the
 * peak/off-peak band once the rollout is live, classified against the
 * pricebook's own schedule (the zh or en page may state different windows).
 * @param time - epoch millis.
 * @param schedule - the peak-hour schedule to classify against.
 * @returns the band.
 */
export function bandForTime(time: number, schedule: PeakSchedule = PEAK_SCHEDULE_ZH): PriceBand {
  if (time < PEAK_PRICING_START_MS) return 'single'
  return isPeakHour(new Date(time), schedule) ? 'peak' : 'offPeak'
}

/**
 * The bucket of one model's price entry for one band, with graceful
 * degradation to whatever tier exists.
 * @param modelPrice - the model's price entry.
 * @param band - the band to price for.
 * @returns the bucket, or undefined when the entry carries no tier at all.
 */
export function bucketOf(modelPrice: ModelPrice, band: PriceBand): PriceBucket | undefined {
  if (band === 'single') return modelPrice.single ?? modelPrice.offPeak ?? modelPrice.peak
  if (band === 'peak') return modelPrice.peak ?? modelPrice.offPeak ?? modelPrice.single
  return modelPrice.offPeak ?? modelPrice.peak ?? modelPrice.single
}

/**
 * Resolve one model's bucket at one instant from its price entry.
 * @param modelPrice - the model's price entry.
 * @param time - the instant to price for.
 * @param schedule - the peak-hour schedule to classify against.
 * @returns the bucket and band, or null when the entry has no tier.
 */
export function priceAt(
  modelPrice: ModelPrice,
  time: number,
  schedule: PeakSchedule = PEAK_SCHEDULE_ZH,
): { bucket: PriceBucket; band: PriceBand } | null {
  const band = bandForTime(time, schedule)
  const bucket = bucketOf(modelPrice, band)
  return bucket === undefined ? null : { bucket, band }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the snapshot effective at `time`: the newest with `effectiveAt <=
 * time`, or the earliest available when no snapshot predates it (pre-install
 * sessions anchor to the first snapshot once, as required).
 * @param snapshots - the snapshot history, any order.
 * @param time - the instant to anchor.
 * @returns the snapshot, or undefined when the history is empty.
 */
export function snapshotForTime(snapshots: readonly PricebookSnapshot[], time: number): PricebookSnapshot | undefined {
  let best: PricebookSnapshot | undefined
  for (const snapshot of snapshots) {
    // `>=` keeps the NEWER snapshot (later in the array) on an effectiveAt tie.
    if (snapshot.effectiveAt <= time && (best === undefined || snapshot.effectiveAt >= best.effectiveAt)) best = snapshot
  }
  return best ?? (snapshots.length > 0 ? snapshots[0] : undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost formula
// ─────────────────────────────────────────────────────────────────────────────

/** The disjoint usage buckets one step reports. */
export interface StepUsage {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/**
 * The official cost formula, per million tokens: uncached input + cache
 * reads at the hit rate + cache writes at the uncached input rate (DeepSeek
 * reports only hit/miss buckets and bills writes as misses) + output.
 * @param usage - the step's token buckets.
 * @param bucket - the effective price bucket.
 * @returns the cost in the bucket's currency (CNY).
 */
export function stepCost(usage: StepUsage, bucket: PriceBucket): number {
  return (
    usage.uncached * bucket.inputPerMillion
    + usage.cacheRead * bucket.cacheReadPerMillion
    + usage.cacheWrite * bucket.inputPerMillion
    + usage.output * bucket.outputPerMillion
  ) / 1_000_000
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot diffing
// ─────────────────────────────────────────────────────────────────────────────

function bucketEqual(left: PriceBucket | undefined, right: PriceBucket | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return Math.abs(left.cacheReadPerMillion - right.cacheReadPerMillion) < 1e-9
    && Math.abs(left.inputPerMillion - right.inputPerMillion) < 1e-9
    && Math.abs(left.outputPerMillion - right.outputPerMillion) < 1e-9
}

function modelPriceEqual(left: ModelPrice, right: ModelPrice): boolean {
  if (left.source !== right.source) return false
  return bucketEqual(left.single, right.single)
    && bucketEqual(left.offPeak, right.offPeak)
    && bucketEqual(left.peak, right.peak)
}

/**
 * Whether two per-model price tables are equivalent (epsilon-compared).
 * Used to skip a new snapshot when a refresh changed nothing user-visible.
 */
export function pricesEqual(
  left: Record<string, ModelPrice>,
  right: Record<string, ModelPrice>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    const a = left[key]
    const b = right[key]
    if (a === undefined || b === undefined) return false
    if (!modelPriceEqual(a, b)) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// Price-table computation (the priority chain)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized official-page input: the parsed lists plus the failure marker. */
export interface OfficialPricingInput {
  /** Current (pre-rollout) list — the built-in fallback when the fetch failed. */
  current: CurrentPricing
  /** Peak/off-peak table, when the page carried it. */
  peak?: PeakPricing
  /** Peak-hour schedule of the fetched page (or the locale fallback). */
  schedule: PeakSchedule
  /** Fetch/parse failure reason; set when `current` is the fallback table. */
  error?: string
}

/** Normalized OpenRouter input: USD per 1M tokens per model id. */
export interface OpenRouterInput {
  /** Model id → USD per 1M tokens (already scaled from the per-token wire values). */
  usdPrices: Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number }>
  /** Fetch failure reason. */
  error?: string
}

/** Effective USD→CNY rate from the configured mode plus fallbacks. */
export function effectiveRate(fx: FxConfig, defaultRate: number): number {
  if (fx.mode === 'manual') return fx.manualRate
  return fx.lastAutoRate ?? fx.manualRate ?? defaultRate
}

/** Whether one canonical key already resolves to a non-OpenRouter (domestic) price. */
function hasDomesticPrice(prices: Record<string, ModelPrice>, key: string): boolean {
  const candidates = key.includes('/') ? [key] : [key, pricingKeyOfModel(key)]
  return candidates.some((candidate) => {
    const entry = prices[candidate]
    return entry !== undefined && entry.source !== 'openrouter'
  })
}

/**
 * Merge every source into one per-model price table through the priority
 * chain: manual overrides win; official (or the built-in fallback when the
 * page failed) covers the flash/pro pricing keys; OpenRouter covers only
 * models with no domestic price (fallback-only, USD→CNY, cache reads at the
 * configured discount). OpenRouter prices land under the aliased canonical
 * key so unaliased model ids still resolve through the key chain.
 * @param state - the pricebook state (overrides, aliases, discount, fx).
 * @param official - the official-page input (fallback table on failure).
 * @param openrouter - the OpenRouter input, or null when disabled/failed.
 * @param usdCnyRate - the effective exchange rate.
 * @param defaultRate - the configuration default rate (fallback chain end).
 * @returns the merged table and the highest-priority contributing source.
 */
export function computePricebook(
  state: PricebookState,
  official: OfficialPricingInput,
  openrouter: OpenRouterInput | null,
  usdCnyRate: number,
  defaultRate: number,
  fallbackPeak: PeakPricing = FALLBACK_PEAK,
  currency: Currency = 'CNY',
): { prices: Record<string, ModelPrice>; primarySource: PriceSource } {
  const prices: Record<string, ModelPrice> = {}

  // 1. Manual overrides — highest priority.
  for (const [key, override] of Object.entries(state.overrides)) {
    prices[key] = { ...override, source: 'manual' }
  }

  // 2. Official page (or built-in fallback) for the flash/pro pricing keys.
  const officialSource: PriceSource = official.error === undefined ? 'official' : 'fallback'
  for (const key of ['flash', 'pro'] as const) {
    if (prices[key] !== undefined) continue
    const peakTable = official.peak ?? fallbackPeak
    prices[key] = {
      source: officialSource,
      single: official.current[key],
      offPeak: peakTable[key].offPeak,
      peak: peakTable[key].peak,
    }
  }

  // 3. OpenRouter — fallback only: models with no domestic price yet.
  const openRouterFx = currency === 'USD' ? 1 : usdCnyRate
  if (openrouter !== null && openrouter.error === undefined && (currency === 'USD' || usdCnyRate > 0)) {
    const discount = state.cacheReadDiscount
    for (const [orId, usd] of Object.entries(openrouter.usdPrices)) {
      const alias = state.aliases[orId] ?? orId
      if (hasDomesticPrice(prices, alias)) continue // domestic price exists: OpenRouter stays out
      if (hasDomesticPrice(prices, orId)) continue
      const bucket: PriceBucket = {
        cacheReadPerMillion: usd.inputPerMillionUsd * discount * openRouterFx,
        inputPerMillion: usd.inputPerMillionUsd * openRouterFx,
        outputPerMillion: usd.outputPerMillionUsd * openRouterFx,
      }
      const entry: ModelPrice = { source: 'openrouter', single: bucket }
      prices[alias] = entry
      if (alias !== orId) prices[orId] = entry
    }
  }

  // Primary source: the highest-priority source that contributed at least one model.
  let primary: PriceSource = 'none'
  for (const candidate of ['manual', 'official', 'fallback', 'openrouter'] as const) {
    if (Object.values(prices).some(entry => entry.source === candidate)) {
      primary = candidate
      break
    }
  }

  return { prices, primarySource: primary }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote-source fetchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the USD→CNY rate from the free endpoint. Never throws; the caller
 * applies the fallback chain (last auto rate → manual/default rate).
 * @param fetchImpl - fetch-compatible function (injected for testability).
 * @param url - the endpoint.
 * @param timeoutMs - abort timeout.
 * @returns the fresh rate, or an error result.
 */
export async function fetchFxRate(
  fetchImpl: typeof fetch = globalThis.fetch,
  url: string = FX_API_URL,
  timeoutMs = 10_000,
): Promise<{ rate: number | null; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return { rate: null, error: `fx endpoint HTTP ${response.status}` }
    const wire = await response.json() as { rates?: Record<string, unknown> }
    const cny = Number(wire.rates?.CNY)
    if (!Number.isFinite(cny) || cny <= 0) return { rate: null, error: 'fx response carries no rates.CNY' }
    return { rate: cny }
  } catch (error) {
    return { rate: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Fetch the OpenRouter models directory and fold it into USD-per-1M-token
 * buckets. Every entry with a valid prompt/completion price is kept: the
 * directory is small (a few hundred rows) and the alias map is editable, so
 * a newly aliased model must resolve without waiting for the next refresh.
 * Never throws.
 * @param fetchImpl - fetch-compatible function (injected for testability).
 * @param url - the directory endpoint.
 * @param timeoutMs - abort timeout.
 * @param aliases - the current alias map (kept for parity, not used as a filter).
 * @returns the model price table, or an error result.
 */
export async function fetchOpenRouter(
  fetchImpl: typeof fetch = globalThis.fetch,
  url: string = OPENROUTER_MODELS_URL,
  timeoutMs = 15_000,
  aliases: Record<string, string> = DEFAULT_ALIASES,
): Promise<OpenRouterInput> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) return { usdPrices: {}, error: `openrouter models HTTP ${response.status}` }
    const wire = await response.json() as {
      data?: Array<{ id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }>
    }
    const usdPrices: OpenRouterInput['usdPrices'] = {}
    for (const entry of wire.data ?? []) {
      if (typeof entry.id !== 'string' || entry.pricing === undefined) continue
      const prompt = Number(entry.pricing.prompt)
      const completion = Number(entry.pricing.completion)
      if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt <= 0 || completion <= 0) continue
      usdPrices[entry.id] = {
        inputPerMillionUsd: prompt * 1_000_000,
        outputPerMillionUsd: completion * 1_000_000,
      }
    }
    return { usdPrices }
  } catch (error) {
    return { usdPrices: {}, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Fold a raw {@link PricingSnapshot} into the pricebook's official input. */
export function officialInputOf(snapshot: PricingSnapshot): OfficialPricingInput {
  return {
    current: snapshot.current,
    ...(snapshot.peak === undefined ? {} : { peak: snapshot.peak }),
    schedule: snapshot.schedule,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PricebookHandle: in-memory mirror + domain persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface PricebookResolvedConfig {
  fxApiUrl: string
  defaultFxRate: number
  openRouterModelsUrl: string
  openRouterEnabled: boolean
  snapshotHistoryLimit: number
}

/** Result of one price lookup: the bucket, band, and the snapshot it anchored to. */
export interface PriceHit {
  bucket: PriceBucket
  band: PriceBand
  source: PriceSource
  snapshotVersion: number
  snapshotEffectiveAt: number
}

/**
 * The synchronous read face the sessionCost projection folds against, plus
 * the mutation/refresh/persist surface the plugin's apply and route use.
 * Reads never touch the domain (mirror only); writes update the mirror first,
 * then queue a fail-soft durable write.
 */
export class PricebookHandle {
  /** The authoritative in-memory state (mirror of the domain global). */
  state: PricebookState
  private domain: Domain<typeof PRICEBOOK_DOMAIN> | undefined
  private persistTail: Promise<void> = Promise.resolve()
  private lastOfficial: OfficialPricingInput
  private lastOpenRouter: OpenRouterInput | null = null
  private lastFxError: string | undefined
  private fetchedAt = 0
  /** Peak-hour schedule of the pricebook's page (locale-matched). */
  schedule: PeakSchedule

  constructor(
    private readonly ctx: Context,
    private readonly config: PricebookResolvedConfig,
    persisted: PricebookState | undefined,
    private readonly currency: Currency = 'CNY',
    schedule?: PeakSchedule,
  ) {
    this.state = persisted ?? { ...initialPricebookState(), openRouterEnabled: config.openRouterEnabled }
    this.schedule = schedule ?? (currency === 'USD' ? PEAK_SCHEDULE_EN : PEAK_SCHEDULE_ZH)
    this.lastOfficial = { current: currency === 'USD' ? FALLBACK_CURRENT_USD : FALLBACK_CURRENT, schedule: this.schedule }
  }

  /**
   * Open the storage domain and adopt the persisted state. Never throws:
   * a missing storageDomain or a failed open degrades to in-memory only.
   */
  async init(): Promise<void> {
    const storageDomain = this.ctx.get('storageDomain')
    if (storageDomain === undefined) return
    try {
      const domain = this.currency === 'USD' ? PRICEBOOK_DOMAIN_USD : PRICEBOOK_DOMAIN
      this.domain = await storageDomain.open(domain) as Domain<typeof PRICEBOOK_DOMAIN>
      this.state = this.domain.global.get()
    } catch (error) {
      console.warn(`cost-meter: pricebook domain unavailable, keeping in-memory state: ${error instanceof Error ? error.message : String(error)}`)
      this.domain = undefined
    }
  }

  /** Queue one durable write of the whole state (fail-soft, serialized). */
  private persist(): void {
    if (this.domain === undefined) return
    const state = this.state
    this.persistTail = this.persistTail
      .then(() => this.domain!.global.set(state))
      .catch((error: unknown) => {
        console.warn(`cost-meter: pricebook persist failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Resolve once every queued durable write has settled. */
  async whenIdle(): Promise<void> {
    await this.persistTail
  }

  /** Release the domain (called from the plugin's disposer). */
  async close(): Promise<void> {
    await this.whenIdle()
    if (this.domain !== undefined) {
      const domain = this.domain
      this.domain = undefined
      await domain.close()
    }
  }

  /** The newest snapshot, or undefined before the first refresh. */
  currentSnapshot(): PricebookSnapshot | undefined {
    const snapshots = this.state.snapshots
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined
  }

  /** Pick the snapshot effective at `time`. */
  snapshotFor(time: number): PricebookSnapshot | undefined {
    return snapshotForTime(this.state.snapshots, time)
  }

  /**
   * Resolve the price of one model at one instant through the key chain and
   * the anchored snapshot. Synchronous: the fold calls this per usage event.
   * @param provider - the provider route, when known.
   * @param model - the model id.
   * @param time - the instant to price for.
   * @returns the hit, or null when no source carries a price.
   */
  priceFor(provider: string | undefined, model: string, time: number): PriceHit | null {
    const snapshot = this.snapshotFor(time)
    if (snapshot === undefined) return null
    for (const key of modelKeys(provider, model)) {
      const entry = snapshot.prices[key]
      if (entry === undefined) continue
      const hit = priceAt(entry, time, this.schedule)
      if (hit === null) continue
      return {
        bucket: hit.bucket,
        band: hit.band,
        source: entry.source,
        snapshotVersion: snapshot.version,
        snapshotEffectiveAt: snapshot.effectiveAt,
      }
    }
    return null
  }

  /** The effective USD→CNY rate under the current configuration. */
  private rate(): number {
    return effectiveRate(this.state.fx, this.config.defaultFxRate)
  }

  /** Cap the snapshot history to the configured limit (newest kept). */
  private capSnapshots(): void {
    const limit = this.config.snapshotHistoryLimit
    if (this.state.snapshots.length > limit) {
      this.state = { ...this.state, snapshots: this.state.snapshots.slice(-limit) }
    }
  }

  /**
   * Recompute the resolved table from the cached inputs and start a new
   * snapshot when anything user-visible changed. Shared by the startup
   * refresh, the periodic refresh, the manual refresh, and every settings
   * mutation.
   */
  private recompute(now: number): void {
    const openrouter = this.config.openRouterEnabled ? this.lastOpenRouter : null
    const { prices, primarySource } = computePricebook(
      this.state, this.lastOfficial, openrouter, this.rate(), this.config.defaultFxRate,
      this.currency === 'USD' ? FALLBACK_PEAK_USD : FALLBACK_PEAK,
      this.currency,
    )
    const last = this.currentSnapshot()
    if (last !== undefined && pricesEqual(last.prices, prices)) return
    const version = (last?.version ?? 0) + 1
    const snapshot: PricebookSnapshot = {
      version,
      currency: this.currency,
      effectiveAt: now,
      source: primarySource,
      usdCnyRate: this.rate(),
      prices,
    }
    this.state = { ...this.state, snapshots: [...this.state.snapshots, snapshot], updatedAt: now }
    this.capSnapshots()
    this.persist()
  }

  /**
   * Refresh every remote source (official page, exchange rate, OpenRouter
   * when enabled) and re-anchor a snapshot on change. Never throws.
   * @param options - injected results (testability); omitted values are fetched.
   */
  async refresh(options?: {
    official?: PricingSnapshot
    fx?: { rate: number | null; error?: string }
    openrouter?: OpenRouterInput
  }): Promise<void> {
    const official = options?.official ?? await fetchPricing(globalThis.fetch, 15_000, this.currency === 'USD' ? 'en' : 'zh')
    this.lastOfficial = officialInputOf(official)
    this.schedule = this.lastOfficial.schedule
    this.lastFxError = undefined
    if (options?.fx !== undefined) {
      this.applyFxResult(options.fx.rate, options.fx.error)
    } else if (this.state.fx.mode === 'auto') {
      const fx = await fetchFxRate(globalThis.fetch, this.config.fxApiUrl)
      this.applyFxResult(fx.rate, fx.error)
    }
    if (this.state.openRouterEnabled) {
      this.lastOpenRouter = options?.openrouter ?? await fetchOpenRouter(globalThis.fetch, this.config.openRouterModelsUrl, 15_000, this.state.aliases)
    } else {
      this.lastOpenRouter = null
    }
    this.fetchedAt = Date.now()
    this.recompute(this.fetchedAt)
  }

  private applyFxResult(rate: number | null, error: string | undefined): void {
    this.lastFxError = error
    if (rate !== null) {
      this.state = {
        ...this.state,
        fx: { ...this.state.fx, lastAutoRate: rate, rateFetchedAt: Date.now() },
      }
    }
  }

  /** Apply a settings mutation and re-anchor (snapshot on change). */
  private mutate(mutator: (state: PricebookState) => PricebookState): void {
    this.state = mutator(this.state)
    this.recompute(Date.now())
    // Field-only changes (e.g. the balance toggle) may not move the price
    // table, so the recompute can skip persistence — persist unconditionally.
    this.persist()
  }

  async setOverrides(overrides: Record<string, ModelPrice>): Promise<void> {
    this.mutate(state => ({ ...state, overrides }))
    await this.whenIdle()
  }

  async setAliases(aliases: Record<string, string>): Promise<void> {
    this.state = { ...this.state, aliases }
    // A newly aliased model must resolve immediately: refresh the directory
    // against the new alias map (enabled only), then re-anchor on change.
    if (this.state.openRouterEnabled) {
      this.lastOpenRouter = await fetchOpenRouter(globalThis.fetch, this.config.openRouterModelsUrl, 15_000, aliases)
    }
    this.recompute(Date.now())
    await this.whenIdle()
  }

  async setCacheReadDiscount(discount: number): Promise<void> {
    this.mutate(state => ({ ...state, cacheReadDiscount: discount }))
    await this.whenIdle()
  }

  async setFx(mode: FxConfig['mode'], manualRate: number): Promise<void> {
    this.mutate(state => ({ ...state, fx: { ...state.fx, mode, manualRate } }))
    await this.whenIdle()
  }

  async setBalanceEnabled(enabled: boolean): Promise<void> {
    this.mutate(state => ({ ...state, balanceEnabled: enabled }))
    await this.whenIdle()
  }

  async setOpenRouterEnabled(enabled: boolean): Promise<void> {
    this.mutate(state => ({ ...state, openRouterEnabled: enabled }))
    await this.whenIdle()
  }

  /**
   * Apply a resolved plugin-settings snapshot (the `cost-meter`
   * settings namespace) to the pricebook: the editable configuration fields
   * overwrite the persisted state and the resolved table re-anchors (a new
   * snapshot starts when anything user-visible changed). Never throws.
   * @param settings - the settings-section value (may carry only a subset).
   */
  applySettings(settings: Partial<{
    overrides: Record<string, ModelPrice> | undefined
    aliases: Record<string, string> | undefined
    cacheReadDiscount: number | undefined
    fxMode: 'auto' | 'manual' | undefined
    manualRate: number | undefined
    balanceEnabled: boolean | undefined
    openRouterEnabled: boolean | undefined
  }>): void {
    try {
      let next = this.state
      if (settings.overrides !== undefined) next = { ...next, overrides: settings.overrides }
      if (settings.aliases !== undefined) next = { ...next, aliases: settings.aliases }
      if (settings.cacheReadDiscount !== undefined) next = { ...next, cacheReadDiscount: settings.cacheReadDiscount }
      if (settings.fxMode !== undefined || settings.manualRate !== undefined) {
        next = {
          ...next,
          fx: {
            ...next.fx,
            ...(settings.fxMode === undefined ? {} : { mode: settings.fxMode }),
            ...(settings.manualRate === undefined ? {} : { manualRate: settings.manualRate }),
          },
        }
      }
      if (settings.balanceEnabled !== undefined) next = { ...next, balanceEnabled: settings.balanceEnabled }
      if (settings.openRouterEnabled !== undefined) next = { ...next, openRouterEnabled: settings.openRouterEnabled }
      if (next === this.state) return
      this.state = next
      // A newly aliased model must resolve immediately (enabled only).
      if (settings.aliases !== undefined && next.openRouterEnabled) {
        void fetchOpenRouter(globalThis.fetch, this.config.openRouterModelsUrl, 15_000, next.aliases)
          .then((result) => {
            if (result.error === undefined) this.lastOpenRouter = result
          })
          .catch(() => { /* keep the last directory */ })
      }
      this.recompute(Date.now())
      this.persist()
    } catch (error) {
      console.warn(`cost-meter: settings apply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The read-side payload for the route. */
  view(): PricebookView {
    const errors: NonNullable<PricebookView['errors']> = {}
    if (this.lastOfficial.error !== undefined) errors.official = this.lastOfficial.error
    if (this.lastFxError !== undefined) errors.fx = this.lastFxError
    if (this.lastOpenRouter?.error !== undefined) errors.openRouter = this.lastOpenRouter.error
    return {
      currency: this.currency,
      current: this.currentSnapshot() ?? null,
      snapshots: this.state.snapshots,
      overrides: this.state.overrides,
      aliases: this.state.aliases,
      cacheReadDiscount: this.state.cacheReadDiscount,
      fx: this.state.fx,
      balanceEnabled: this.state.balanceEnabled,
      openRouterEnabled: this.state.openRouterEnabled,
      fetchedAt: this.fetchedAt,
      schedule: this.schedule,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    }
  }
}


