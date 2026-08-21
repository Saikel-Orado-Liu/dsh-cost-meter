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

import type { CurrentPricing, PeakHourRange, PeakModelPricing, PeakPricing, PeakSchedule, PriceBucket, PricingSnapshot } from './types.ts'

/** Official pricing page URL (zh-cn). */
export const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** Official pricing page URL (en). */
export const PRICING_URL_EN = 'https://api-docs.deepseek.com/quick_start/pricing/'

/** Official peak-pricing rollout: 2026-08-17 00:00 Beijing time (UTC+8). */
export const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * Built-in fallback zh peak schedule: the official announcement's windows in
 * Beijing time (peak 09:00-12:00 / 14:00-18:00, everything else off-peak).
 */
export const PEAK_SCHEDULE_ZH: PeakSchedule = {
  timezone: 'Asia/Shanghai',
  ranges: [[9, 12], [14, 18]],
}

/**
 * Built-in fallback en peak schedule. Kept as a separate constant from the zh
 * schedule because the English pricing page may state different windows or a
 * different timezone; each pricebook parses its own page and falls back to
 * this locale-matched default only when the page carries no schedule.
 */
export const PEAK_SCHEDULE_EN: PeakSchedule = {
  timezone: 'Asia/Shanghai',
  ranges: [[9, 12], [14, 18]],
}

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

/** Every CNY price in a cell run, in document order. */
function priceValues(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*元/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/** Every USD price in a cell run, in document order. */
function priceValuesUsd(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(/\$?\s*(\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1])
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}

/** The result of parsing one locale's pricing table(s). */
interface LocalePricing {
  /** The current page's list prices: legacy single-price cells, or the off-peak cells of the combined table. */
  current: CurrentPricing
  /** Peak/off-peak table when the page carried one. */
  peak?: PeakPricing
  /** The separate pre-rollout single-price table, when the page still carried it. */
  legacyCurrent?: CurrentPricing
}

/** One bucket row's parsed cells. */
interface BucketCells {
  cacheRead: number[]
  input: number[]
  output: number[]
}

/** Build the `column`-th model bucket from three bucket rows. */
function bucketAt(cells: BucketCells, column: number): PriceBucket {
  return {
    cacheReadPerMillion: cells.cacheRead[column]!,
    inputPerMillion: cells.input[column]!,
    outputPerMillion: cells.output[column]!,
  }
}

/** Build the current list (flash, pro, and vision when present). */
function currentAt(cells: BucketCells, columns: number): CurrentPricing {
  return {
    flash: bucketAt(cells, 0),
    pro: bucketAt(cells, 1),
    ...(columns > 2 ? { vision: bucketAt(cells, 2) } : {}),
  }
}

/** Build the peak/off-peak pair for the `column`-th model. */
function peakAt(offPeakCells: BucketCells, peakCells: BucketCells, column: number): PeakModelPricing {
  return {
    offPeak: bucketAt(offPeakCells, column),
    peak: bucketAt(peakCells, column),
  }
}

/** Build the peak table (flash, pro, and vision when present). */
function peakPricingAt(offPeakCells: BucketCells, peakCells: BucketCells, columns: number): PeakPricing {
  return {
    flash: peakAt(offPeakCells, peakCells, 0),
    pro: peakAt(offPeakCells, peakCells, 1),
    ...(columns > 2 ? { vision: peakAt(offPeakCells, peakCells, 2) } : {}),
  }
}

/** Three bucket-row runs of the Chinese pricing table, when present. */
const ZH_PRICING_SEGMENTS_RE = /百万tokens输入\s*[（(]\s*缓存命中\s*[）)]\s*([\s\S]*?)百万tokens输入\s*[（(]\s*缓存未命中\s*[）)]\s*([\s\S]*?)百万tokens输出\s*([\s\S]*?)(?:并发限制|扣费规则|$)/i

/**
 * Parse the Chinese pricing table(s). The 2026-08-21 page carries one
 * combined table — bucket rows whose cells are OFF-PEAK × 3 models then
 * PEAK × 3 models — while the earlier page carried a separate legacy
 * single-price table plus a model-row peak table.
 * @param html - the raw Chinese pricing page.
 * @returns the parsed table(s), or undefined when the bucket labels are absent.
 */
function parseZhPricing(html: string): LocalePricing | undefined {
  const text = stripHtml(html)
  const hit = ZH_PRICING_SEGMENTS_RE.exec(text)
  if (hit === null) return undefined
  const rows = [hit[1] ?? '', hit[2] ?? '', hit[3] ?? '']

  const hasBands = rows.every(row => /空闲时段/.test(row) && /高峰时段/.test(row))
  if (hasBands) {
    const offPeakRows = rows.map(row => {
      const values = priceValues(row)
      if (values.length !== 4 && values.length !== 6) return undefined
      return values.slice(0, values.length / 2)
    })
    const peakRows = rows.map(row => {
      const values = priceValues(row)
      if (values.length !== 4 && values.length !== 6) return undefined
      return values.slice(values.length / 2)
    })
    if (offPeakRows.some(row => row === undefined) || peakRows.some(row => row === undefined)) return undefined
    const columns = offPeakRows[0]!.length
    if (offPeakRows.some(row => row!.length !== columns)) return undefined
    const offPeakCells: BucketCells = {
      cacheRead: offPeakRows[0]!,
      input: offPeakRows[1]!,
      output: offPeakRows[2]!,
    }
    const peakCells: BucketCells = {
      cacheRead: peakRows[0]!,
      input: peakRows[1]!,
      output: peakRows[2]!,
    }
    return {
      current: currentAt(offPeakCells, columns),
      peak: peakPricingAt(offPeakCells, peakCells, columns),
    }
  }

  const currentRows = rows.map(priceValues)
  const columns = currentRows[0]?.length
  if (columns !== 2 && columns !== 3) return undefined
  if (currentRows.some(row => row.length !== columns)) return undefined
  const cells: BucketCells = {
    cacheRead: currentRows[0]!,
    input: currentRows[1]!,
    output: currentRows[2]!,
  }
  const current = currentAt(cells, columns)
  return { current, legacyCurrent: current }
}

/**
 * Parse the legacy Chinese peak-pricing table: model rows with off-peak and
 * peak cells, e.g. `deepseek-v4-flash 空闲时段 0.05 1.5 4.5 高峰时段 0.10 3.0 9.0`.
 * @param text - the stripped pricing page.
 * @returns the parsed table, or undefined when either model row is absent.
 */
function parseLegacyPeakTableZh(text: string): PeakPricing | undefined {
  const flash = /deepseek-v4-flash\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/i.exec(text)
  const pro = /deepseek-v4-pro\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/i.exec(text)
  if (flash === null || pro === null) return undefined
  const model = (row: RegExpExecArray): PeakModelPricing => ({
    offPeak: {
      cacheReadPerMillion: Number(row[1]),
      inputPerMillion: Number(row[2]),
      outputPerMillion: Number(row[3]),
    },
    peak: {
      cacheReadPerMillion: Number(row[4]),
      inputPerMillion: Number(row[5]),
      outputPerMillion: Number(row[6]),
    },
  })
  const vision = /deepseek-v4-flash-vision-exp\s+空闲时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+高峰时段\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元\s+(\d+(?:\.\d+)?)元/i.exec(text)
  return {
    flash: model(flash),
    pro: model(pro),
    ...(vision === null ? {} : { vision: model(vision) }),
  }
}

/**
 * Parse the Chinese current single-price table: three rows labeled with the
 * bucket names, each carrying the model price cells (2 columns before
 * 2026-08-21, 3 columns afterwards — on the combined page these are the
 * off-peak cells).
 * @param html - the raw pricing page.
 * @returns the parsed table, or undefined when the labels are absent.
 */
export function parseCurrentTable(html: string): CurrentPricing | undefined {
  return parseZhPricing(html)?.current
}

/**
 * Parse the Chinese peak-pricing table: either the PEAK cells of the
 * 2026-08-21 combined table, or the earlier separate model-row table.
 * @param html - the raw pricing page.
 * @returns the parsed table, or undefined when neither peak table is present.
 */
export function parsePeakTable(html: string): PeakPricing | undefined {
  const combined = parseZhPricing(html)
  return combined?.peak ?? parseLegacyPeakTableZh(stripHtml(html))
}

/** Three bucket-row runs of the English pricing table, when present. */
const EN_PRICING_SEGMENTS_RE = /1M\s+INPUT\s+TOKENS\s*[（(]?\s*CACHE\s+HIT\s*[）)]?\s*([\s\S]*?)1M\s+INPUT\s+TOKENS\s*[（(]?\s*CACHE\s+MISS\s*[）)]?\s*([\s\S]*?)1M\s+OUTPUT\s+TOKENS\s*([\s\S]*?)(?:Concurrency\s+Limit|Deduction\s+Rules|$)/i

/**
 * Parse the English pricing table(s). The 2026-08-21 page lists all three
 * buckets as rows with OFF-PEAK and PEAK cells (2 model columns before the
 * update, 3 afterwards); earlier pages carried a plain single-price table.
 */
function parseEnglishPricing(html: string): LocalePricing | undefined {
  const text = stripHtml(html)
  const hit = EN_PRICING_SEGMENTS_RE.exec(text)
  if (hit === null) return undefined
  const rows = [hit[1] ?? '', hit[2] ?? '', hit[3] ?? '']

  const hasBands = rows.every(row =>
    /\bOFF-PEAK\b/i.test(row) && /(?:^|\s)PEAK(?:\s|$)/i.test(row))
  if (hasBands) {
    const offPeakRows = rows.map(row => {
      const values = priceValuesUsd(row)
      if (values.length !== 4 && values.length !== 6) return undefined
      return values.slice(0, values.length / 2)
    })
    const peakRows = rows.map(row => {
      const values = priceValuesUsd(row)
      if (values.length !== 4 && values.length !== 6) return undefined
      return values.slice(values.length / 2)
    })
    if (offPeakRows.some(row => row === undefined) || peakRows.some(row => row === undefined)) return undefined
    const columns = offPeakRows[0]!.length
    if (offPeakRows.some(row => row!.length !== columns)) return undefined
    const offPeakCells: BucketCells = {
      cacheRead: offPeakRows[0]!,
      input: offPeakRows[1]!,
      output: offPeakRows[2]!,
    }
    const peakCells: BucketCells = {
      cacheRead: peakRows[0]!,
      input: peakRows[1]!,
      output: peakRows[2]!,
    }
    return {
      current: currentAt(offPeakCells, columns),
      peak: peakPricingAt(offPeakCells, peakCells, columns),
    }
  }

  const currentRows = rows.map(priceValuesUsd)
  const columns = currentRows[0]?.length
  if (columns !== 2 && columns !== 3) return undefined
  if (currentRows.some(row => row.length !== columns)) return undefined
  const cells: BucketCells = {
    cacheRead: currentRows[0]!,
    input: currentRows[1]!,
    output: currentRows[2]!,
  }
  const current = currentAt(cells, columns)
  return { current, legacyCurrent: current }
}

/**
 * Parse the English current single-price table (or the off-peak cells of the
 * combined table).
 * @param html - the raw English pricing page.
 * @returns the parsed table, or undefined when the labels are absent.
 */
export function parseCurrentTableEn(html: string): CurrentPricing | undefined {
  return parseEnglishPricing(html)?.current
}

/**
 * Parse the English peak-pricing table.
 * @param html - the raw English pricing page.
 * @returns the parsed table, or undefined when either model row is absent.
 */
export function parsePeakTableEn(html: string): PeakPricing | undefined {
  return parseEnglishPricing(html)?.peak
}

/** Two `HH:MM-HH:MM` windows (the second one after a separator). */
const SCHEDULE_WINDOWS_RE = /(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})\s*(?:[、,，;]\s*)?(?:and\s*)?(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/i

/**
 * Parse the peak-hour schedule from a pricing page: the two half-open
 * windows next to the localized peak label (`高峰时段` / `peak hours`), plus
 * the timezone the windows are expressed in. The Chinese page states Beijing
 * time; the English page may state Beijing time or UTC — a Beijing/UTC+8
 * mention wins, a bare UTC mention selects UTC, anything else defaults to
 * Beijing time.
 * @param html - the raw pricing page.
 * @param locale - which page's wording to look for.
 * @returns the parsed schedule, or undefined when the page carries none.
 */
export function parsePeakSchedule(html: string, locale: 'zh' | 'en' = 'zh'): PeakSchedule | undefined {
  const text = stripHtml(html)
  // The pricing table itself repeats `高峰时段` as a band label, so the zh
  // search targets the schedule sentence (the label followed by a time).
  const labelMatch = locale === 'zh'
    ? /高峰时段[^。]{0,160}?\d{1,2}:\d{2}/i.exec(text)
    : /peak\s*hours?/i.exec(text)
  if (labelMatch === null) return undefined
  const window = text.slice(labelMatch.index, labelMatch.index + 220)
  const match = SCHEDULE_WINDOWS_RE.exec(window)
  if (match === null) return undefined
  const ranges: PeakHourRange[] = [
    [Number(match[1]), Number(match[3])],
    [Number(match[5]), Number(match[7])],
  ]
  if (ranges.some(([start, end]) =>
    !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end)) {
    return undefined
  }
  if (/\b(?:beijing|北京时间|china standard)\b/i.test(window) || /\butc\s*\+\s*8\b/i.test(window)) {
    return { timezone: 'Asia/Shanghai', ranges }
  }
  if (/\butc\b/i.test(window)) {
    return { timezone: 'UTC', ranges }
  }
  return { timezone: 'Asia/Shanghai', ranges }
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
  const fallbackCurrent = locale === 'en' ? FALLBACK_CURRENT_USD : FALLBACK_CURRENT
  const fallbackPeak = locale === 'en' ? FALLBACK_PEAK_USD : FALLBACK_PEAK
  const fallbackSchedule = locale === 'en' ? PEAK_SCHEDULE_EN : PEAK_SCHEDULE_ZH
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
      return { fetchedAt, currency, current: fallbackCurrent, peakActive: false, effective: fallbackCurrent, schedule: fallbackSchedule, error: `pricing page HTTP ${response.status}` }
    }
    const html = await response.text()
    const parsed = locale === 'en' ? parseEnglishPricing(html) : parseZhPricing(html)
    if (parsed === undefined) {
      return { fetchedAt, currency, current: fallbackCurrent, peakActive: false, effective: fallbackCurrent, schedule: fallbackSchedule, error: 'pricing table not found' }
    }
    const peak = parsed.peak ?? (locale === 'en' ? parsePeakTableEn(html) : parsePeakTable(html))
    const { current, legacyCurrent } = parsed
    const schedule = parsePeakSchedule(html, locale) ?? fallbackSchedule
    const now = Date.now()
    const peakActive = now >= PEAK_PRICING_START_MS
    return {
      fetchedAt,
      currency,
      current,
      ...(legacyCurrent === undefined ? {} : { legacyCurrent }),
      ...(peak === undefined ? {} : { peak }),
      peakActive,
      effective: effectivePricing(current, peak, peakActive, new Date(now), schedule),
      ...(peakActive ? { band: isPeakHour(new Date(now), schedule) ? 'peak' : 'offPeak' } : {}),
      schedule,
    }
  } catch (error) {
    return {
      fetchedAt,
      currency,
      current: fallbackCurrent,
      peakActive: false,
      effective: fallbackCurrent,
      schedule: fallbackSchedule,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Whether the given instant is a peak-pricing hour under one schedule: the
 * zh fallback is Beijing time 09:00-12:00 and 14:00-18:00; each pricebook
 * passes the schedule parsed from its own (zh or en) pricing page.
 * @param now - the instant to classify.
 * @param schedule - the peak-hour schedule to classify against.
 * @returns true during peak hours.
 */
export function isPeakHour(now: Date = new Date(), schedule: PeakSchedule = PEAK_SCHEDULE_ZH): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now)
  const hour = Number(parts.find(part => part.type === 'hour')?.value)
  if (Number.isNaN(hour)) return false
  return schedule.ranges.some(([start, end]) => hour >= start && hour < end)
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
 * @param schedule - the peak-hour schedule to classify against.
 * @returns the bucket to apply.
 */
export function effectiveBucket(
  current: CurrentPricing,
  peak: PeakPricing | undefined,
  peakActive: boolean,
  now: Date,
  model: 'flash' | 'pro',
  schedule: PeakSchedule = PEAK_SCHEDULE_ZH,
): PriceBucket {
  if (peakActive) {
    const table = peak?.[model] ?? FALLBACK_PEAK[model]
    return isPeakHour(now, schedule) ? table.peak : table.offPeak
  }
  return current[model]
}

/** Per-model effective prices at the given moment. */
export function effectivePricing(
  current: CurrentPricing,
  peak: PeakPricing | undefined,
  peakActive: boolean,
  now: Date,
  schedule: PeakSchedule = PEAK_SCHEDULE_ZH,
): CurrentPricing {
  return {
    flash: effectiveBucket(current, peak, peakActive, now, 'flash', schedule),
    pro: effectiveBucket(current, peak, peakActive, now, 'pro', schedule),
  }
}