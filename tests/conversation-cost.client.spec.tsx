// @vitest-environment jsdom
/**
 * Fare-meter client surfaces: the shared formatting/estimate math,
 * the dock readout rendering the ANCHORED projection total plus the balance,
 * the per-reply chip, and the header pill with the streaming estimate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// The real ui-primitives pulls KaTeX stylesheets Node cannot load; the
// surfaces only need Tooltip/Button/icons to pass through, so stub the module.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const React = require('react')
  const passthrough = (props: Record<string, unknown>) => React.createElement('span', props)
  return {
    Tooltip: (props: { children?: unknown; label?: unknown }) =>
      React.createElement('div', { 'data-tooltip': String(props.label ?? '') }, props.children),
    Button: (props: { children?: unknown; onClick?: unknown; disabled?: unknown; variant?: unknown }) =>
      React.createElement('button', { type: 'button', onClick: props.onClick, disabled: props.disabled }, props.children),
    IconChevronDownOutline14: passthrough,
  }
})
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BalanceSnapshot, ConversationCostResponse, SessionCostProjection } from '../src/types.ts'
import { AssistantCostChip, stepOf, stepOfMessage } from '../src/client/AssistantCostChip.tsx'
import { cacheReadRatioOf, estimateCost, estimateTokens, peakOffPeakMultiplier } from '../src/client/cost-math.ts'
import { CostPluginCard } from '../src/client/CostPluginCard.tsx'
import { CostView } from '../src/client/CostView.tsx'
import { currencySymbol, formatMoney, formatMultiplier, formatPercent } from '../src/client/format.ts'
import { SessionCostLine, ENDPOINT } from '../src/client/SessionCostLine.tsx'
import { SessionCostPill } from '../src/client/SessionCostPill.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const OK_BALANCE: Extract<BalanceSnapshot, { ok: true }> = {
  ok: true,
  isAvailable: true,
  balance: { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
  fetchedAt: 1_780_000_000_000,
}

const PROJECTION: SessionCostProjection = {
  model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  steps: [
    {
      turn: 1, step: 1, time: 1_780_000_000_000, model: 'deepseek-v4-flash', provider: 'deepseek-official',
      uncachedInputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000,
      uncachedCost: 1, cacheReadCost: 0.02, outputCost: 2, cost: 3.02, priced: true,
      snapshotVersion: 1, snapshotEffectiveAt: 1_779_000_000_000, band: 'single',
    },
  ],
  totals: { uncachedCost: 1, cacheReadCost: 0.02, outputCost: 2, cost: 3.02, pricedSteps: 1, unpricedSteps: 0, steps: 1 },
}

const RESPONSE: ConversationCostResponse = {
  balance: OK_BALANCE,
  pricebook: {
    currency: 'CNY',
    current: {
      version: 1,
      currency: 'CNY',
      effectiveAt: 1_779_000_000_000,
      source: 'official',
      usdCnyRate: null,
      prices: {
        flash: {
          source: 'official',
          single: { cacheReadPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 2 },
          offPeak: { cacheReadPerMillion: 0.05, inputPerMillion: 1.5, outputPerMillion: 4.5 },
          peak: { cacheReadPerMillion: 0.1, inputPerMillion: 3, outputPerMillion: 9 },
        },
      },
    },
    snapshots: [],
    overrides: {},
    aliases: {},
    cacheReadDiscount: 0.25,
    fx: { mode: 'auto', manualRate: 7.2 },
    balanceEnabled: true,
    openRouterEnabled: true,
    fetchedAt: 1_780_000_000_000,
  },
  subagents: [],
}

/** A host-aggregated subagent entry for subagent assertions. */
const SUBAGENT: ConversationCostResponse['subagents'][number] = {
  sessionId: 'sub-1234',
  totals: { uncachedCost: 0.2, cacheReadCost: 0.1, outputCost: 0.4, cost: 0.7, pricedSteps: 3, unpricedSteps: 0, steps: 3 },
}

/** Plain zh dictionary bound to the components' t seat. */
function zhT(key: string, params?: Record<string, string>): string {
  const zh: Record<string, string> = {
    'cost.label': '本会话 {amount}',
    'line.uncached': '非缓存输入 {amount}',
    'line.cacheRead': '缓存输入 {amount}',
    'line.output': '输出 {amount}',
    'line.subagent': '子代理 {amount}',
    'balance.label': '余额 {amount}',
    'balance.failed': '余额不可用',
    'balance.detail': '余额 {amount}（赠送 {granted} · 充值 {toppedUp}）',
    'balance.suspended': '账户已暂停付费请求',
    'view.empty': '暂无花费数据',
    'view.total': '总花费',
    'view.uncached': '输入（缓存未命中）',
    'view.cacheRead': '输入（缓存命中）',
    'view.output': '输出',
    'view.unpriced': '{count} 步无价格',
    'view.steps': '每轮回复花费',
    'step.turn': '第 {turn} 轮',
    'step.model': '模型 {model}',
    'step.time': '{time}',
    'step.tokens': '未命中 {uncached} · 缓存读 {read} · 缓存写 {write} · 输出 {output}',
    'step.cost': '花费 {amount}',
    'step.snapshot': '快照 v{version} · {time}',
    'step.unpriced': '—（{reason}）',
    'reason.NO_MODEL': '无模型信息',
    'reason.NO_PRICE': '无价格',
    'pill.label': '花费 {amount}',
    'pill.estimate': '预计 {amount}',
    'pill.estimateNote': '估算',
    'pill.detail.total': '总花费 {amount}',
    'pill.detail.snapshot': '价格快照（{time}）',
    'pill.detail.model': '模型 {model}',
    'pill.detail.source': '价格来源 {source}',
    'source.official': '官方页面',
    'source.fallback': '内置回退',
    'source.manual': '手动',
    'source.openrouter': 'OpenRouter',
    'source.none': '无',
    'band.peak': '高峰价',
    'band.offPeak': '闲时价',
    'band.single': '单价',
    'price.peakExtra': '高峰 · 比闲时多 {multiplier} 倍',
    'price.offPeakSaving': '闲时 · 比高峰省 {percent}',
    'price.peakRatio': '高峰 {multiplier}',
    'price.offPeakRatio': '闲时 {multiplier}',
    'chip.title': '本回复花费 {amount}',
    'chip.unpriced': '—',
    'refreshedAt': '更新于 {time}',
    'settings.title': '花费计价',
    'settings.current': '当前快照 · {source} · {time}',
    'settings.noSnapshot': '尚无价格快照',
    'settings.refresh': '立即刷新',
    'settings.refreshing': '刷新中…',
    'settings.overrides': '按模型价目表（手动覆盖，元/百万 tokens）',
    'settings.aliases': 'OpenRouter 别名映射',
    'settings.discount': '缓存折扣系数（OpenRouter）',
    'settings.fx': '汇率（USD→CNY）',
    'settings.fx.auto': '自动',
    'settings.fx.manual': '手动',
    'settings.balance': '显示余额',
    'settings.openrouter': '允许 OpenRouter 回退',
    'settings.save': '保存',
    'settings.discard': '丢弃',
    'settings.saved': '已保存',
    'settings.error': '操作失败：{error}',
    'settings.jsonHint': 'JSON 对象，键为模型，值含 single/offPeak/peak 价格桶',
  }
  let text = zh[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

function snapshotWithNodes(nodes: unknown[]) {
  return {
    running: false,
    partial: null,
    chat: { legacy: { nodes } },
  } as never
}

function assistantNode(messageId: string, turn = 1, step = 1) {
  return { kind: 'assistant', seq: turn * 10 + step, messageId, turn, step, provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
}

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })
  vi.stubGlobal('fetch', fetchImpl)
  return fetchImpl
}

describe('currencySymbol and formatMoney', () => {
  it('maps common currencies and falls back to the bare code', () => {
    expect(currencySymbol('CNY')).toBe('¥')
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('JPY')).toBe('JPY ')
  })

  it('chooses precision by magnitude', () => {
    expect(formatMoney(110)).toBe('110.00')
    expect(formatMoney(0.0123)).toBe('0.0123')
    expect(formatMoney(0.0000123)).toBe('0.000012')
    expect(formatMoney(0)).toBe('0.00')
  })
})

describe('estimate helpers', () => {
  it('heuristic tokens: CJK ÷ 1.5, other ÷ 4', () => {
    expect(estimateTokens('你好世界')).toBe(3) // 4 CJK / 1.5 = 2.67 → 3
    expect(estimateTokens('hello world')).toBe(3) // 11 / 4 = 2.75 → 3
  })

  it('cache ratio comes from the newest completed step, conservatively 0 without history', () => {
    expect(cacheReadRatioOf(PROJECTION.steps)).toBeCloseTo(0.5)
    expect(cacheReadRatioOf([])).toBe(0)
    expect(cacheReadRatioOf([{ ...PROJECTION.steps[0], priced: false }])).toBe(0)
  })

  it('weights input by the cache ratio and prices output at the output rate', () => {
    const bucket = { cacheReadPerMillion: 0.02, inputPerMillion: 1, outputPerMillion: 2 }
    // 1M input, 50% cached: 0.5×1 + 0.5×0.02 = 0.51; 1M output × 2 = 2 → 2.51
    expect(estimateCost(bucket, 1_000_000, 0.5, 1_000_000)).toBeCloseTo(2.51)
    // No cache history: all input uncached → 1 + 2 = 3 (conservative upper bound)
    expect(estimateCost(bucket, 1_000_000, 0, 1_000_000)).toBeCloseTo(3)
  })

  it('combines main and subagent totals and isolates the subagent spend', async () => {
    const { combineTotals, subagentSpend } = await import('../src/client/cost-math.ts')
    const main = PROJECTION.totals
    const combined = combineTotals(main, [SUBAGENT])
    expect(combined?.cost).toBeCloseTo(3.72)
    expect(combined?.uncachedCost).toBeCloseTo(1.2)
    expect(combined?.cacheReadCost).toBeCloseTo(0.12)
    expect(combined?.outputCost).toBeCloseTo(2.4)
    expect(subagentSpend([SUBAGENT])).toBeCloseTo(0.7)
    expect(subagentSpend(undefined)).toBe(0)
    // Without subagents the combined totals are the main totals by reference.
    expect(combineTotals(main, undefined)).toBe(main)
    expect(combineTotals(undefined, [SUBAGENT])).toBeUndefined()
  })
})

describe('peakOffPeakMultiplier and formatMultiplier', () => {
  it('computes the peak/off-peak ratio from a model entry', () => {
    const snapshot = RESPONSE.pricebook.current
    expect(peakOffPeakMultiplier(snapshot, 'deepseek-official', 'deepseek-v4-flash')).toBeCloseTo(2)
    // A missing model or missing bands yields no multiplier.
    expect(peakOffPeakMultiplier(snapshot, 'openrouter', 'unknown-model')).toBeNull()
    expect(peakOffPeakMultiplier(undefined, 'deepseek-official', 'deepseek-v4-flash')).toBeNull()
  })

  it('formats multipliers with one decimal', () => {
    expect(formatMultiplier(2)).toBe('2.0×')
    expect(formatMultiplier(0.5)).toBe('0.5×')
  })

  it('formats percentages as whole percents', () => {
    expect(formatPercent(0.5)).toBe('50%')
    expect(formatPercent(0.25)).toBe('25%')
  })
})

describe('stepOfMessage / stepOf', () => {
  it('locates the node by messageId and addresses the ledger', () => {
    const snapshot = snapshotWithNodes([assistantNode('m1', 2, 3)])
    expect(stepOfMessage(snapshot, 'm1' as never)).toEqual({ turn: 2, step: 3 })
    expect(stepOfMessage(snapshot, 'missing' as never)).toBeNull()
    expect(stepOf(PROJECTION.steps, 1, 1)?.cost).toBe(3.02)
    expect(stepOf(PROJECTION.steps, 9, 9)).toBeUndefined()
  })
})

describe('SessionCostLine', () => {
  it('renders the three cost breakdowns, the total, and the balance on one strip', async () => {
    stubFetch(RESPONSE)
    const useProjection = () => PROJECTION as never
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={useProjection as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText('缓存输入 ¥0.0200 · 非缓存输入 ¥1.00 · 输出 ¥2.00 · 本会话 ¥3.02 · 余额 ¥110.00')
  })

  it('combines subagent costs into the breakdowns and shows the subagent total', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT] })
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    // Combined: uncached 1.2 → 1.20 · cacheRead 0.12 → 0.1200 · output 2.4 → 2.40.
    await screen.findByText('缓存输入 ¥0.1200 · 非缓存输入 ¥1.20 · 输出 ¥2.40 · 本会话 ¥3.02 · 子代理 ¥0.7000 · 余额 ¥110.00')
  })

  it('hides the balance when the pricebook toggle disables it', async () => {
    stubFetch({ ...RESPONSE, pricebook: { ...RESPONSE.pricebook, balanceEnabled: false } })
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText(/本会话 ¥3.02/)
    expect(screen.queryByText(/余额/)).toBeNull()
  })

  it('keeps the row visible even when the projection is absent (session switch)', async () => {
    // Switching sessions re-binds the projection hook; until the new
    // session's baseline has carried the sessionCost key it reads
    // undefined, and the balance may be unavailable too - the cost text
    // must not disappear, so the row renders CNY 0.00 instead.
    stubFetch({ ...RESPONSE, balance: null })
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
      useProjection={() => undefined as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText('本会话 ¥0.00')
  })

  it('keeps the row visible on a fresh session with zero spend (session switch)', async () => {
    // A newly opened session has a zero ledger and possibly no usable
    // balance — the row must still render (本会话 ¥0.00) instead of
    // disappearing when switching sessions.
    stubFetch({ ...RESPONSE, balance: { ok: false, code: 'MISSING_CREDENTIAL', message: 'no key' } })
    const empty = { ...PROJECTION, model: null, steps: [], totals: { uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0 } }
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
      useProjection={() => empty as never}
      sessionId={"fresh-session" as never}
      t={zhT}
    />)
    await screen.findByText('本会话 ¥0.00')
  })

  it('shows a balance-failed marker when the host route errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<SessionCostLine
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText(/余额不可用/)
  })

  it('refreshes on the interval and stops after unmount', async () => {
    const fetches = stubFetch(RESPONSE)
    vi.useFakeTimers()
    try {
      const { unmount } = render(<SessionCostLine
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
        useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      expect(fetches).toHaveBeenCalledTimes(1)
      expect(fetches).toHaveBeenCalledWith(`${ENDPOINT}?session=s1&currency=CNY`, expect.objectContaining({ cache: 'no-store' }))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetches).toHaveBeenCalledTimes(2)
      unmount()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetches).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AssistantCostChip', () => {
  it('renders the anchored per-reply cost', () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId={'m1' as never}
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={() => PROJECTION as never}
      t={zhT}
    />)
    expect(screen.getByTestId('cost-chip').textContent).toContain('¥3.02')
  })

  it('renders the dash for an unpriced reply', () => {
    stubFetch(RESPONSE)
    const unpriced = {
      ...PROJECTION,
      steps: [{ ...PROJECTION.steps[0], priced: false, cost: null, unpricedReason: 'NO_PRICE' as const }],
      totals: { ...PROJECTION.totals, pricedSteps: 0, unpricedSteps: 1, cost: 0 },
    }
    render(<AssistantCostChip
      messageId={'m1' as never}
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={() => unpriced as never}
      t={zhT}
    />)
    expect(screen.getByTestId('cost-chip-unpriced').textContent).toBe('—')
  })

  it('renders nothing when the message is out of window', () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId={'m1' as never}
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([]))) as never}
      useProjection={() => PROJECTION as never}
      t={zhT}
    />)
    expect(screen.queryByTestId('cost-chip')).toBeNull()
    expect(screen.queryByTestId('cost-chip-unpriced')).toBeNull()
  })

  it('marks the per-reply cost chip red with the peak extra multiplier', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T10:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<AssistantCostChip
        messageId={'m1' as never}
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
        useProjection={() => PROJECTION as never}
        t={zhT}
      />)
      await screen.findByText(/2.0×/)
      const badge = screen.getByTestId('cost-chip-band')
      expect(badge.getAttribute('data-band')).toBe('peak')
      expect(badge.textContent).toContain('高峰')
      expect(badge.textContent).toContain('2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the per-reply cost chip green with the off-peak saving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:30:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<AssistantCostChip
        messageId={'m1' as never}
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
        useProjection={() => PROJECTION as never}
        t={zhT}
      />)
      await screen.findByText(/0.5×/)
      const badge = screen.getByTestId('cost-chip-band')
      expect(badge.getAttribute('data-band')).toBe('offPeak')
      expect(badge.textContent).toContain('闲时')
      expect(badge.textContent).toContain('0.5×')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionCostPill', () => {
  it('shows the exact anchored total while idle', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T12:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<SessionCostPill
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      expect(screen.getByText('花费 ¥3.02')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the streaming estimate while running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-16T12:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const running = {
        running: true,
        partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: '你好世界 hello' }] },
        chat: { legacy: { nodes: [assistantNode('m1')] } },
      } as never
      const useProjection = (key: string): unknown => {
        if (key === 'sessionCost') return PROJECTION
        if (key === 'contextPressure') return { pressureTokens: 1_000_000, projectedTokens: 1_100_000 }
        return undefined
      }
      render(<SessionCostPill
        useSession={((selector: (s: never) => unknown) => selector(running as never)) as never}
        useProjection={useProjection as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      // 4 CJK ÷ 1.5 = 2.67→3 + 5 ASCII ÷ 4 = 1.25→2 → 5 output tokens.
      // Input 1.1M at 50% cached ratio: 1.1 × (0.5×1 + 0.5×0.02) = 0.561; output 5 × 2/1M ≈ 0.00001 → ≈ 0.561.
      // The estimate projects the TOTAL after the reply settles: anchored 3.02 + 0.561 ≈ 3.58.
      const text = await screen.findByText(/预计/)
      expect(text.textContent).toContain('¥3.58')
      expect(text.textContent).not.toContain('进行中')
      expect(text.textContent).toContain('估算')
    } finally {
      vi.useRealTimers()
    }
  })

  it('colors the top-right conversation capsule green with the off-peak saving', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:30:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<SessionCostPill
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await screen.findByText(/0.5×/)
      const pill = screen.getByTestId('cost-pill')
      expect(pill.getAttribute('data-band')).toBe('offPeak')
      expect(screen.getByTestId('cost-pill-band').textContent).toContain('闲时')
      expect(screen.getByTestId('cost-pill-band').textContent).toContain('0.5×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('colors the top-right conversation capsule red with the peak extra multiplier', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T10:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<SessionCostPill
        useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await screen.findByText(/2.0×/)
      const pill = screen.getByTestId('cost-pill')
      expect(pill.getAttribute('data-band')).toBe('peak')
      expect(screen.getByTestId('cost-pill-band').textContent).toContain('高峰')
      expect(screen.getByTestId('cost-pill-band').textContent).toContain('2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('toggles the detail panel on click', async () => {
    stubFetch(RESPONSE)
    render(<SessionCostPill
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    const pill = await screen.findByTestId('cost-pill')
    expect(screen.queryByTestId('cost-pill-detail')).toBeNull()
    fireEvent.click(pill)
    expect(screen.getByTestId('cost-pill-detail')).not.toBeNull()
    expect(screen.getByTestId('cost-pill-detail').textContent).toContain('价格快照')
    expect(screen.getByTestId('cost-pill-detail').textContent).not.toContain('v1')
  })

  it('dismisses the detail panel on an outside click', async () => {
    stubFetch(RESPONSE)
    render(<SessionCostPill
      useSession={((selector: (s: never) => unknown) => selector(snapshotWithNodes([assistantNode('m1')]))) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    const pill = await screen.findByTestId('cost-pill')
    fireEvent.click(pill)
    expect(screen.getByTestId('cost-pill-detail')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('cost-pill-detail')).toBeNull()
    // Clicking the pill itself keeps the panel open.
    fireEvent.click(pill)
    expect(screen.getByTestId('cost-pill-detail')).not.toBeNull()
    fireEvent.mouseDown(pill)
    expect(screen.getByTestId('cost-pill-detail')).not.toBeNull()
  })
})

describe('CostView', () => {
  it('marks each reply cost with the peak band and the extra multiplier', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T10:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<CostView
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      const card = screen.getByTestId('cost-step')
      const badge = screen.getByTestId('cost-step-band')
      expect(card.getAttribute('data-band')).toBe('peak')
      expect(badge.getAttribute('data-band')).toBe('peak')
      expect(badge.textContent).toContain('高峰')
      expect(badge.textContent).toContain('2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks each reply cost green with the off-peak saving', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:30:00+08:00'))
    try {
      stubFetch(RESPONSE)
      render(<CostView
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      const card = screen.getByTestId('cost-step')
      const badge = screen.getByTestId('cost-step-band')
      expect(card.getAttribute('data-band')).toBe('offPeak')
      expect(badge.getAttribute('data-band')).toBe('offPeak')
      expect(badge.textContent).toContain('闲时')
      expect(badge.textContent).toContain('0.5×')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CostPluginCard', () => {
  /** A fake settings scope over one accepted section (stable snapshots). */
  function makeScope(value: unknown) {
    const listeners = new Set<() => void>()
    let snapshot = { status: 'ready' as const, value, base: {}, user: undefined, revision: 1, writable: true, mode: 'host' as const }
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: vi.fn(async () => { /* noop */ }),
      unset: vi.fn(async () => { /* noop */ }),
    }
  }

  it('renders the standard plugin card and writes staged edits through the scope', () => {
    stubFetch(RESPONSE)
    const scope = makeScope({
      overrides: {},
      aliases: { 'deepseek/deepseek-chat': 'deepseek-v4-flash' },
      cacheReadDiscount: 0.25,
      fxMode: 'auto',
      manualRate: 7.2,
      balanceEnabled: true,
      openRouterEnabled: true,
    })
    render(<CostPluginCard scope={scope as never} t={zhT} />)
    // Header names the plugin; no version numbers anywhere.
    expect(screen.getByTestId('cost-plugin-card').textContent).toContain('花费计价')
    expect(screen.getByTestId('cost-plugin-card').textContent).not.toContain('v1')
    fireEvent.click(screen.getByText('花费计价'))
    expect(screen.getByText('缓存折扣系数（OpenRouter）')).not.toBeNull()
    expect(screen.getByText('OpenRouter 别名映射')).not.toBeNull()
    // Save writes every staged field through the scope.
    fireEvent.click(screen.getByText('保存'))
    expect(scope.set).toHaveBeenCalledWith('overrides', {})
    expect(scope.set).toHaveBeenCalledWith('aliases', { 'deepseek/deepseek-chat': 'deepseek-v4-flash' })
    expect(scope.set).toHaveBeenCalledWith('cacheReadDiscount', 0.25)
    expect(scope.set).toHaveBeenCalledWith('fxMode', 'auto')
    expect(scope.set).toHaveBeenCalledWith('manualRate', 7.2)
    expect(scope.set).toHaveBeenCalledWith('balanceEnabled', true)
    expect(scope.set).toHaveBeenCalledWith('openRouterEnabled', true)
  })
})
