/**
 * Pricing-parser and band-selection coverage: current-table and peak-table
 * parsing from real page markup, fallback on failure, Beijing-hour band
 * classification, and the effective bucket selection around the rollout.
 */

import { describe, expect, it } from 'vitest'
import {
  effectiveBucket,
  FALLBACK_CURRENT,
  fetchPricing,
  isPeakHour,
  parseCurrentTable,
  parsePeakTable,
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

  it('degrades to the built-in list when the page is unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const snapshot = await fetchPricing(fetchImpl)
    expect(snapshot.current).toEqual(FALLBACK_CURRENT)
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