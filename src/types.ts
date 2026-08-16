/**
 * Wire and public vocabulary for the cost-meter plugin.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/types
 */

/**
 * One balance row of the official DeepSeek `GET /user/balance` response.
 * The provider returns the amounts as decimal strings; the plugin converts
 * them to numbers at the boundary so the browser surface can format them.
 */
export interface WireBalanceInfo {
  /** ISO 4217 currency code of this row (e.g. `CNY`). */
  currency: string
  /** Total account balance as a decimal string. */
  total_balance: string
  /** Granted (free) balance as a decimal string; absent when the row omits it. */
  granted_balance?: string
  /** Topped-up (paid) balance as a decimal string; absent when the row omits it. */
  topped_up_balance?: string
}

/** Parsed wire envelope of `GET /user/balance`. */
export interface WireBalanceResponse {
  /** Whether the account can currently accept paid requests. */
  is_available?: boolean
  /** Per-currency balance rows; the plugin reads the first row. */
  balance_infos?: WireBalanceInfo[]
}

/** One parsed, number-valued balance row. */
export interface BalanceInfo {
  /** ISO 4217 currency code (e.g. `CNY`). */
  currency: string
  /** Total account balance. */
  total: number
  /** Granted (free) balance. */
  granted: number
  /** Topped-up (paid) balance. */
  toppedUp: number
}

/**
 * One balance snapshot served to the browser. The ok/error split keeps
 * transport and provider failures machine-readable instead of turning into
 * HTTP errors the surface would have to guess at.
 */
export type BalanceSnapshot =
  | {
    /** Whether the request succeeded. */
    ok: true
    /** Provider `is_available` flag; false while paid requests are suspended. */
    isAvailable: boolean
    /** First balance row; null when the response carried no rows. */
    balance: BalanceInfo | null
    /** Epoch millis when the snapshot was fetched. */
    fetchedAt: number
  }
  | {
    /** Whether the request succeeded. */
    ok: false
    /** Stable machine code (`MISSING_CREDENTIAL`, `NETWORK`, `HTTP_<status>`). */
    code: string
    /** Human-readable detail for logs and tooltips. */
    message: string
  }

/** Supported display/pricing currencies. */
export type Currency = 'CNY' | 'USD'

/**
 * Token prices per 1M tokens, mirroring the official DeepSeek price table.
 * All amounts share one currency (CNY for the official list prices).
 */
export interface PriceBucket {
  /** Price per 1M prompt tokens served from the cache. */
  cacheReadPerMillion: number
  /** Price per 1M prompt tokens that missed the cache (cache writes bill at this rate). */
  inputPerMillion: number
  /** Price per 1M completion tokens. */
  outputPerMillion: number
}

/** One model's price set under the current (pre-rollout) official list. */
export interface CurrentPricing {
  /** deepseek-v4-flash prices. */
  flash: PriceBucket
  /** deepseek-v4-pro prices. */
  pro: PriceBucket
}

/** One model's peak/off-peak price set (the 2026-08-17 rollout). */
export interface PeakModelPricing {
  /** Off-peak hours prices (half of peak). */
  offPeak: PriceBucket
  /** Peak hours prices (09:00-12:00 / 14:00-18:00 Beijing). */
  peak: PriceBucket
}

/** The full upcoming peak/off-peak table for both models. */
export interface PeakPricing {
  flash: PeakModelPricing
  pro: PeakModelPricing
}

/**
 * One pricing snapshot served to the browser: the parsed official page plus
 * the effective per-model prices at the current moment.
 */
export interface PricingSnapshot {
  /** Epoch millis when the official page was last fetched. */
  fetchedAt: number
  /** Currency of this pricing page snapshot. */
  currency: Currency
  /** Current (pre-rollout) official list prices; built-in fallback on fetch failure. */
  current: CurrentPricing
  /** Upcoming peak/off-peak table, when the page carried it. */
  peak?: PeakPricing
  /** Whether the peak-pricing rollout has started (>= 2026-08-17 00:00 Beijing). */
  peakActive: boolean
  /** Prices in effect right now per model (peak/off-peak band applied when active). */
  effective: CurrentPricing
  /** The pricing band in effect while the rollout is live; absent before it. */
  band?: 'peak' | 'offPeak'
  /** Fetch/parse failure reason; absent while the official page parsed cleanly. */
  error?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricebook vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where one model's price in a snapshot came from. The per-model resolution
 * chain is: manual override > official page > built-in fallback > OpenRouter
 * (USD→CNY, fallback only) > none.
 */
export type PriceSource = 'manual' | 'official' | 'fallback' | 'openrouter' | 'none'

/**
 * One model's full price set inside a snapshot: the pre-rollout single list
 * price and/or the post-rollout peak/off-peak pair. The official page and the
 * built-in fallback both carry `single` (current list) plus the peak pair;
 * a manual override may carry any subset; an OpenRouter-derived entry carries
 * only `single` (OpenRouter has no peak bands).
 */
export interface ModelPrice {
  /** The source that produced this entry. */
  source: PriceSource
  /** Pre-rollout single list price. */
  single?: PriceBucket
  /** Post-rollout off-peak price (09:00-12:00 / 14:00-18:00 Beijing half). */
  offPeak?: PriceBucket
  /** Post-rollout peak price. */
  peak?: PriceBucket
}

/**
 * One immutable price snapshot: the complete per-model price table anchored
 * at `effectiveAt`. Snapshots are append-only: every price/fx/band-table
 * change starts a new snapshot (monotonic `version`), and every fold anchors
 * to the snapshot effective at the priced event's own time — so a price
 * change never rewrites an already-written conversation row.
 */
export interface PricebookSnapshot {
  /** Monotonic snapshot version (1-based). */
  version: number
  /** Currency of the prices in this snapshot. */
  currency: Currency
  /** Epoch millis when this snapshot became effective. */
  effectiveAt: number
  /** Highest-priority source that contributed at least one model. */
  source: PriceSource
  /** USD→CNY rate used for OpenRouter-derived prices at snapshot time; null when unused. */
  usdCnyRate: number | null
  /** Per canonical model key (`provider/model`, bare model, or pricing key). */
  prices: Record<string, ModelPrice>
}

/** USD→CNY exchange configuration. */
export interface FxConfig {
  /** `auto` refreshes from the configured API; `manual` pins a fixed rate. */
  mode: 'auto' | 'manual'
  /** Manually pinned rate (used in manual mode; also the auto-mode fallback). */
  manualRate: number
  /** Last successfully auto-fetched rate; absent before the first fetch. */
  lastAutoRate?: number
  /** Epoch millis of the last successful auto fetch. */
  rateFetchedAt?: number
}

/**
 * The persisted pricebook state (the `pricebook` storage domain global):
 * snapshot history plus the editable configuration that shapes future
 * snapshots. Prices are append-only via `snapshots`; configuration is
 * last-write-wins.
 */
export interface PricebookState {
  /** Append-only snapshot history, newest last. */
  snapshots: PricebookSnapshot[]
  /** Manual per-model overrides (source `manual`), keyed by canonical model key. */
  overrides: Record<string, ModelPrice>
  /** OpenRouter model-id → canonical model key aliases (editable). */
  aliases: Record<string, string>
  /** Cache-read price as a fraction of the uncached input price (OpenRouter only). */
  cacheReadDiscount: number
  /** USD→CNY exchange configuration. */
  fx: FxConfig
  /** Whether the balance readout is enabled in the UI. */
  balanceEnabled: boolean
  /** Whether OpenRouter is allowed as a fallback source. */
  openRouterEnabled: boolean
  /** Epoch millis of the last state mutation. */
  updatedAt: number
}

/**
 * The `/cost-meter` pricebook payload served to the browser: the
 * current snapshot plus the editable configuration and refresh diagnostics.
 */
export interface PricebookView {
  /** Currency of the pricebook view. */
  currency: Currency
  /** The newest snapshot; null before the first successful refresh. */
  current: PricebookSnapshot | null
  /** Snapshot history, newest last (capped at the configured limit). */
  snapshots: PricebookSnapshot[]
  /** Manual overrides, keyed by canonical model key. */
  overrides: Record<string, ModelPrice>
  /** OpenRouter id → canonical key aliases. */
  aliases: Record<string, string>
  /** Cache-read discount fraction. */
  cacheReadDiscount: number
  /** Exchange configuration. */
  fx: FxConfig
  /** Whether the balance readout is enabled. */
  balanceEnabled: boolean
  /** Whether OpenRouter fallback is enabled. */
  openRouterEnabled: boolean
  /** Epoch millis of the last refresh. */
  fetchedAt: number
  /** Refresh diagnostics (absent when the corresponding fetch succeeded). */
  errors?: {
    /** Official pricing-page fetch/parse failure. */
    official?: string
    /** OpenRouter models fetch failure. */
    openRouter?: string
    /** Exchange-rate fetch failure. */
    fx?: string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sessionCost projection vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** The pricing band that priced one step, or the pre-rollout single price. */
export type PriceBand = 'peak' | 'offPeak' | 'single'

/** Why a step carries no cost (shown as `—` in the UI). */
export type UnpricedReason = 'NO_MODEL' | 'NO_PRICE'

/**
 * One step's priced ledger entry inside the projection state. The record is
 * immutable once written: the cost, band, and snapshot version are anchored
 * to the usage event's own time and never recomputed.
 */
export interface SessionCostStep {
  /** Turn number of the reply. */
  turn: number
  /** Step number of the reply within the turn. */
  step: number
  /** Epoch millis of the usage event that priced this step. */
  time: number
  /** Model id that produced the usage, from the last `request/header`. */
  model: string
  /** Provider route that produced the usage, when known. */
  provider?: string
  /** Uncached input tokens (excludes cache traffic). */
  uncachedInputTokens: number
  /** Cache-read input tokens. */
  cacheReadTokens: number
  /** Cache-write tokens (billed at the uncached input price). */
  cacheWriteTokens: number
  /** Output tokens. */
  outputTokens: number
  /** Uncached-input cost (cache writes fold in: same input rate); 0 when unpriced. */
  uncachedCost: number
  /** Cache-read cost; 0 when unpriced. */
  cacheReadCost: number
  /** Output cost; 0 when unpriced. */
  outputCost: number
  /** Step cost in CNY (`uncachedCost + cacheReadCost + outputCost`); null when the model had no price. */
  cost: number | null
  /** Whether this step was priced (has a bucket). */
  priced: boolean
  /** Why the step was not priced. */
  unpricedReason?: UnpricedReason
  /** Snapshot version the step was anchored to; null when unpriced. */
  snapshotVersion: number | null
  /** Epoch millis the anchored snapshot became effective. */
  snapshotEffectiveAt: number | null
  /** Band that priced this step. */
  band: PriceBand | null
}

/** Cumulative per-category totals across every priced step. */
export interface SessionCostTotals {
  /** Sum of uncached-input costs (cache writes fold in: same input rate). */
  uncachedCost: number
  /** Sum of cache-read costs. */
  cacheReadCost: number
  /** Sum of output costs. */
  outputCost: number
  /** Total cost across every priced step (sum of the three categories). */
  cost: number
  /** Number of steps with a price. */
  pricedSteps: number
  /** Number of steps without a price. */
  unpricedSteps: number
  /** Total number of steps with usage. */
  steps: number
}

/**
 * The `sessionCost` projection value: the complete anchored cost ledger of
 * one session, served to the browser. Every step is immutable — price
 * changes only affect steps not yet written.
 */
export interface SessionCostProjection {
  /** Last model seen in a `request/header` event. */
  model: { provider: string; model: string } | null
  /** All priced/unpriced steps, ordered by turn then step. */
  steps: SessionCostStep[]
  /** Cumulative totals. */
  totals: SessionCostTotals
}

/** One subagent session's anchored cost totals, aggregated host-side. */
export interface SubagentCost {
  /** The subagent session id. */
  sessionId: string
  /** The subagent's anchored totals (empty ledger → all zeros). */
  totals: SessionCostTotals
}

/** The complete payload the `/cost-meter` route serves. */
export interface ConversationCostResponse {
  /** Latest balance snapshot; null before the first successful fetch. */
  balance: BalanceSnapshot | null
  /** The pricebook view: current snapshot, history, and configuration. */
  pricebook: PricebookView
  /** Descendant subagent sessions of the requested session, with their totals. */
  subagents: SubagentCost[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Anchored per-step cost ledger of one session (CNY pricebook). */
    sessionCost: SessionCostProjection
    /** Anchored per-step cost ledger of one session (USD pricebook). */
    sessionCostUsd: SessionCostProjection
  }
}
