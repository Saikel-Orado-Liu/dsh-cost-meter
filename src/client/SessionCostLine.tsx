/**
 * Composer-dock readout: the current session's anchored spend (the
 * `sessionCost` projection — price-snapshot-anchored, never recomputed at
 * current prices) plus the DeepSeek account balance (host
 * `/cost-meter` route), refreshed every minute. The hover detail
 * breaks the spend into the three billed categories (uncached input incl.
 * cache writes, cache reads, output) and names the anchored price snapshot.
 *
 * The component is deliberately defensive: every derived string is computed
 * inside a guarded block so a single bad field can never take down the whole
 * dock entry (the slot system retires crashed entries).
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceSnapshot, ConversationCostResponse, SessionCostProjection } from '../types.ts'
import { combineTotals, subagentSpend } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatTime } from './format.ts'
import css from './SessionCostLine.module.css'

/** Host route serving the balance snapshot and the pricebook view. */
export const ENDPOINT = '/cost-meter'
/** Balance refresh interval in milliseconds. */
export const REFRESH_MS = 60_000

/** Session-cost namespace key domain for the locale seat. */
export type CostLocale = PropsLocale<'cost-meter'>['t']

export interface SessionCostLineProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  sessionId: string
  t: CostLocale
}

/** Compose the tooltip's balance detail from an ok snapshot. */
function balanceTooltip(balance: Extract<BalanceSnapshot, { ok: true }>, t: CostLocale): string {
  if (balance.balance === null) return t('balance.failed')
  const symbol = currencySymbol(balance.balance.currency)
  const amount = `${symbol}${formatMoney(balance.balance.total)}`
  const granted = `${symbol}${formatMoney(balance.balance.granted)}`
  const toppedUp = `${symbol}${formatMoney(balance.balance.toppedUp)}`
  const detail = t('balance.detail', { amount, granted, toppedUp })
  return balance.isAvailable ? detail : `${detail} · ${t('balance.suspended')}`
}

/** The tooltip's cost detail rows from the anchored projection. Never throws. */
export function costDetail(cost: SessionCostProjection | undefined, model: string | undefined, t: CostLocale, currency: 'CNY' | 'USD' = 'CNY'): string[] {
  const rows: string[] = []
  try {
    if (cost === undefined) return rows
    const symbol = currencySymbol(currency)
    const totals = cost.totals
    if (totals !== undefined && totals.pricedSteps > 0) {
      rows.push(t('cost.label', { amount: `${symbol}${formatMoney(totals.cost)}` }))
      rows.push(t('view.uncached') + ` ${symbol}${formatMoney(totals.uncachedCost)}`)
      rows.push(t('view.cacheRead') + ` ${symbol}${formatMoney(totals.cacheReadCost)}`)
      rows.push(t('view.output') + ` ${symbol}${formatMoney(totals.outputCost)}`)
    }
    if (model !== undefined) rows.push(t('step.model', { model }))
    const steps = cost.steps
    if (steps !== undefined && steps.length > 0) {
      const last = steps[steps.length - 1]
      if (last !== undefined && last.snapshotVersion !== null) {
        rows.push(t('pill.detail.snapshot', { time: formatTime(last.snapshotEffectiveAt ?? last.time) }))
      }
    }
    if (totals !== undefined && totals.unpricedSteps > 0) {
      rows.push(t('view.unpriced', { count: String(totals.unpricedSteps) }))
    }
  } catch {
    /* a malformed field must never take down the dock entry */
  }
  return rows
}

export const SessionCostLine = memo(function SessionCostLine({ useProjection, sessionId, t }: SessionCostLineProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const projectionKey = currency === 'USD' ? 'sessionCostUsd' : 'sessionCost'
  const cost = useProjection(projectionKey)
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const endpoint = `${ENDPOINT}?session=${encodeURIComponent(sessionId)}&currency=${currency}`
    const load = (): void => {
      void fetch(endpoint, { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json() as Promise<ConversationCostResponse>
        })
        .then((data) => {
          if (!alive) return
          setResponse(data)
          setFailed(false)
        })
        .catch(() => {
          if (alive) setFailed(true)
        })
    }
    load()
    timer = window.setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [sessionId, currency])

  const balance = response?.balance
  const balanceEnabled = response?.pricebook?.balanceEnabled !== false
  const subagents = response?.subagents
  const combined = combineTotals(cost?.totals, subagents)
  const subSpend = subagentSpend(subagents)
  // The dock readout must never vanish on a session switch: switching
  // sessions re-binds the projection hook, and until the new session's
  // baseline has carried the sessionCost key useProjection returns
  // undefined (capability absent - never a usable signal). Treat a
  // missing ledger as a zero ledger so the row renders CNY 0.00
  // instead of disappearing while the baseline is in flight.
  const mainSpend = cost?.totals?.cost ?? 0

  const parts: string[] = []
  try {
    const symbol = currencySymbol(currency)
    // Breakdown first (cached input, uncached input, output — combined with
    // subagents), then the main session total, then the subagent total, then
    // the balance.
    if (combined !== undefined && combined.pricedSteps > 0) {
      parts.push(t('line.cacheRead', { amount: `${symbol}${formatMoney(combined.cacheReadCost)}` }))
      parts.push(t('line.uncached', { amount: `${symbol}${formatMoney(combined.uncachedCost)}` }))
      parts.push(t('line.output', { amount: `${symbol}${formatMoney(combined.outputCost)}` }))
    }
    parts.push(t('cost.label', { amount: `${symbol}${formatMoney(mainSpend)}` }))
    if (subSpend > 0) {
      parts.push(t('line.subagent', { amount: `${symbol}${formatMoney(subSpend)}` }))
    }
    if (balanceEnabled && balance?.ok === true && balance.balance !== null) {
      parts.push(t('balance.label', { amount: `${currencySymbol(balance.balance.currency)}${formatMoney(balance.balance.total)}` }))
    } else if (balanceEnabled && failed) {
      parts.push(t('balance.failed'))
    }
  } catch {
    /* keep the row alive */
  }
  if (parts.length === 0) return null

  const model = cost?.model?.model
  const tooltipParts = useMemo(() => {
    const rows: string[] = []
    try {
      rows.push(...costDetail(cost, model, t, currency))
      if (subSpend > 0) {
        rows.push(t('line.subagent', { amount: `${currencySymbol(currency)}${formatMoney(subSpend)}` }))
      }
      const pricebook = response?.pricebook
      if (pricebook !== undefined && pricebook.current !== null) {
        const source = pricebook.current.source
        if (source === 'official' || source === 'fallback' || source === 'manual' || source === 'openrouter') {
          rows.push(t('pill.detail.source', { source: t(`source.${source}` as 'source.manual') }))
        }
      }
      if (balanceEnabled && balance?.ok === true) rows.push(balanceTooltip(balance, t))
      if (response !== null) {
        rows.push(t('refreshedAt', { time: formatTime(balance?.ok === true ? balance.fetchedAt : Date.now()) }))
      }
    } catch {
      /* keep the row alive */
    }
    return rows
  }, [cost, model, t, balance, balanceEnabled, response, subSpend, currency])

  const line = parts.join(' · ')
  const tooltip = tooltipParts.filter(Boolean).join(' · ')
  if (tooltip.length === 0) {
    return <div className={css.root} data-testid="session-cost-line">{line}</div>
  }
  return (
    <Tooltip label={tooltip} side="top" delayMs={500}>
      <div className={css.root} data-testid="session-cost-line">{line}</div>
    </Tooltip>
  )
})
