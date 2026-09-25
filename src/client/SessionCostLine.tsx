/**
 * Composer-dock readout: the current session's anchored spend (the
 * `sessionCost` projection — price-snapshot-anchored, never recomputed at
 * current prices) plus the DeepSeek account balance (host `/cost-meter` route),
 * refreshed every minute.
 *
 * Presentation copies the shipped dock readout (`StatsPills` in ui-chat): a
 * single capsule holding an icon plus a label whose parts are joined by the
 * shipped `·` separator. Clicking it opens the product's stat-dialog panel
 * shape — title with the figure, rule, then a `<dl>` of labelled rows — which
 * carries the billed categories, the subagent rows, the anchored price snapshot
 * and the balance detail that the capsule has no room for.
 *
 * The component is deliberately defensive: every derived string is computed
 * inside a guarded block so a single bad field can never take down the whole
 * dock entry (the slot system retires crashed entries).
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconGaugeOutlineRegular,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BalanceSnapshot, ConversationCostResponse, SessionCostProjection } from '../types.ts'
import { costLookupFor } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatTime } from './format.ts'
import css from './SessionCostLine.module.css'

/** Host route serving the balance snapshot and the pricebook view. */
export const ENDPOINT = '/cost-meter'
/** Balance refresh interval in milliseconds. */
export const REFRESH_MS = 60_000
/** Distance between the capsule and its detail panel, in pixels. */
const PANEL_GAP = 8
/** Minimum distance the detail panel keeps from the viewport edge, in pixels. */
const PANEL_MARGIN = 12
/** Pre-measurement placement: mounted but invisible, so the first frame can size it. */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 } as const

/** Session-cost namespace key domain for the locale seat. */
export type CostLocale = PropsLocale<'cost-meter'>['t']

export interface SessionCostLineProps {
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
  const costCny = useProjection('sessionCost')
  const costUsd = useProjection('sessionCostUsd')
  const cost = currency === 'USD' ? costUsd : costCny
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])
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
  // The dock line totals the WHOLE conversation: the main ledger plus every
  // subagent row the host served, nested levels included.
  const lookup = costLookupFor(cost?.totals, response?.subagents)
  const combined = lookup.combined
  const subSpend = lookup.subagentTotal
  // The dock readout must never vanish on a session switch: switching
  // sessions re-binds the projection hook, and until the new session's
  // baseline has carried the sessionCost key useProjection returns
  // undefined (capability absent - never a usable signal). Treat a
  // missing ledger as a zero ledger so the row renders CNY 0.00
  // instead of disappearing while the baseline is in flight.
  const mainSpend = lookup.mainSpend

  // One capsule, as terse as the shipped stats capsules: the WHOLE
  // conversation's anchored spend — the root ledger plus every subagent row the
  // host served, at every nesting level — and the account balance, joined by the
  // shipped separator. The panel below decomposes that same figure.
  const symbol = currencySymbol(currency)
  const money = (value: number): string => `${symbol}${formatMoney(value)}`
  const totalSpend = combined?.cost ?? mainSpend + subSpend
  let label: ReactNode = null
  let balanceValue: string | null = null
  try {
    const okBalance = balance?.ok === true ? balance : null
    const balanceText = !balanceEnabled
      ? null
      : okBalance !== null && okBalance.balance !== null
        ? t('balance.label', { amount: `${currencySymbol(okBalance.balance.currency)}${formatMoney(okBalance.balance.total)}` })
        : failed ? t('balance.failed') : null
    if (balanceText !== null) balanceValue = balanceText
    label = (
      <>
        {t('cost.label', { amount: money(totalSpend) })}
        {balanceText !== null && (
          <>
            <span className={css.sep} aria-hidden>·</span>
            {balanceText}
          </>
        )}
      </>
    )
  } catch {
    /* keep the capsule alive */
  }
  if (label === null) return null

  const model = cost?.model?.model
  const subagents = lookup.subagents
  const pricebook = response?.pricebook
  const snapshot = pricebook?.current ?? null
  const lastStep = cost?.steps !== undefined && cost.steps.length > 0 ? cost.steps[cost.steps.length - 1] : undefined
  // The panel is the shipped stat-dialog shape: `<dt>` label, `<dd>` value. The
  // headline restates the capsule; delegated spend is then split out as a
  // breakdown of that same total (never an addition to it), followed by the
  // billed categories, the per-subagent rows, and the price provenance.
  const detailRows = useMemo(() => {
    const rows: { key: string; label: string; value: string }[] = []
    const row = (key: string, rowLabel: string, value: string | null | undefined): void => {
      if (value === null || value === undefined || value === '') return
      rows.push({ key, label: rowLabel, value })
    }
    try {
      row('session', t('dock.row.session'), money(totalSpend))
      if (subSpend > 0) {
        row('subagent', t('dock.row.subagent'), money(subSpend))
        row('own', t('dock.row.own'), money(totalSpend - subSpend))
      }
      if (combined !== undefined && combined.pricedSteps > 0) {
        row('uncached', t('dock.row.uncached'), money(combined.uncachedCost))
        row('cacheRead', t('dock.row.cacheRead'), money(combined.cacheReadCost))
        row('output', t('dock.row.output'), money(combined.outputCost))
      }
      // One row per subagent, depth-tagged: the same tree the Cost tab lists.
      for (const subagent of subagents) {
        const name = subagent.depth > 1
          ? `${subagent.sessionId.slice(0, 8)} (${t('subagent.depth', { depth: String(subagent.depth) })})`
          : subagent.sessionId.slice(0, 8)
        row(`agent:${subagent.sessionId}`, name, money(subagent.totals?.cost ?? 0))
      }
      row('balance', t('dock.row.balance'), balanceValue)
      row('model', t('dock.row.model'), model ?? null)
      row('snapshot', t('dock.row.snapshot'), lastStep !== undefined && lastStep.snapshotVersion !== null
        ? `${formatTime(lastStep.snapshotEffectiveAt ?? lastStep.time)}${lastStep.band === null ? '' : ` · ${t(`band.${lastStep.band}` as 'band.single')}`}`
        : null)
      if (snapshot !== null && (snapshot.source === 'official' || snapshot.source === 'fallback' || snapshot.source === 'manual' || snapshot.source === 'openrouter')) {
        row('source', t('dock.row.source'), t(`source.${snapshot.source}` as 'source.manual'))
      }
      if (combined !== undefined && combined.unpricedSteps > 0) row('unpriced', t('dock.row.unpriced'), String(combined.unpricedSteps))
      row('updated', t('dock.row.updated'), response === null ? null : formatTime(balance?.ok === true ? balance.fetchedAt : Date.now()))
    } catch {
      /* keep the panel alive */
    }
    return rows
  }, [combined, totalSpend, subSpend, subagents, balanceValue, balance, model, lastStep, snapshot, response, money, t])

  return (
    <span className={css.anchor} ref={rootRef} data-testid="session-cost-line" data-composer-cost>
      <button
        type="button"
        className={css.pill}
        data-cost-pill="total"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('dock.detail.title')}
        onClick={() => setOpen(prev => !prev)}
      >
        <IconGaugeOutlineRegular />
        <span className={css.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          role="dialog"
          aria-label={t('dock.detail.title')}
          data-testid="session-cost-detail"
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.title}>
            <span className={css.titleLabel}><IconGaugeOutlineRegular />{t('dock.detail.title')}</span>
            <span className={css.titleValue}>{money(totalSpend)}</span>
          </div>
          <div className={css.titleRule} aria-hidden />
          <dl className={css.details} data-session-cost-details>
            {detailRows.map(entry => (
              <Fragment key={entry.key}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </Fragment>
            ))}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
})
