// @vitest-environment jsdom
/**
 * Cost-meter client surfaces: the shared formatting/estimate math,
 * the dock readout rendering the ANCHORED projection total plus the balance,
 * the per-reply chip, and the header pill with the streaming estimate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
// The real ui-primitives pulls KaTeX stylesheets Node cannot load; the
// surfaces only need Tooltip/Button/Tag/Pill/icons and the two anchor hooks to
// pass through, so stub the module. `Tag` mirrors the shipped
// `span[data-tone]` capsule; the hooks are inert here (jsdom has no layout).
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const React = require('react')
  const passthrough = (props: Record<string, unknown>) => React.createElement('span', props)
  return {
    Tooltip: (props: { children?: unknown; label?: unknown }) =>
      React.createElement('div', { 'data-tooltip': String(props.label ?? '') }, props.children),
    Button: (props: { children?: unknown; onClick?: unknown; disabled?: unknown; variant?: unknown }) =>
      React.createElement('button', { type: 'button', onClick: props.onClick, disabled: props.disabled }, props.children),
    Tag: (props: { tone?: string; className?: string; children?: unknown }) =>
      React.createElement('span', { 'data-tone': props.tone ?? 'outline', className: props.className }, props.children),
    Pill: (props: { className?: string; children?: unknown }) =>
      React.createElement('span', { className: props.className }, props.children),
    useAnchoredPosition: () => ({ left: 0, top: 0 }),
    useDismissOnOutsidePointer: () => { /* outside clicks are covered by the pill's own tests */ },
    IconGaugeOutlineRegular: passthrough,
    IconDatabaseOutlineRegular: passthrough,
  }
})
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BalanceSnapshot, ConversationCostResponse, SessionCostProjection } from '../src/types.ts'
import { AssistantCostChip, stepOf, stepsOfTurn } from '../src/client/AssistantCostChip.tsx'
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

/** 2026-08-17 10:00 Beijing (post-rollout peak hour). */
const POST_PEAK_MS = Date.UTC(2026, 7, 17, 2, 0, 0)
/** 2026-08-17 20:00 Beijing (post-rollout off-peak hour). */
const POST_OFFPEAK_MS = Date.UTC(2026, 7, 17, 12, 0, 0)
/** The zh default schedule (the schedule of the CNY pricebook page). */
const ZH_SCHEDULE = { timezone: 'Asia/Shanghai', ranges: [[9, 12], [14, 18]] as const }

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
    schedule: ZH_SCHEDULE,
  },
  subagents: [],
}

/** A host-aggregated subagent entry for subagent assertions. */
const SUBAGENT: ConversationCostResponse['subagents'][number] = {
  sessionId: 'sub-1234',
  parentId: 's1',
  depth: 1,
  totals: { uncachedCost: 0.2, cacheReadCost: 0.1, outputCost: 0.4, cost: 0.7, pricedSteps: 3, unpricedSteps: 0, steps: 3 },
}

/** A nested (grandchild-level) subagent row, as the durable tree reports it. */
const NESTED_SUBAGENT: ConversationCostResponse['subagents'][number] = {
  sessionId: 'sub-5678',
  parentId: 'sub-1234',
  depth: 2,
  label: 'nested probe',
  totals: { uncachedCost: 0.3, cacheReadCost: 0, outputCost: 0.2, cost: 0.5, pricedSteps: 1, unpricedSteps: 0, steps: 1 },
}

/** Plain zh dictionary bound to the components' t seat. */
function zhT(key: string, params?: Record<string, string>): string {
  const zh: Record<string, string> = {
    'cost.label': '本会话 {amount}',
    'line.uncached': '非缓存输入 {amount}',
    'line.cacheRead': '缓存输入 {amount}',
    'line.output': '输出 {amount}',
    'line.subagent': '子代理 {amount}',
    'subagent.depth': '第 {depth} 层',
    'balance.label': '余额 {amount}',
    'balance.failed': '余额不可用',
    'balance.detail': '余额 {amount}（赠送 {granted} · 充值 {toppedUp}）',
    'balance.suspended': '账户已暂停付费请求',
    'dock.detail.title': '本会话花费',
    'dock.row.session': '本会话',
    'dock.row.subagent': '子代理（含下级）',
    'dock.row.own': '本会话自身',
    'dock.row.uncached': '输入（缓存未命中）',
    'dock.row.cacheRead': '输入（缓存命中）',
    'dock.row.output': '输出',
    'dock.row.balance': '账户余额',
    'dock.row.model': '模型',
    'dock.row.snapshot': '价格快照',
    'dock.row.source': '价格来源',
    'dock.row.updated': '更新时间',
    'dock.row.unpriced': '无价格步数',
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
    'chip.detail.title': '本回复花费',
    'chip.detail.band': '计价档位',
    'chip.detail.model': '模型',
    'chip.detail.snapshot': '价格快照',
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
    'settings.summary': '快照锚定的会话花费与价格表',
    'settings.rejected': '主机拒绝了这次修改',
    'settings.unavailable': '此部署未向本页提供可编辑的配置',
    'settings.overridden': '已自定义',
    'settings.error': '操作失败：{error}',
    'settings.jsonHint': 'JSON 对象，键为模型，值含 single/offPeak/peak 价格桶',
  }
  let text = zh[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, value)
  }
  return text
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
    const { combineTotals, costLookupFor, subagentSpend } = await import('../src/client/cost-math.ts')
    const main = PROJECTION.totals
    const combined = combineTotals(main, [SUBAGENT])
    expect(combined?.cost).toBeCloseTo(3.72)
    expect(combined?.uncachedCost).toBeCloseTo(1.2)
    expect(combined?.cacheReadCost).toBeCloseTo(0.12)
    expect(combined?.outputCost).toBeCloseTo(2.4)
    // Nested rows are summed into the same combined total, at any depth.
    expect(combineTotals(main, [SUBAGENT, NESTED_SUBAGENT])?.cost).toBeCloseTo(4.22)
    expect(subagentSpend([SUBAGENT, NESTED_SUBAGENT])).toBeCloseTo(1.2)
    expect(subagentSpend(undefined)).toBe(0)
    // Without subagents the combined totals are the main totals by reference.
    expect(combineTotals(main, undefined)).toBe(main)
    // A conversation whose own ledger is not materialized still totals its
    // subagents instead of rendering nothing.
    expect(combineTotals(undefined, [SUBAGENT])?.cost).toBeCloseTo(0.7)
    expect(combineTotals(undefined, undefined)).toBeUndefined()
    // costLookupFor is the single read every surface uses.
    const lookup = costLookupFor(undefined, [SUBAGENT, NESTED_SUBAGENT])
    expect(lookup.mainSpend).toBe(0)
    expect(lookup.subagentTotal).toBeCloseTo(1.2)
    expect(lookup.combined?.cost).toBeCloseTo(1.2)
    expect(costLookupFor(main, undefined).combined).toBe(main)
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

describe('stepsOfTurn / stepOf', () => {
  it('filters the ledger by turn and addresses it by coordinates', () => {
    expect(stepsOfTurn(PROJECTION.steps, 1).map(s => `${s.turn}:${s.step}`)).toEqual(['1:1'])
    expect(stepsOfTurn(PROJECTION.steps, 9)).toEqual([])
    expect(stepOf(PROJECTION.steps, 1, 1)?.cost).toBe(3.02)
    expect(stepOf(PROJECTION.steps, 9, 9)).toBeUndefined()
  })
})

describe('SessionCostLine', () => {
  /** The capsule's label text. The `·` separator's spacing comes from CSS
   * margins, so the reader re-spaces it to keep the expectations readable. */
  const pillText = (): string =>
    (screen.getByTestId('session-cost-line').querySelector('[data-cost-pill="total"]')?.textContent ?? '')
      .replace(/·/g, ' · ')

  it('renders the whole conversation total and the balance as one capsule', async () => {
    stubFetch(RESPONSE)
    const useProjection = () => PROJECTION as never
    render(<SessionCostLine
      useProjection={useProjection as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText(/余额 ¥110.00/)
    // One capsule holding the WHOLE conversation's spend (the root ledger plus
    // every subagent level) and the balance; the panel carries the breakdown.
    expect(screen.getByTestId('session-cost-line').querySelectorAll('[data-cost-pill]').length).toBe(1)
    expect(pillText()).toBe('本会话 ¥3.02 · 余额 ¥110.00')
    expect(screen.getByTestId('session-cost-line').hasAttribute('data-composer-cost')).toBe(true)
  })

  it('opens the shipped stat-dialog panel with the labelled rows on click', async () => {
    stubFetch(RESPONSE)
    render(<SessionCostLine
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    const trigger = await screen.findByRole('button', { name: '本会话花费' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const panel = await screen.findByRole('dialog', { name: '本会话花费' })
    const rows = Array.from(panel.querySelectorAll('dl dt')).map((node) => node.textContent)
    expect(rows).toEqual(['本会话', '输入（缓存未命中）', '输入（缓存命中）', '输出', '账户余额', '模型', '价格快照', '价格来源', '更新时间'])
    expect(panel.querySelector('dl dd')?.textContent).toBe('¥3.02')
    expect(panel.textContent).toContain('¥0.0200')
  })

  it('carries the whole conversation total into the capsule and splits it in the panel', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT] })
    render(<SessionCostLine
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    // 本会话 is the WHOLE conversation: main 3.02 + child 0.70 = 3.72.
    await screen.findByText(/本会话 ¥3.72/)
    expect(pillText()).toBe('本会话 ¥3.72 · 余额 ¥110.00')
    fireEvent.click(screen.getByRole('button', { name: '本会话花费' }))
    const panel = await screen.findByRole('dialog', { name: '本会话花费' })
    const dds = Array.from(panel.querySelectorAll('dl dd')).map((node) => node.textContent)
    // 本会话 · 子代理（含下级） · 本会话自身 · 三档计费 · 账户余额 · …
    expect(dds.slice(0, 3)).toEqual(['¥3.72', '¥0.7000', '¥3.02'])
  })

  it('sums nested subagent rows into the whole-conversation total, at every depth', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT] })
    render(<SessionCostLine
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    // Main 3.02 + direct child 0.70 + grandchild 0.50 = 4.22; the delegated share
    // is 1.20 and the session's own share stays 3.02.
    await screen.findByText(/本会话 ¥4.22/)
    expect(pillText()).toBe('本会话 ¥4.22 · 余额 ¥110.00')
    fireEvent.click(screen.getByRole('button', { name: '本会话花费' }))
    const panel = await screen.findByRole('dialog', { name: '本会话花费' })
    const dds = Array.from(panel.querySelectorAll('dl dd')).map((node) => node.textContent)
    expect(dds.slice(0, 3)).toEqual(['¥4.22', '¥1.20', '¥3.02'])
  })

  it('still totals subagents when the main ledger is not materialized', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT], balance: null })
    render(<SessionCostLine
      useProjection={() => undefined as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText(/本会话 ¥1.20/)
    expect(pillText()).toBe('本会话 ¥1.20')
    fireEvent.click(screen.getByRole('button', { name: '本会话花费' }))
    const panel = await screen.findByRole('dialog', { name: '本会话花费' })
    const dds = Array.from(panel.querySelectorAll('dl dd')).map((node) => node.textContent)
    // The whole total is delegated, so the session's own share is zero.
    expect(dds.slice(0, 3)).toEqual(['¥1.20', '¥1.20', '¥0.00'])
  })

  it('hides the balance when the pricebook toggle disables it', async () => {
    stubFetch({ ...RESPONSE, pricebook: { ...RESPONSE.pricebook, balanceEnabled: false } })
    render(<SessionCostLine
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
      useProjection={() => undefined as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText(/本会话 ¥0.00/)
  })

  it('keeps the row visible on a fresh session with zero spend (session switch)', async () => {
    // A newly opened session has a zero ledger and possibly no usable
    // balance — the row must still render (本会话 ¥0.00) instead of
    // disappearing when switching sessions.
    stubFetch({ ...RESPONSE, balance: { ok: false, code: 'MISSING_CREDENTIAL', message: 'no key' } })
    const empty = { ...PROJECTION, model: null, steps: [], totals: { uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0 } }
    render(<SessionCostLine
      useProjection={() => empty as never}
      sessionId={"fresh-session" as never}
      t={zhT}
    />)
    await screen.findByText(/本会话 ¥0.00/)
  })

  it('shows a balance-failed marker when the host route errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<SessionCostLine
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
  /** The `sessionCostIndex` value the chip resolves its Turn through. */
  const INDEX = { steps: { 'msg-1': { turn: 1, step: 1 } } }
  /** The chip reads the anchored ledger plus the message index; key picks one. */
  const projections = (ledger: unknown, index: unknown = INDEX): never =>
    ((key: string) => (key === 'sessionCostIndex' ? index : ledger)) as never

  it('renders the anchored per-reply cost as one stat capsule without a band tag', () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId="msg-1"
      useProjection={projections(PROJECTION)}
      t={zhT}
    />)
    const chip = screen.getByTestId('cost-chip')
    const trigger = screen.getByRole('button', { name: '¥3.02' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    // The band lives in the label colour and the dialog, not in a tag capsule.
    expect(chip.querySelector('[data-tone]')).toBeNull()
  })

  it('opens the anchored breakdown dialog from the capsule and closes on Escape', async () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId="msg-1"
      useProjection={projections(PROJECTION)}
      t={zhT}
    />)
    expect(screen.queryByTestId('cost-chip-detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '¥3.02' }))
    const dialog = await screen.findByRole('dialog', { name: '本回复花费' })
    const rows = [...dialog.querySelectorAll('dt')].map(node => node.textContent)
    expect(rows).toEqual(['输入（缓存未命中）', '输入（缓存命中）', '输出', '计价档位', '模型', '价格快照'])
    const values = [...dialog.querySelectorAll('dd')].map(node => node.textContent)
    // Small amounts keep their magnitude-based precision (0.02 → ¥0.0200).
    expect(values).toEqual(['¥1.00', '¥0.0200', '¥2.00', '单价', 'deepseek-v4-flash', expect.stringContaining('快照 v1')])
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('cost-chip-detail')).toBeNull())
  })

  it('renders the dash for an unpriced reply', () => {
    stubFetch(RESPONSE)
    const unpriced = {
      ...PROJECTION,
      steps: [{ ...PROJECTION.steps[0], priced: false, cost: null, unpricedReason: 'NO_PRICE' as const }],
      totals: { ...PROJECTION.totals, pricedSteps: 0, unpricedSteps: 1, cost: 0 },
    }
    render(<AssistantCostChip
      messageId="msg-1"
      useProjection={projections(unpriced)}
      t={zhT}
    />)
    expect(screen.getByTestId('cost-chip-unpriced').textContent).toBe('—')
  })

  it('renders nothing for a message the index does not carry', () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId="msg-unknown"
      useProjection={projections(PROJECTION)}
      t={zhT}
    />)
    expect(screen.queryByTestId('cost-chip')).toBeNull()
    expect(screen.queryByTestId('cost-chip-unpriced')).toBeNull()
  })

  it('renders nothing when the indexed Turn has no ledger step', () => {
    stubFetch(RESPONSE)
    render(<AssistantCostChip
      messageId="msg-1"
      useProjection={projections(PROJECTION, { steps: { 'msg-1': { turn: 9, step: 1 } } })}
      t={zhT}
    />)
    expect(screen.queryByTestId('cost-chip')).toBeNull()
  })

  it('colours the per-reply capsule red with the peak band of the ROUND', async () => {
    // The capsule follows the round's OWN time (the anchored ledger band),
    // not the wall clock: the ledger says peak while "now" is off-peak.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:30:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const peakLedger = {
        ...PROJECTION,
        steps: [{ ...PROJECTION.steps[0], time: POST_PEAK_MS, band: 'peak' as const }],
      }
      render(<AssistantCostChip
        messageId="msg-1"
        useProjection={projections(peakLedger)}
        t={zhT}
      />)
      const chip = screen.getByTestId('cost-chip')
      expect(chip.getAttribute('data-band')).toBe('peak')
      expect(screen.getByRole('button', { name: '¥3.02' })).not.toBeNull()
      // The band and its multiplier reach the reader through the dialog.
      fireEvent.click(screen.getByRole('button', { name: '¥3.02' }))
      const dialog = await screen.findByRole('dialog', { name: '本回复花费' })
      expect(dialog.textContent).toContain('高峰 2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('colours the per-reply capsule green with the off-peak band of the ROUND', async () => {
    // The ledger says off-peak even while the wall clock is in a peak hour.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T10:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const offPeakLedger = {
        ...PROJECTION,
        steps: [{ ...PROJECTION.steps[0], time: POST_OFFPEAK_MS, band: 'offPeak' as const }],
      }
      render(<AssistantCostChip
        messageId="msg-1"
        useProjection={projections(offPeakLedger)}
        t={zhT}
      />)
      const chip = screen.getByTestId('cost-chip')
      expect(chip.getAttribute('data-band')).toBe('offPeak')
      expect(screen.getByRole('button', { name: '¥3.02' })).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '¥3.02' }))
      const dialog = await screen.findByRole('dialog', { name: '本回复花费' })
      expect(dialog.textContent).toContain('闲时 0.5×')
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
        useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
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

  it('shows the whole conversation total including nested subagents', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT] })
    render(<SessionCostPill
      useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    // main 3.02 + 0.70 + 0.50 (grandchild) = 4.22
    await screen.findByText('花费 ¥4.22')
  })

  it('keeps the pill when only subagent ledgers are materialized', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT] })
    render(<SessionCostPill
      useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
      useProjection={() => undefined as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByText('花费 ¥1.20')
  })

  it('shows the streaming estimate while running', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-16T12:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const running = {
        running: true,
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
      // Input 1.1M at 50% cached ratio: 1.1 × (0.5×1 + 0.5×0.02) = 0.561; the
      // running reply's output is unestimated (DSH 0.1.5 no longer exposes the
      // streaming partial blocks; the round's settled usage follows).
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
        useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await screen.findByText(/0.5×/)
      const pill = screen.getByTestId('cost-pill')
      expect(pill.getAttribute('data-band')).toBe('offPeak')
      const badge = pill.querySelector('[data-tone="success"]')
      expect(badge?.textContent).toContain('闲时')
      expect(badge?.textContent).toContain('0.5×')
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
        useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await screen.findByText(/2.0×/)
      const pill = screen.getByTestId('cost-pill')
      expect(pill.getAttribute('data-band')).toBe('peak')
      const badge = pill.querySelector('[data-tone="danger"]')
      expect(badge?.textContent).toContain('高峰')
      expect(badge?.textContent).toContain('2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('colors the capsule by the pricebook schedule (the en page may differ from zh)', async () => {
    // UTC 00:30 is peak under the response's UTC schedule but off-peak
    // (08:30 Beijing) under the zh default — the live band must follow the
    // schedule of the pricebook being displayed.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-17T00:30:00Z'))
    try {
      stubFetch({ ...RESPONSE, pricebook: { ...RESPONSE.pricebook, schedule: { timezone: 'UTC', ranges: [[0, 1]] as const } } })
      render(<SessionCostPill
        useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
        useProjection={() => PROJECTION as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await screen.findByText(/2.0×/)
      const pill = screen.getByTestId('cost-pill')
      expect(pill.getAttribute('data-band')).toBe('peak')
      expect(pill.querySelector('[data-tone="danger"]')?.textContent).toContain('高峰')
    } finally {
      vi.useRealTimers()
    }
  })

  it('toggles the detail panel on click', async () => {
    stubFetch(RESPONSE)
    render(<SessionCostPill
      useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
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
      useSession={((selector: (s: never) => unknown) => selector({ running: false } as never)) as never}
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
  it('marks each reply card with the peak band of the ROUND, not the clock now', async () => {
    // The step happened in a peak hour but "now" (the wall clock) is an
    // off-peak hour — the card must stay red (peak), anchored to the round.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:30:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const peakLedger = {
        ...PROJECTION,
        steps: [{ ...PROJECTION.steps[0], time: POST_PEAK_MS, band: 'peak' as const }],
      }
      render(<CostView
        useProjection={() => peakLedger as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      const card = screen.getByTestId('cost-step')
      const badge = card.querySelector('[data-tone="danger"]')
      expect(card.getAttribute('data-band')).toBe('peak')
      expect(badge?.textContent).toContain('高峰')
      expect(badge?.textContent).toContain('2.0×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an off-peak reply green even while the clock is in a peak hour', async () => {
    // The step happened in an off-peak hour but "now" is a peak hour — the
    // card must stay green (off-peak), anchored to the round.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T10:00:00+08:00'))
    try {
      stubFetch(RESPONSE)
      const offPeakLedger = {
        ...PROJECTION,
        steps: [{ ...PROJECTION.steps[0], time: POST_OFFPEAK_MS, band: 'offPeak' as const }],
      }
      render(<CostView
        useProjection={() => offPeakLedger as never}
        sessionId={"s1" as never}
        t={zhT}
      />)
      await vi.advanceTimersByTimeAsync(0)
      const card = screen.getByTestId('cost-step')
      const badge = card.querySelector('[data-tone="success"]')
      expect(card.getAttribute('data-band')).toBe('offPeak')
      expect(badge?.textContent).toContain('闲时')
      expect(badge?.textContent).toContain('0.5×')
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists every nesting level of the subagent tree with its depth', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT] })
    render(<CostView
      useProjection={() => PROJECTION as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByTestId('cost-view-subagents')
    const rows = screen.getAllByTestId('cost-subagent')
    expect(rows.map(row => row.getAttribute('data-depth'))).toEqual(['1', '2'])
    expect(rows[0]?.textContent).toContain('sub-1234')
    // The grandchild row names its depth and indents by one level (14px).
    expect(rows[1]?.textContent).toContain('第 2 层')
    expect(rows[1]?.querySelector('span')?.getAttribute('style')).toContain('padding-left: 14px')
    // The section total is the sum of both rows.
    expect(screen.getByTestId('cost-view-subagents').textContent).toContain('子代理 ¥1.20')
  })

  it('still renders the subagent section when the main ledger is absent', async () => {
    stubFetch({ ...RESPONSE, subagents: [SUBAGENT, NESTED_SUBAGENT] })
    render(<CostView
      useProjection={() => undefined as never}
      sessionId={"s1" as never}
      t={zhT}
    />)
    await screen.findByTestId('cost-view-subagents')
    expect(screen.queryByTestId('cost-view-empty')).toBeNull()
    expect(screen.getByTestId('cost-view').textContent).toContain('总花费')
    expect(screen.getAllByTestId('cost-subagent')).toHaveLength(2)
  })
})

describe('CostPluginCard', () => {
  /** A fake configuration-page form over one accepted section (stable snapshots). */
  function makeForm(value: unknown) {
    return {
      state: { status: 'ready' as const, value, base: {}, user: undefined, revision: 7, writable: true, mode: 'host' as const },
      mutate: vi.fn(async () => true),
    }
  }

  it("renders the row's one-liner without fetching the pricebook route", () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<CostPluginCard view="summary" t={zhT} />)
    expect(screen.getByText('快照锚定的会话花费与价格表')).not.toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renders the configuration page and writes staged edits through the form', async () => {
    stubFetch(RESPONSE)
    const form = makeForm({
      overrides: {},
      aliases: { 'deepseek/deepseek-chat': 'deepseek-v4-flash' },
      cacheReadDiscount: 0.25,
      fxMode: 'auto',
      manualRate: 7.2,
      balanceEnabled: true,
      openRouterEnabled: true,
    })
    render(<CostPluginCard view="page" form={form as never} t={zhT} />)
    // The page owner draws the title; the body carries the fields and no version numbers.
    expect(screen.getByTestId('cost-plugin-card').textContent).not.toContain('v1')
    expect(screen.getByText('缓存折扣系数（OpenRouter）')).not.toBeNull()
    expect(screen.getByText('OpenRouter 别名映射')).not.toBeNull()
    // Save submits every staged field as one revision-fenced batch.
    await waitFor(() => expect(screen.getByText('保存')).not.toBeNull())
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(form.mutate).toHaveBeenCalledTimes(1))
    expect(form.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['overrides'], value: {} },
      { op: 'set', path: ['aliases'], value: { 'deepseek/deepseek-chat': 'deepseek-v4-flash' } },
      { op: 'set', path: ['fxMode'], value: 'auto' },
      { op: 'set', path: ['balanceEnabled'], value: true },
      { op: 'set', path: ['openRouterEnabled'], value: true },
      { op: 'set', path: ['cacheReadDiscount'], value: 0.25 },
      { op: 'set', path: ['manualRate'], value: 7.2 },
    ], 7)
  })

  it('reports a Host refusal instead of claiming a save', async () => {
    stubFetch(RESPONSE)
    const form = makeForm({ fxMode: 'auto' })
    form.mutate = vi.fn(async () => false)
    render(<CostPluginCard view="page" form={form as never} t={zhT} />)
    await waitFor(() => expect(screen.getByText('保存')).not.toBeNull())
    fireEvent.click(screen.getByText('保存'))
    await screen.findByText('操作失败：主机拒绝了这次修改')
  })

  it('states that nothing is editable when the page supplies no form', () => {
    render(<CostPluginCard view="page" t={zhT} />)
    expect(screen.getByTestId('cost-plugin-card').textContent).toContain('未向本页提供可编辑的配置')
  })
})
