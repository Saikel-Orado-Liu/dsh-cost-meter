/**
 * Pricing-parser and band-selection coverage: current-table and peak-table
 * parsing from real page markup, fallback on failure, Beijing-hour band
 * classification, and the effective bucket selection around the rollout.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  effectiveBucket,
  FALLBACK_CURRENT,
  FALLBACK_CURRENT_USD,
  fetchPricing,
  isPeakHour,
  parseCurrentTable,
  parseCurrentTableEn,
  parsePeakTable,
  parsePeakTableEn,
  PRICING_URL_EN,
} from '../src/pricing.ts'

/** Real markup captured from api-docs.deepseek.com (2026-08-14). */
const PAGE_HTML = `
<html><body>
<h1>模型 &amp; 价格</h1>
<table>
<tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr>
<tr><td>百万tokens输入（缓存未命中）</td><td>1元</td><td>3元</td></tr>
<tr><td>百万tokens输出</td><td>2元</td><td>6元</td></tr>
<tr><td>并发限制</td><td>2500</td><td>500</td></tr>
</table>
<h2>新价格</h2>
<table>
<tr><td>deepseek-v4-flash</td><td>空闲时段</td><td>0.05元</td><td>1.5元</td><td>4.5元</td><td>高峰时段</td><td>0.10元</td><td>3.0元</td><td>9.0元</td></tr>
<tr><td>deepseek-v4-pro</td><td>空闲时段</td><td>0.15元</td><td>4.5元</td><td>13.5元</td><td>高峰时段</td><td>0.30元</td><td>9.0元</td><td>27.0元</td></tr>
</table>
</body></html>
`

/** English markup captured from api-docs.deepseek.com (2026-08-17). */
const PAGE_HTML_EN = `
<html><body>
<h1>Models &amp; Pricing</h1>
<table>
<tr><td colspan="3">PRICING</td><td>OFF-PEAK</td><td>PEAK</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.007</td><td>$0.022</td></tr>
<tr><td>PEAK</td><td>$0.014</td><td>$0.044</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.22</td><td>$0.66</td></tr>
<tr><td>PEAK</td><td>$0.44</td><td>$1.32</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.66</td><td>$1.98</td></tr>
<tr><td>PEAK</td><td>$1.32</td><td>$3.96</td></tr>
</table>
</body></html>
`

describe('parseCurrentTable', () => {
  it('parses the flash and pro price cells of the current table', () => {
    const parsed = parseCurrentTable(PAGE_HTML)
    expect(parsed).toEqual({
      flash: { cacheReadPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 2 },
      pro: { cacheReadPerMillion: 0.025, inputPerMillion: 3, outputPerMillion: 6 },
    })
  })

  it('returns undefined when the bucket labels are absent', () => {
    expect(parseCurrentTable('<html>nothing here</html>')).toBeUndefined()
  })
})

describe('parsePeakTable', () => {
  it('parses the off-peak and peak cells for both models', () => {
    const parsed = parsePeakTable(PAGE_HTML)
    expect(parsed).toEqual({
      flash: {
        offPeak: { cacheReadPerMillion: 0.05, inputPerMillion: 1.5, outputPerMillion: 4.5 },
        peak: { cacheReadPerMillion: 0.1, inputPerMillion: 3, outputPerMillion: 9 },
      },
      pro: {
        offPeak: { cacheReadPerMillion: 0.15, inputPerMillion: 4.5, outputPerMillion: 13.5 },
        peak: { cacheReadPerMillion: 0.3, inputPerMillion: 9, outputPerMillion: 27 },
      },
    })
  })

  it('returns undefined when either model row is missing', () => {
    expect(parsePeakTable('<html>deepseek-v4-flash 空闲时段 0.05元 1.5元 4.5元</html>')).toBeUndefined()
  })
})

describe('parseCurrentTableEn', () => {
  it('parses USD price cells from the English current table', () => {
    const parsed = parseCurrentTableEn(PAGE_HTML_EN)
    expect(parsed).toEqual({
      flash: { cacheReadPerMillion: 0.007, inputPerMillion: 0.22, outputPerMillion: 0.66 },
      pro: { cacheReadPerMillion: 0.022, inputPerMillion: 0.66, outputPerMillion: 1.98 },
    })
  })
})

describe('parsePeakTableEn', () => {
  it('parses USD off-peak/peak cells from the English peak table', () => {
    const parsed = parsePeakTableEn(PAGE_HTML_EN)
    expect(parsed).toEqual({
      flash: {
        offPeak: { cacheReadPerMillion: 0.007, inputPerMillion: 0.22, outputPerMillion: 0.66 },
        peak: { cacheReadPerMillion: 0.014, inputPerMillion: 0.44, outputPerMillion: 1.32 },
      },
      pro: {
        offPeak: { cacheReadPerMillion: 0.022, inputPerMillion: 0.66, outputPerMillion: 1.98 },
        peak: { cacheReadPerMillion: 0.044, inputPerMillion: 1.32, outputPerMillion: 3.96 },
      },
    })
  })
})

describe('fetchPricing', () => {
  it('folds a healthy page into a snapshot with effective prices', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => PAGE_HTML,
    }) as unknown as typeof fetch
    const snapshot = await fetchPricing(fetchImpl)
    expect(snapshot.current.flash).toEqual(FALLBACK_CURRENT.flash)
    expect(snapshot.peak?.pro.peak.outputPerMillion).toBe(27)
    expect(snapshot.error).toBeUndefined()
  })

  it('folds the English page into a USD snapshot when locale is en', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => PAGE_HTML_EN,
    }) as unknown as typeof fetch)
    const snapshot = await fetchPricing(fetchImpl, 15_000, 'en')
    expect(snapshot.currency).toBe('USD')
    expect(snapshot.current.flash.inputPerMillion).toBe(0.22)
    expect(snapshot.peak?.flash.peak.inputPerMillion).toBe(0.44)
    expect(fetchImpl).toHaveBeenCalledWith(PRICING_URL_EN, expect.anything())
  })

  it('degrades to the built-in list when the page is unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const snapshot = await fetchPricing(fetchImpl)
    expect(snapshot.current).toEqual(FALLBACK_CURRENT)
    expect(snapshot.error).toContain('ECONNREFUSED')
  })

  it('uses the USD built-in fallback when the English page is unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const snapshot = await fetchPricing(fetchImpl, 15_000, 'en')
    expect(snapshot.currency).toBe('USD')
    expect(snapshot.current).toEqual(FALLBACK_CURRENT_USD)
    expect(snapshot.error).toContain('ECONNREFUSED')
  })

  it('degrades to the built-in list when the table is unparsable', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>no prices here</html>',
    }) as unknown as typeof fetch
    const snapshot = await fetchPricing(fetchImpl)
    expect(snapshot.current).toEqual(FALLBACK_CURRENT)
    expect(snapshot.error).toBe('pricing table not found')
  })
})

describe('isPeakHour', () => {
  const at = (hour: number): Date => new Date(Date.UTC(2026, 7, 17, hour - 8, 0, 0)) // Beijing = UTC+8

  it('classifies 09:00-12:00 and 14:00-18:00 Beijing as peak', () => {
    expect(isPeakHour(at(9))).toBe(true)
    expect(isPeakHour(at(11))).toBe(true)
    expect(isPeakHour(at(14))).toBe(true)
    expect(isPeakHour(at(17))).toBe(true)
  })

  it('classifies everything else as off-peak', () => {
    expect(isPeakHour(at(8))).toBe(false)
    expect(isPeakHour(at(12))).toBe(false)
    expect(isPeakHour(at(13))).toBe(false)
    expect(isPeakHour(at(18))).toBe(false)
    expect(isPeakHour(at(23))).toBe(false)
  })
})

describe('effectiveBucket', () => {
  const peak = {
    flash: {
      offPeak: { cacheReadPerMillion: 0.05, inputPerMillion: 1.5, outputPerMillion: 4.5 },
      peak: { cacheReadPerMillion: 0.1, inputPerMillion: 3, outputPerMillion: 9 },
    },
    pro: {
      offPeak: { cacheReadPerMillion: 0.15, inputPerMillion: 4.5, outputPerMillion: 13.5 },
      peak: { cacheReadPerMillion: 0.3, inputPerMillion: 9, outputPerMillion: 27 },
    },
  }
  const at = (hour: number): Date => new Date(Date.UTC(2026, 7, 17, hour - 8, 0, 0))
  const noon = new Date(Date.UTC(2026, 7, 10, 4, 0, 0)) // 2026-08-10 12:00 Beijing

  it('uses the current list before the rollout', () => {
    expect(effectiveBucket(FALLBACK_CURRENT, peak, false, noon, 'flash')).toEqual(FALLBACK_CURRENT.flash)
  })

  it('applies the peak band during peak hours after the rollout', () => {
    expect(effectiveBucket(FALLBACK_CURRENT, peak, true, at(10), 'flash')).toEqual(peak.flash.peak)
  })

  it('applies the off-peak band outside peak hours after the rollout', () => {
    expect(effectiveBucket(FALLBACK_CURRENT, peak, true, at(20), 'pro')).toEqual(peak.pro.offPeak)
  })

  it('falls back to the built-in peak table when the page carried none', () => {
    expect(effectiveBucket(FALLBACK_CURRENT, undefined, true, at(10), 'flash').inputPerMillion).toBe(3)
    expect(effectiveBucket(FALLBACK_CURRENT, undefined, true, at(20), 'flash').inputPerMillion).toBe(1.5)
  })
});