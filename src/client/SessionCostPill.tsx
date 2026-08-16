/**
 * Session header pill (right-aligned utility): the conversation's anchored
 * total cost, or — while the assistant is replying — a live estimate of the
 * TOTAL once the running reply settles (`预计 ¥x.xx（进行中）`): the already
 * anchored ledger total plus the running reply's estimated input/output.
 * Clicking the pill toggles a detail panel: totals by category, model, and
 * the anchored price snapshot; the panel dismisses on outside clicks or
 * Escape.
 *
 * The estimate is explicitly labeled 估算/estimate: input is priced at the
 * projected context size weighted by the newest completed step's cache
 * ratio (conservative all-uncached without history), output at the
 * character heuristic — both at CURRENT snapshot prices.
 */
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the contextPressure key into SessionProjectionMap.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type { ConversationCostResponse, SessionCostProjection } from '../types.ts'
import { bandForTime, blocksOutputTokens, bucketAt, cacheReadRatioOf, combineTotals, estimateCost, peakOffPeakMultiplier, subagentSpend } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatMultiplier, formatTime } from './format.ts'
import { ENDPOINT, REFRESH_MS } from './SessionCostLine.tsx'
import css from './SessionCostPill.module.css'

export type PillLocale = PropsLocale<'cost-meter'>['t']

export interface SessionCostPillProps {
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  sessionId: string
  t: PillLocale
}

/** Read the conversation's running flag (the pill's estimate gate). */
function runningOf(snapshot: ConversationSnapshot): boolean {
  return snapshot.running
}

/** Close the popover on outside clicks or Escape (product detail-panel posture). */
function useDismissOutside(open: boolean, onDismiss: () => void, anchor: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent | TouchEvent): void => {
      const target = event.target as Node | null
      if (anchor.current !== null && target !== null && !anchor.current.contains(target)) onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onDismiss, anchor])
}

export const SessionCostPill = memo(function SessionCostPill({ useSession, useProjection, sessionId, t }: SessionCostPillProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const projectionKey = currency === 'USD' ? 'sessionCostUsd' : 'sessionCost'
  const cost = useProjection(projectionKey)
  const pressure = useProjection('contextPressure')
  const running = useSession(runningOf)
  const partial = useSession(snapshot => snapshot.partial)
  const [open, setOpen] = useState(false)
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useDismissOutside(open, () => setOpen(false), wrapRef)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    const endpoint = `${ENDPOINT}?session=${encodeURIComponent(sessionId)}&currency=${currency}`
    const load = (): void => {
      void fetch(endpoint, { cache: 'no-store' })
        .then(res => (res.ok ? res.json() as Promise<ConversationCostResponse> : null))
        .then((data) => {
          if (!alive || data === null) return
          setResponse(data)
        })
        .catch(() => { /* the pill keeps the last good pricebook */ })
    }
    load()
    timer = window.setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [sessionId, currency])

  const projection = cost
  const model = projection?.model ?? null
  const snapshot = response?.pricebook.current ?? null
  const subagents = response?.subagents
  const combined = combineTotals(projection?.totals, subagents)
  const subSpend = subagentSpend(subagents)
  const symbol = currencySymbol(currency)

  // The estimate projects the TOTAL once the running reply settles: the
  // already-anchored ledger total (main + subagents) plus this reply's
  // estimated input/output (subagent replies cannot be projected live).
  const estimate = useMemo(() => {
    if (!running || projection === undefined) return null
    const bucket = bucketAt(snapshot ?? undefined, model?.provider, model?.model ?? 'unknown', Date.now())
    if (bucket === undefined) return null
    const inputTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? 0
    const cachedRatio = cacheReadRatioOf(projection.steps)
    const outputTokens = blocksOutputTokens(partial?.blocks)
    const stepEstimate = estimateCost(bucket, inputTokens, cachedRatio, outputTokens)
    return (combined?.cost ?? 0) + stepEstimate
  }, [running, projection, combined, snapshot, model, pressure, partial, currency])

  if (projection === undefined && estimate === null) return null

  const total = combined?.cost ?? 0
  const label = estimate !== null
    ? t('pill.estimate', { amount: `${symbol}${formatMoney(estimate)}` })
    : t('pill.label', { amount: `${symbol}${formatMoney(total)}` })

  const last = projection?.steps.length !== undefined && projection.steps.length > 0
    ? projection.steps[projection.steps.length - 1]
    : undefined

  const sourceKey = snapshot?.source ?? null
  const source = sourceKey === null ? t('source.none') : t(`source.${sourceKey}` as 'source.manual')

  const band = bandForTime(Date.now())
  const peakRatio = peakOffPeakMultiplier(snapshot ?? undefined, model?.provider, model?.model ?? 'unknown')
  const bandLabel = band === 'peak'
    ? peakRatio === null ? t('band.peak') : t('price.peakRatio', { multiplier: formatMultiplier(peakRatio) })
    : band === 'offPeak'
      ? peakRatio === null ? t('band.offPeak') : t('price.offPeakRatio', { multiplier: formatMultiplier(1 / peakRatio) })
      : null

  return (
    <div className={css.wrap} ref={wrapRef}>
      <button
        type="button"
        className={css.pill}
        data-testid="cost-pill"
        data-running={estimate !== null}
        data-band={band === 'single' ? undefined : band}
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
      >
        {label}
        {bandLabel !== null && <span className={css.bandBadge} data-testid="cost-pill-band">{bandLabel}</span>}
        {estimate !== null && <span className={css.estimateNote}>· {t('pill.estimateNote')}</span>}
      </button>
      {open && (
        <div className={css.detail} data-testid="cost-pill-detail">
          <div className={css.detailRow + ' ' + css.detailTotal}>{t('pill.detail.total', { amount: `${symbol}${formatMoney(total)}` })}</div>
            {bandLabel !== null && (
              <div className={css.detailRow + ' ' + css.detailRowSecondary} data-testid="cost-pill-detail-band">{bandLabel}</div>
            )}
          {combined !== undefined && combined.pricedSteps > 0 && (
            <>
              <div className={css.detailRow + ' ' + css.detailRowSecondary}>{t('view.uncached')}: {symbol}{formatMoney(combined.uncachedCost)}</div>
              <div className={css.detailRow + ' ' + css.detailRowSecondary}>{t('view.cacheRead')}: {symbol}{formatMoney(combined.cacheReadCost)}</div>
              <div className={css.detailRow + ' ' + css.detailRowSecondary}>{t('view.output')}: {symbol}{formatMoney(combined.outputCost)}</div>
            </>
          )}
          {subSpend > 0 && (
            <div className={css.detailRow + ' ' + css.detailRowMuted}>{t('line.subagent', { amount: `${symbol}${formatMoney(subSpend)}` })}</div>
          )}
          {model !== null && (
            <div className={css.detailRow + ' ' + css.detailRowSecondary}>{t('pill.detail.model', { model: model.model })}</div>
          )}
          {last !== undefined && last.snapshotVersion !== null && (
            <div className={css.detailRow + ' ' + css.detailRowMuted}>
              {t('pill.detail.snapshot', { time: formatTime(last.snapshotEffectiveAt ?? last.time) })}
              {last.band !== null && ` · ${t(`band.${last.band}` as 'band.single')}`}
            </div>
          )}
          <div className={css.detailRow + ' ' + css.detailRowMuted}>{t('pill.detail.source', { source })}</div>
          {projection !== undefined && projection.totals.unpricedSteps > 0 && (
            <div className={css.detailRow + ' ' + css.detailRowMuted}>{t('view.unpriced', { count: String(projection.totals.unpricedSteps) })}</div>
          )}
          {estimate !== null && (
            <div className={css.detailRow + ' ' + css.detailRowMuted}>{t('pill.estimateNote')}</div>
          )}
        </div>
      )}
    </div>
  )
})
