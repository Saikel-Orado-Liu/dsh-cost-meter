/**
 * Official DeepSeek pricing: fetches the pricing page
 * (api-docs.deepseek.com/zh-cn/quick_start/pricing/) and parses both the
 * current list prices and the upcoming peak/off-peak table, so price changes
 * and the 2026-08-17 peak-pricing rollout never require a plugin update.
 *
 * The parser is deliberately tolerant: it matches price cells next to the
 * bucket labels and model names anywhere in the HTML, so reordering or
 * rewording still yields values when the numbers are present; failures
 * degrade to the built-in presets rather than throwing.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/pricing
 */

import type { CurrentPricing, PeakPricing, PriceBucket, PricingSnapshot } from './types.ts'

/** Official pricing page URL (zh-cn). */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** Official pricing page URL (en). */
export const PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing/'

/** Official peak-pricing rollout: 2026-08-17 00:00 Beijing time (UTC+8). */
export const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * Built-in fallback prices: the official list for deepseek-v4-flash and
 * deepseek-v4-pro (CNY per 1M tokens). DeepSeek bills cache writes at the
 * uncached input price (its wire usage reports only cache-hit vs cache-miss
 * buckets), so no separate cache-write rate exists.
 */
export const FALLBACK_CURRENT: CurrentPricing = {
  flash: { cacheReadPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 2 },
  pro: { cacheReadPerMillion: 0.025, inputPerMillion: 3, outputPerMillion: 6 },
}

/**
 * Built-in fallback for the upcoming peak table: the 2026-08-17 schedule
 * (peak hours double the off-peak half).
 */
export const FALLBACK_PEAK: PeakPricing = {
  flash: {
    offPeak: { cacheReadPerMillion: 0.05, inputPerMillion: 1.5, outputPerMillion: 4.5 },
    peak: { cacheReadPerMillion: 0.1, inputPerMillion: 3, outputPerMillion: 9 },
  },
  pro: {
    offPeak: { cacheReadPerMillion: 0.15, inputPerMillion: 4.5, outputPerMillion: 13.5 },
    peak: { cacheReadPerMillion: 0.3, inputPerMillion: 9, outputPerMillion: 27 },
  },
}

/** Built-in fallback USD prices from the English pricing page. */
export const FALLBACK_CURRENT_USD: CurrentPricing = {
  flash: { cacheReadPerMillion: 0.007, inputPerMillion: 0.22, outputPerMillion: 0.66 },
  pro: { cacheReadPerMillion: 0.022, inputPerMillion: 0.66, outputPerMillion: 1.98 },
}

/** Built-in fallback USD peak table from the English pricing page. */
export const FALLBACK_PEAK_USD: PeakPricing = {
  flash: {
    offPeak: { ...FALLBACK_CURRENT_USD.flash },
    peak: { cacheReadPerMillion: 0.014, inputPerMillion: 0.44, outputPerMillion: 1.32 },
  },
  pro: {
    offPeak: { ...FALLBACK_CURRENT_USD.pro },
    peak: { cacheReadPerMillion: 0.044, inputPerMillion: 1.32, outputPerMillion: 3.96 },
  },
}

/** Number regex: `0.02`, `1`, `2`, `3.0` etc. Deliberately non-global: a
 * shared global regex leaks `lastIndex` across `exec` calls and would skip
 * the second price cell (the pro price). */
const PRICE_RE = /(\d+(?:\.\d+)?)\s*元/

/** English price regex: matches `$0.02`, `$0.002`, `0.02` etc. */
const PRICE_RE_EN = /\$?\s*(\d+(?:\.\d+)?)/

/** Strip HTML tags to plain text (keeps cell order). */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse one price cell text like `0.02元` into a number; undefined when absent. */
function parsePriceCell(text: string): number | undefined {
  const match = PRICE_RE.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** The second price cell of a row (the pro price), stripped of the first. */

/** Parse one English price cell text like `$0.02` into a number. */
function parsePriceCellUsd(text: string): number | undefined {
  const match = PRICE_RE_EN.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** The second price cell of an English row, stripped of the first. */
function secondPriceCellUsd(text: string): string {
  return text.replace(/^\s*\$?\s*(\d+(?:\.\d+)?)/, '')
}
function secondPriceCell(text: string): string {
  return text.replace(/^\s*(\d+(?:\.\d+)?元)/, '')
}

/**
 * Parse the current single-price table: three rows labeled with the bucket
 * names, each carrying the flash and pro price cells.
 * @param html - the raw pricing page.
 * @returns the parsed table, or undefined when the labels are absent.
 */
export function parseCurrentTable(html: string): CurrentPricing | undefined {
  const hit = /百万tokens输入（缓存命中）([\s\S]{0,400}?)百万tokens输入（缓存未命中）([\s\S]{0,400}?)百万tokens输出([\s\S]{0,400}?)(?:并发限制|<\/table)/i.exec(stripHtml(html))
  if (hit === null) return undefined
  const cacheReadCell = hit[1] ?? ''
  const inputCell = hit[2] ?? ''
  const outputCell = hit[3] ?? ''
  const cacheReadFlash = parsePriceCell(cacheReadCell)
  const cacheReadPro = parsePriceCell(secondPriceCell(cacheReadCell))
  const inputFlash = parsePriceCell(inputCell)
  const inputPro = parsePriceCell(secondPriceCell(inputCell))
  const outputFlash = parsePriceCell(outputCell)
  const outputPro = parsePriceCell(secondPriceCell(outputCell))
  if (cacheReadFlash === undefined || inputFlash === undefined || outputFlash === undefined) {
    return undefined
  }
  return {
    flash: {
      cacheReadPerMillion: cacheReadFlash,
      inputPerMillion: inputFlash,
      outputPerMillion: outputFlash,
    },
    pro: {
      cacheReadPerMillion: cacheReadPro ?? cacheReadFlash,
      inputPerMillion: inputPro ?? inputFlash,
      outputPerMillion: outputPro ?? outputFlash,
    },
  }
}

/**
 * Parse the upcoming peak-pricing table: model rows with off-peak and peak
 * cells, e.g. `deepseek-v4-flash 空闲时段 0.05 1.5 4.5 高峰时段 0.10 3.0 9.0`.
 * @param html - the raw pricing page.
 * @returns the parsed table, or undefined when either model row is absent.
 */
export function parsePeakTable(html: string): PeakPricing | undefined {
  const text = stripHtml(html)
  const flash = /deepseek-v4-flash\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/i.exec(text)
  const pro = /deepseek-v4-pro\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/i.exec(text)
  if (flash === null || pro === null) return undefined
  return {
    flash: {
      offPeak: {
        cacheReadPerMillion: Number(flash[1]),
        inputPerMillion: Number(flash[2]),
        outputPerMillion: Number(flash[3]),
      },
      peak: {
        cacheReadPerMillion: Number(flash[4]),
        inputPerMillion: Number(flash[5]),
        outputPerMillion: Number(flash[6]),
      },
    },
    pro: {
      offPeak: {
        cacheReadPerMillion: Number(pro[1]),
        inputPerMillion: Number(pro[2]),
        outputPerMillion: Number(pro[3]),
      },
      peak: {
        cacheReadPerMillion: Number(pro[4]),
        inputPerMillion: Number(pro[5]),
        outputPerMillion: Number(pro[6]),
      },
    },
  }
}

/**
 * Parse the English current single-price table.
 * @param html - the raw English pricing page.
 * @returns the parsed table, or undefined when the labels are absent.
 */
/**
 * Parse the English combined pricing table. The English page lists all three
 * buckets as rows with OFF-PEAK and PEAK cells, so we extract both the current
 * off-peak list and the peak table from the same markup.
 */
function parseEnglishPricing(html: string): { current: CurrentPricing; peak: PeakPricing } | undefined {
  const text = stripHtml(html)
  const hit = /1M INPUT TOKENS \(CACHE HIT\)\s+OFF-PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)\s+PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)\s+1M INPUT TOKENS \(CACHE MISS\)\s+OFF-PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)\s+PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)\s+1M OUTPUT TOKENS\s+OFF-PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)\s+PEAK\s+\$?\s*(\d+(?:\.\d+)?)\s+\$?\s*(\d+(?:\.\d+)?)/i.exec(text)
  if (hit === null) return undefined
  const n = (index: number): number => Number(hit[index])
  const current: CurrentPricing = {
    flash: {
      cacheReadPerMillion: n(1),
      inputPerMillion: n(5),
      outputPerMillion: n(9),
    },
    pro: {
      cacheReadPerMillion: n(2),
      inputPerMillion: n(6),
      outputPerMillion: n(10),
    },
  }
  const peak: PeakPricing = {
    flash: {
      offPeak: {
        cacheReadPerMillion: n(1),
        inputPerMillion: n(5),
        outputPerMillion: n(9),
      },
      peak: {
        cacheReadPerMillion: n(3),
        inputPerMillion: n(7),
        outputPerMillion: n(11),
      },
    },
    pro: {
      offPeak: {
        cacheReadPerMillion: n(2),
        inputPerMillion: n(6),
        outputPerMillion: n(10),
      },
      peak: {
        cacheReadPerMillion: n(4),
        inputPerMillion: n(8),
        outputPerMillion: n(12),
      },
    },
  }
  return { current, peak }
}

/**
 * Parse the English current single-price table.
 * @param html - the raw English pricing page.
 * @returns the parsed table, or undefined when the labels are absent.
 */
export function parseCurrentTableEn(html: string): CurrentPricing | undefined {
  return parseEnglishPricing(html)?.current
}

/**
 * Parse the English upcoming peak-pricing table.
 * @param html - the raw English pricing page.
 * @returns the parsed table, or undefined when either model row is absent.
 */
export function parsePeakTableEn(html: string): PeakPricing | undefined {
  return parseEnglishPricing(html)?.peak
}

/**
 * Fetch and parse the official pricing page.
 * @param fetchImpl - fetch-compatible function (injected for testability).
 * @param timeoutMs - abort timeout.
 * @returns the parsed snapshot; `error` is set when fetch/parse failed.
 */
export async function fetchPricing(
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 15_000,
  locale: 'zh' | 'en' = 'zh',
): Promise<PricingSnapshot> {
  const fetchedAt = Date.now()
  const currency = locale === 'en' ? 'USD' : 'CNY'
  const url = locale === 'en' ? PRICING_URL_EN : PRICING_URL
  const parseCurrent = locale === 'en' ? parseCurrentTableEn : parseCurrentTable
  const parsePeak = locale === 'en' ? parsePeakTableEn : parsePeakTable
  const fallbackCurrent = locale === 'en' ? FALLBACK_CURRENT_USD : FALLBACK_CURRENT
  const fallbackPeak = locale === 'en' ? FALLBACK_PEAK_USD : FALLBACK_PEAK
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      return { fetchedAt, currency, current: fallbackCurrent, peakActive: false, effective: fallbackCurrent, error: `pricing page HTTP ${response.status}` }
    }
    const html = await response.text()
    const current = parseCurrent(html)
    if (current === undefined) {
      return { fetchedAt, currency, current: fallbackCurrent, peakActive: false, effective: fallbackCurrent, error: 'pricing table not found' }
    }
    const peak = parsePeak(html)
    const now = Date.now()
    const peakActive = now >= PEAK_PRICING_START_MS
    return {
      fetchedAt,
      currency,
      current,
      ...(peak === undefined ? {} : { peak }),
      peakActive,
      effective: effectivePricing(current, peak, peakActive, new Date(now)),
      ...(peakActive ? { band: isPeakHour(new Date(now)) ? 'peak' : 'offPeak' } : {}),
    }
  } catch (error) {
    return {
      fetchedAt,
      currency,
      current: fallbackCurrent,
      peakActive: false,
      effective: fallbackCurrent,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Whether the current moment is a peak-pricing hour in Beijing time:
 * 09:00-12:00 and 14:00-18:00 (peak); everything else is off-peak.
 * @param now - the instant to classify.
 * @returns true during peak hours.
 */
export function isPeakHour(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  if (Number.isNaN(hour)) return false
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * The price bucket in effect for one model at the given moment: the
 * peak/off-peak band once the rollout is live (with the parsed table, or the
 * built-in fallback), otherwise the current official list.
 * @param current - the current list prices.
 * @param peak - the upcoming peak table, when parsed.
 * @param peakActive - whether the rollout has started.
 * @param now - the instant to price for.
 * @param model - `flash` or `pro`.
 * @returns the bucket to apply.
 */
export function effectiveBucket(
  current: CurrentPricing,
  peak: PeakPricing | undefined,
  peakActive: boolean,
  now: Date,
  model: keyof CurrentPricing,
): PriceBucket {
  if (peakActive) {
    const table = peak?.[model] ?? FALLBACK_PEAK[model]
    return isPeakHour(now) ? table.peak : table.offPeak
  }
  return current[model]
}

/** Per-model effective prices at the given moment. */
export function effectivePricing(
  current: CurrentPricing,
  peak: PeakPricing | undefined,
  peakActive: boolean,
  now: Date,
): CurrentPricing {
  return {
    flash: effectiveBucket(current, peak, peakActive, now, 'flash'),
    pro: effectiveBucket(current, peak, peakActive, now, 'pro'),
  }
}