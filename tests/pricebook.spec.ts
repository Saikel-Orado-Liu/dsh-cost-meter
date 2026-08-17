/**
 * Pricebook coverage: band selection around the peak rollout, snapshot
 * selection by event time, the cost formula (cache writes at the uncached
 * input rate), the per-model priority chain (manual > official > fallback >
 * OpenRouter, fallback-only), USD→CNY conversion, snapshot diffing, and the
 * PricebookHandle read/mutation surface.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  bandForTime,
  bucketOf,
  computePricebook,
  DEFAULT_ALIASES,
  DEFAULT_CACHE_READ_DISCOUNT,
  DEFAULT_FX_RATE,
  effectiveRate,
  fetchFxRate,
  fetchOpenRouter,
  initialPricebookState,
  modelKeys,
  priceAt,
  PricebookHandle,
  pricesEqual,
  pricingKeyOfModel,
  snapshotForTime,
  stepCost,
} from '../src/pricebook.ts'
import { FALLBACK_CURRENT, FALLBACK_PEAK, PEAK_PRICING_START_MS, PEAK_SCHEDULE_EN, PEAK_SCHEDULE_ZH } from '../src/pricing.ts'
import type {
  CurrentPricing,
  ModelPrice,
  PricebookSnapshot,
  PricebookState,
  PriceBucket,
  PricingSnapshot,
} from '../src/types.ts'

/** 2026-08-17 10:00 Beijing (post-rollout, peak hour) = UTC 02:00. */
const POST_PEAK = Date.UTC(2026, 7, 17, 2, 0, 0)
/** 2026-08-17 20:00 Beijing (post-rollout, off-peak) = UTC 12:00. */
const POST_OFFPEAK = Date.UTC(2026, 7, 17, 12, 0, 0)
/** 2026-08-10 12:00 Beijing (pre-rollout). */
const PRE_ROLLOUT = Date.UTC(2026, 7, 10, 4, 0, 0)

const FLASH_OFFPEAK: PriceBucket = { cacheReadPerMillion: 0.05, inputPerMillion: 1.5, outputPerMillion: 4.5 }
const FLASH_PEAK: PriceBucket = { cacheReadPerMillion: 0.1, inputPerMillion: 3, outputPerMillion: 9 }

const OFFICIAL: PricingSnapshot = {
  fetchedAt: Date.now(),
  currency: 'CNY',
  current: FALLBACK_CURRENT,
  peak: FALLBACK_PEAK,
  peakActive: true,
  effective: FALLBACK_CURRENT,
  schedule: PEAK_SCHEDULE_ZH,
}

function snapshotFixture(version: number, effectiveAt: number, prices: Record<string, ModelPrice>): PricebookSnapshot {
  return { version, currency: 'CNY', effectiveAt, source: 'official', usdCnyRate: null, prices }
}

function handleWith(state: PricebookState): PricebookHandle {
  return new PricebookHandle({} as Context, {
    fxApiUrl: 'https://fx.invalid',
    defaultFxRate: DEFAULT_FX_RATE,
    openRouterModelsUrl: 'https://or.invalid',
    openRouterEnabled: true,
    snapshotHistoryLimit: 50,
  }, state)
}

// Hermetic remotes: any real fetch inside a refresh resolves to an empty
// OpenRouter directory (fx reads it as a malformed body → fallback path).
beforeEach(() => {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [] }),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bandForTime', () => {
  it('uses the single band before the rollout', () => {
    expect(bandForTime(PRE_ROLLOUT)).toBe('single')
    expect(bandForTime(PEAK_PRICING_START_MS - 1)).toBe('single')
  })

  it('uses peak/offPeak after the rollout by Beijing hour', () => {
    expect(bandForTime(POST_PEAK)).toBe('peak')
    expect(bandForTime(POST_OFFPEAK)).toBe('offPeak')
  })

  it('classifies against a custom schedule (the en page may differ from zh)', () => {
    const utcSchedule = { timezone: 'UTC', ranges: [[0, 6]] as const }
    // 05:30 UTC: peak under the UTC schedule, off-peak (13:30 Beijing) under zh.
    const at0530 = Date.UTC(2026, 7, 17, 5, 30, 0)
    expect(bandForTime(at0530, utcSchedule)).toBe('peak')
    expect(bandForTime(at0530)).toBe('offPeak')
    // 07:00 UTC: off-peak under the UTC schedule, peak (15:00 Beijing) under zh.
    const at0700 = Date.UTC(2026, 7, 17, 7, 0, 0)
    expect(bandForTime(at0700, utcSchedule)).toBe('offPeak')
    expect(bandForTime(at0700)).toBe('peak')
  })
})

describe('bucketOf / priceAt', () => {
  const entry: ModelPrice = { source: 'official', single: FALLBACK_CURRENT.flash, offPeak: FLASH_OFFPEAK, peak: FLASH_PEAK }

  it('picks the tier by band with graceful degradation', () => {
    expect(bucketOf(entry, 'single')).toEqual(FALLBACK_CURRENT.flash)
    expect(bucketOf(entry, 'peak')).toEqual(FLASH_PEAK)
    expect(bucketOf(entry, 'offPeak')).toEqual(FLASH_OFFPEAK)
    expect(bucketOf({ source: 'manual', single: FLASH_OFFPEAK }, 'peak')).toEqual(FLASH_OFFPEAK)
    expect(bucketOf({ source: 'manual' }, 'single')).toBeUndefined()
  })

  it('resolves the band from the instant', () => {
    expect(priceAt(entry, POST_PEAK)).toEqual({ bucket: FLASH_PEAK, band: 'peak' })
    expect(priceAt(entry, POST_OFFPEAK)).toEqual({ bucket: FLASH_OFFPEAK, band: 'offPeak' })
    expect(priceAt(entry, PRE_ROLLOUT)).toEqual({ bucket: FALLBACK_CURRENT.flash, band: 'single' })
  })
})

describe('modelKeys', () => {
  it('builds the canonical chain most-specific first', () => {
    expect(modelKeys('deepseek-official', 'deepseek-v4-flash')).toEqual([
      'deepseek-official/deepseek-v4-flash', 'deepseek-v4-flash', 'flash',
    ])
  })

  it('keeps the flash/pro pricing keys only for DeepSeek-family models', () => {
    expect(modelKeys(undefined, 'some-other-model')).toEqual(['some-other-model'])
    expect(modelKeys('anthropic', 'claude-sonnet-4')).toEqual(['anthropic/claude-sonnet-4', 'claude-sonnet-4'])
  })

  it('classifies pro models through the pricing key', () => {
    expect(pricingKeyOfModel('deepseek-v4-pro')).toBe('pro')
    expect(pricingKeyOfModel('deepseek-v4-flash')).toBe('flash')
  })
})

describe('snapshotForTime', () => {
  const snapshots = [
    snapshotFixture(1, 1_000, {}),
    snapshotFixture(2, 2_000, {}),
    snapshotFixture(3, 3_000, {}),
  ]

  it('picks the newest snapshot effective at or before the event time', () => {
    expect(snapshotForTime(snapshots, 1_500)?.version).toBe(1)
    expect(snapshotForTime(snapshots, 2_000)?.version).toBe(2)
    expect(snapshotForTime(snapshots, 9_999)?.version).toBe(3)
  })

  it('falls back to the earliest snapshot for pre-install events', () => {
    expect(snapshotForTime(snapshots, 500)?.version).toBe(1)
  })

  it('returns undefined for an empty history', () => {
    expect(snapshotForTime([], 1_000)).toBeUndefined()
  })
})

describe('stepCost', () => {
  it('prices the disjoint buckets per million tokens', () => {
    // 1M uncached × 1 + 1M cache read × 0.02 + 1M cache write × 1 + 1M output × 2 = 4.02
    expect(stepCost({ uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }, FALLBACK_CURRENT.flash))
      .toBeCloseTo(4.02)
  })

  it('bills cache writes at the uncached input rate, not at zero', () => {
    // 1M cache write × 1 = 1
    expect(stepCost({ uncached: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }, FALLBACK_CURRENT.flash))
      .toBeCloseTo(1)
  })
})

describe('computePricebook priority chain', () => {
  const state = initialPricebookState()

  it('covers flash/pro from the official page without overrides or OpenRouter', () => {
    const { prices, primarySource } = computePricebook(state, { current: OFFICIAL.current, peak: OFFICIAL.peak }, null, 7.2, 7.2)
    expect(primarySource).toBe('official')
    expect(prices.flash?.source).toBe('official')
    expect(prices.flash?.single).toEqual(FALLBACK_CURRENT.flash)
    expect(prices.flash?.offPeak).toEqual(FALLBACK_PEAK.flash.offPeak)
    expect(prices.pro?.peak).toEqual(FALLBACK_PEAK.pro.peak)
  })

  it('marks the fallback source when the official fetch failed', () => {
    const { prices, primarySource } = computePricebook(
      state, { current: FALLBACK_CURRENT, error: 'ECONNREFUSED' }, null, 7.2, 7.2,
    )
    expect(primarySource).toBe('fallback')
    expect(prices.flash?.source).toBe('fallback')
    // The fallback still carries the built-in peak table.
    expect(prices.flash?.offPeak).toEqual(FALLBACK_PEAK.flash.offPeak)
  })

  it('lets manual overrides win over official prices', () => {
    const withOverride = {
      ...state,
      overrides: {
        'deepseek-v4-flash': { source: 'manual', single: { cacheReadPerMillion: 0.1, inputPerMillion: 5, outputPerMillion: 10 } },
      },
    }
    const { prices, primarySource } = computePricebook(withOverride, { current: OFFICIAL.current, peak: OFFICIAL.peak }, null, 7.2, 7.2)
    expect(primarySource).toBe('manual')
    expect(prices['deepseek-v4-flash']?.source).toBe('manual')
    expect(prices['deepseek-v4-flash']?.single?.inputPerMillion).toBe(5)
    // The pricing key stays official for the non-overridden pro column.
    expect(prices.pro?.source).toBe('official')
  })

  it('keeps OpenRouter out while a domestic price exists', () => {
    const openrouter = {
      usdPrices: {
        'deepseek/deepseek-chat': { inputPerMillionUsd: 0.14, outputPerMillionUsd: 0.28 },
        'anthropic/claude-sonnet-4': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
      },
    }
    const { prices } = computePricebook(state, { current: OFFICIAL.current, peak: OFFICIAL.peak }, openrouter, 7.2, 7.2)
    // deepseek/deepseek-chat aliases to deepseek-v4-flash which has a domestic price: skipped.
    expect(prices['deepseek-v4-flash']?.source).not.toBe('openrouter')
    // The anthropic model has no domestic price: OpenRouter fills it, converted to CNY.
    const anthropic = prices['anthropic/claude-sonnet-4']
    expect(anthropic?.source).toBe('openrouter')
    expect(anthropic?.single?.inputPerMillion).toBeCloseTo(3 * 7.2)
    expect(anthropic?.single?.outputPerMillion).toBeCloseTo(15 * 7.2)
    expect(anthropic?.single?.cacheReadPerMillion).toBeCloseTo(3 * 7.2 * DEFAULT_CACHE_READ_DISCOUNT)
  })

  it('falls back to the default rate when no fx result exists', () => {
    const withFx = { ...state, fx: { mode: 'auto' as const, manualRate: 7.5 } }
    const openrouter = { usdPrices: { 'anthropic/claude-sonnet-4': { inputPerMillionUsd: 1, outputPerMillionUsd: 2 } } }
    const { prices } = computePricebook(withFx, { current: OFFICIAL.current, peak: OFFICIAL.peak }, openrouter, effectiveRate(withFx.fx, DEFAULT_FX_RATE), DEFAULT_FX_RATE)
    expect(prices['anthropic/claude-sonnet-4']?.single?.inputPerMillion).toBeCloseTo(7.5)
  })

  it('respects the alias map for OpenRouter canonical keys', () => {
    const withAlias = { ...state, aliases: { 'custom/deepseek-r2': 'deepseek-v4-pro' } }
    const openrouter = { usdPrices: { 'custom/deepseek-r2': { inputPerMillionUsd: 0.5, outputPerMillionUsd: 1 } } }
    const { prices } = computePricebook(withAlias, { current: OFFICIAL.current, peak: OFFICIAL.peak }, openrouter, 7.2, 7.2)
    // The alias resolves to pro which HAS a domestic price (the pro pricing key) — still skipped.
    expect(prices.pro?.source).toBe('official')
    expect(prices['custom/deepseek-r2']).toBeUndefined()
  })
})

describe('pricesEqual', () => {
  it('detects real price changes and ignores floating noise', () => {
    const a = { flash: { source: 'official' as const, single: FALLBACK_CURRENT.flash } }
    expect(pricesEqual(a, { ...a })).toBe(true)
    expect(pricesEqual(a, { flash: { source: 'official' as const, single: { ...FALLBACK_CURRENT.flash, inputPerMillion: 1 + 1e-12 } } })).toBe(true)
    expect(pricesEqual(a, { flash: { source: 'official' as const, single: { ...FALLBACK_CURRENT.flash, inputPerMillion: 2 } } })).toBe(false)
    expect(pricesEqual(a, {})).toBe(false)
  })
})

describe('PricebookHandle priceFor', () => {
  it('resolves through the canonical key chain and the anchored snapshot', () => {
    const prices: Record<string, ModelPrice> = {
      'deepseek-v4-flash': { source: 'manual', single: FALLBACK_CURRENT.flash },
      flash: { source: 'official', single: FALLBACK_CURRENT.flash, offPeak: FLASH_OFFPEAK, peak: FLASH_PEAK },
    }
    const handle = handleWith({ ...initialPricebookState(), snapshots: [snapshotFixture(1, 1_000, prices)] })
    // Bare model override wins over the flash pricing key.
    expect(handle.priceFor('deepseek-official', 'deepseek-v4-flash', POST_PEAK)?.bucket).toEqual(FALLBACK_CURRENT.flash)
    expect(handle.priceFor('deepseek-official', 'deepseek-v4-flash', POST_PEAK)?.source).toBe('manual')
    // Unknown model without a price resolves to nothing.
    expect(handle.priceFor('anthropic', 'claude-sonnet-4', POST_PEAK)).toBeNull()
    // Pro pricing key applies the peak band post-rollout.
    const proPrices: Record<string, ModelPrice> = { pro: { source: 'official', single: FALLBACK_CURRENT.pro, offPeak: FALLBACK_PEAK.pro.offPeak, peak: FALLBACK_PEAK.pro.peak } }
    const proHandle = handleWith({ ...initialPricebookState(), snapshots: [snapshotFixture(1, 1_000, proPrices)] })
    expect(proHandle.priceFor('deepseek-official', 'deepseek-v4-pro', POST_PEAK)?.band).toBe('peak')
    expect(proHandle.priceFor('deepseek-official', 'deepseek-v4-pro', POST_PEAK)?.bucket?.inputPerMillion).toBe(9)
  })

  it('anchors events before a snapshot to the earliest available snapshot', () => {
    const prices: Record<string, ModelPrice> = { flash: { source: 'official', single: FALLBACK_CURRENT.flash } }
    const handle = handleWith({ ...initialPricebookState(), snapshots: [snapshotFixture(1, 2_000, prices)] })
    expect(handle.priceFor('deepseek-official', 'deepseek-v4-flash', 1_000)?.snapshotVersion).toBe(1)
  })
})

describe('PricebookHandle refresh and mutation', () => {
  const fakeFetch = (body: unknown) => vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }))

  it('creates the first snapshot from injected sources and skips an unchanged refresh', async () => {
    const handle = handleWith(initialPricebookState())
    await handle.refresh({ official: OFFICIAL })
    expect(handle.currentSnapshot()?.version).toBe(1)
    expect(handle.currentSnapshot()?.prices.flash?.source).toBe('official')
    const first = handle.currentSnapshot()
    await handle.refresh({ official: OFFICIAL })
    expect(handle.currentSnapshot()).toBe(first)
    expect(handle.state.snapshots).toHaveLength(1)
  })

  it('starts a new snapshot when a price actually changes', async () => {
    const handle = handleWith(initialPricebookState())
    await handle.refresh({ official: OFFICIAL })
    const changed: CurrentPricing = {
      flash: { cacheReadPerMillion: 0.03, inputPerMillion: 1.2, outputPerMillion: 2.4 },
      pro: FALLBACK_CURRENT.pro,
    }
    await handle.refresh({ official: { ...OFFICIAL, current: changed } })
    expect(handle.state.snapshots).toHaveLength(2)
    expect(handle.currentSnapshot()?.version).toBe(2)
    expect(handle.currentSnapshot()?.prices.flash?.single?.inputPerMillion).toBe(1.2)
  })

  it('applies overrides and re-anchors a snapshot', async () => {
    const handle = handleWith(initialPricebookState())
    await handle.refresh({ official: OFFICIAL })
    await handle.setOverrides({
      'deepseek-v4-flash': { source: 'manual', single: { cacheReadPerMillion: 0.01, inputPerMillion: 0.5, outputPerMillion: 1 } },
    })
    expect(handle.state.snapshots).toHaveLength(2)
    expect(handle.currentSnapshot()?.source).toBe('manual')
    expect(handle.priceFor('deepseek-official', 'deepseek-v4-flash', Date.now())?.source).toBe('manual')
  })

  it('uses a manual fx rate and refreshes the auto rate from the fetch', async () => {
    const handle = handleWith(initialPricebookState())
    await handle.setFx('manual', 8.0)
    expect(effectiveRate(handle.state.fx, DEFAULT_FX_RATE)).toBe(8.0)
    await handle.setFx('auto', 7.2)
    vi.stubGlobal('fetch', fakeFetch({ rates: { CNY: 7.35 } }))
    try {
      await handle.refresh({ official: OFFICIAL })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(handle.state.fx.lastAutoRate).toBe(7.35)
    expect(effectiveRate(handle.state.fx, DEFAULT_FX_RATE)).toBe(7.35)
  })

  it('keeps OpenRouter prices out of the snapshot when disabled', async () => {
    const handle = handleWith({ ...initialPricebookState(), openRouterEnabled: false })
    const openrouter = { usdPrices: { 'anthropic/claude-sonnet-4': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 } } }
    await handle.refresh({ official: OFFICIAL, openrouter })
    expect(handle.currentSnapshot()?.prices['anthropic/claude-sonnet-4']).toBeUndefined()
  })

  it('applies a resolved settings section and re-anchors', async () => {
    const handle = handleWith(initialPricebookState())
    await handle.refresh({ official: OFFICIAL })
    handle.applySettings({
      overrides: { 'deepseek-v4-flash': { single: { cacheReadPerMillion: 0.01, inputPerMillion: 0.5, outputPerMillion: 1 } } },
      cacheReadDiscount: 0.4,
      fxMode: 'manual',
      manualRate: 8.0,
      balanceEnabled: false,
      openRouterEnabled: false,
    })
    expect(handle.state.snapshots).toHaveLength(2)
    expect(handle.currentSnapshot()?.source).toBe('manual')
    expect(handle.state.cacheReadDiscount).toBe(0.4)
    expect(handle.state.fx.mode).toBe('manual')
    expect(handle.state.fx.manualRate).toBe(8.0)
    expect(handle.state.balanceEnabled).toBe(false)
    expect(handle.state.openRouterEnabled).toBe(false)
    // Field-only changes persist even without a price-table move.
    handle.applySettings({ balanceEnabled: true })
    expect(handle.state.balanceEnabled).toBe(true)
  })

  it('ignores undefined settings fields and survives malformed input', () => {
    const handle = handleWith(initialPricebookState())
    handle.applySettings({ balanceEnabled: false })
    expect(handle.state.balanceEnabled).toBe(false)
    handle.applySettings({})
    expect(handle.state.balanceEnabled).toBe(false)
    expect(() => handle.applySettings({ overrides: 'nonsense' as never })).not.toThrow()
  })

  it('carries the USD pricebook its own (en) schedule and bands against it', async () => {
    const enOfficial: PricingSnapshot = {
      ...OFFICIAL,
      currency: 'USD',
      schedule: { timezone: 'UTC', ranges: [[0, 6]] as const },
    }
    const handle = new PricebookHandle({} as Context, {
      fxApiUrl: 'https://fx.invalid',
      defaultFxRate: DEFAULT_FX_RATE,
      openRouterModelsUrl: 'https://or.invalid',
      openRouterEnabled: true,
      snapshotHistoryLimit: 50,
    }, { ...initialPricebookState(), snapshots: [snapshotFixture(1, 0, { pro: { source: 'official', single: FALLBACK_CURRENT.pro, offPeak: FALLBACK_PEAK.pro.offPeak, peak: FALLBACK_PEAK.pro.peak } })] }, 'USD')
    await handle.refresh({ official: enOfficial })
    expect(handle.view().schedule).toEqual({ timezone: 'UTC', ranges: [[0, 6]] })
    // 05:30 UTC: peak under the en (UTC) schedule, off-peak under the zh default.
    const at0530 = Date.UTC(2026, 7, 17, 5, 30, 0)
    expect(handle.priceFor('deepseek-official', 'deepseek-v4-pro', at0530)?.band).toBe('peak')
    // The zh default would have said offPeak (13:30 Beijing).
    expect(bandForTime(at0530)).toBe('offPeak')
  })
})

describe('fetchFxRate / fetchOpenRouter', () => {
  it('parses rates.CNY from the free endpoint', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ rates: { USD: 1, CNY: 7.32 } }),
    }) as unknown as typeof fetch
    expect(await fetchFxRate(fetchImpl)).toEqual({ rate: 7.32 })
  })

  it('reports an error for a non-2xx or unparsable response', async () => {
    const bad = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    expect((await fetchFxRate(bad)).error).toContain('503')
    const unparsable = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch
    expect((await fetchFxRate(unparsable)).error).toContain('rates.CNY')
  })

  it('folds the OpenRouter directory into USD-per-1M buckets, keeping every priced entry', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'deepseek/deepseek-chat', pricing: { prompt: '0.14', completion: '0.28' } },
          { id: 'anthropic/claude-sonnet-4', pricing: { prompt: '3', completion: '15' } },
          { id: 'unrelated/foo', pricing: { prompt: '1', completion: '1' } },
          { id: 'broken', pricing: { prompt: 'x', completion: 'y' } },
        ],
      }),
    }) as unknown as typeof fetch
    const result = await fetchOpenRouter(fetchImpl, 'https://or.invalid', 5000, DEFAULT_ALIASES)
    expect(result.error).toBeUndefined()
    expect(result.usdPrices['deepseek/deepseek-chat']).toEqual({ inputPerMillionUsd: 140_000, outputPerMillionUsd: 280_000 })
    expect(result.usdPrices['anthropic/claude-sonnet-4']).toEqual({ inputPerMillionUsd: 3_000_000, outputPerMillionUsd: 15_000_000 })
    // Every priced entry is kept (a newly aliased model must resolve without a refresh).
    expect(result.usdPrices['unrelated/foo']).toEqual({ inputPerMillionUsd: 1_000_000, outputPerMillionUsd: 1_000_000 })
    expect(result.usdPrices.broken).toBeUndefined()
  })
})
