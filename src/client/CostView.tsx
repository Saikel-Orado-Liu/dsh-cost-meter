/**
 * Cost view tab: the whole conversation's anchored cost ledger — the total
 * (main session + subagent sessions, host-aggregated), the three billed
 * categories (uncached input incl. cache writes, cache reads, output), a
 * per-subagent breakdown, and the per-reply list (turn, time, model, token
 * split, step cost, anchored snapshot version and effective time). Reads the
 * `sessionCost` projection plus the host-aggregated subagent totals; nothing
 * is recomputed at current prices.
 */
import { memo, useEffect, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationCostResponse, SessionCostStep } from '../types.ts'
import { bandForTime, combineTotals, peakOffPeakMultiplier, subagentSpend } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatMultiplier, formatTime } from './format.ts'
import css from './CostView.module.css'

export type CostViewLocale = PropsLocale<'cost-meter'>['t']

export interface CostViewProps {
  useProjection: UseProjection
  sessionId: string
  t: CostViewLocale
}

/** Map an unpriced reason to its localized copy. */
function reasonText(step: SessionCostStep, t: CostViewLocale): string {
  return t(`reason.${step.unpricedReason ?? 'NO_PRICE'}` as 'reason.NO_PRICE')
}

export const CostView = memo(function CostView({ useProjection, sessionId, t }: CostViewProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const projectionKey = currency === 'USD' ? 'sessionCostUsd' : 'sessionCost'
  const cost = useProjection(projectionKey)
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)
  const symbol = currencySymbol(currency)

  useEffect(() => {
    let alive = true
    void fetch(`/cost-meter?session=${encodeURIComponent(sessionId)}&currency=${currency}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() as Promise<ConversationCostResponse> : null))
      .then((data) => {
        if (!alive || data === null) return
        setResponse(data)
      })
      .catch(() => { /* the tab keeps the last good aggregation */ })
    return () => {
      alive = false
    }
  }, [sessionId, currency])

  if (cost === undefined || cost.steps.length === 0) {
    return <div className={css.root} data-testid="cost-view-empty">{t('view.empty')}</div>
  }

  const rows = cost.steps
  const combined = combineTotals(cost.totals, response?.subagents)
  const totals = combined ?? cost.totals
  const subSpend = subagentSpend(response?.subagents)
  const money = (value: number | null): string => value === null ? '—' : `${symbol}${formatMoney(value)}`

  return (
    <div className={css.root} data-testid="cost-view">
      <section className={css.summary}>
        <div className={css.totalRow}>
          <span className={css.totalLabel}>{t('view.total')}</span>
          <span className={css.totalValue}>{money(totals.cost)}</span>
        </div>
        <div className={css.categories}>
          <span>{t('view.uncached')}: {money(totals.uncachedCost)}</span>
          <span>{t('view.cacheRead')}: {money(totals.cacheReadCost)}</span>
          <span>{t('view.output')}: {money(totals.outputCost)}</span>
        </div>
        {totals.unpricedSteps > 0 && (
          <div className={css.unpricedNote}>{t('view.unpriced', { count: String(totals.unpricedSteps) })}</div>
        )}
        {response !== null && response.subagents.length > 0 && (
          <section className={css.subagents} data-testid="cost-view-subagents">
            <div className={css.unpricedNote}>{t('line.subagent', { amount: `${symbol}${formatMoney(subSpend)}` })}</div>
            <ol className={css.stepList}>
              {response.subagents.map(sub => (
                <li key={sub.sessionId} className={css.step}>
                  <div className={css.stepHead}>
                    <span className={css.stepTurn}>{sub.sessionId.slice(0, 8)}</span>
                    <span className={css.stepCost}>{money(sub.totals.cost)}</span>
                  </div>
                  <div className={css.stepBody}>
                    <span>{t('view.uncached')}: {money(sub.totals.uncachedCost)}</span>
                    <span>{t('view.cacheRead')}: {money(sub.totals.cacheReadCost)}</span>
                    <span>{t('view.output')}: {money(sub.totals.outputCost)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </section>

      <section className={css.steps}>
        <h3 className={css.stepsTitle}>{t('view.steps')}</h3>
        <ol className={css.stepList}>
          {rows.map((step) => {
            const stepBand = bandForTime(Date.now())
            const stepRatio = peakOffPeakMultiplier(response?.pricebook?.current ?? null, step.provider, step.model)
            const stepBandLabel = stepBand === 'peak'
              ? stepRatio === null ? t('band.peak') : t('price.peakRatio', { multiplier: formatMultiplier(stepRatio) })
              : stepBand === 'offPeak'
                ? stepRatio === null ? t('band.offPeak') : t('price.offPeakRatio', { multiplier: formatMultiplier(1 / stepRatio) })
                : null
            return (
            <li key={`${step.turn}:${step.step}`} className={css.step} data-testid="cost-step" data-band={stepBand === 'single' ? undefined : stepBand}>
              <div className={css.stepHead}>
                <span className={css.stepTurn}>{t('step.turn', { turn: String(step.turn) })}</span>
                <span className={css.stepModel}>{t('step.model', { model: step.model })}</span>
                <span className={css.stepTime}>{formatTime(step.time)}</span>
                <span className={css.stepCost}>
                  {money(step.cost)}
                  {stepBandLabel !== null && <span className={css.bandBadge} data-band={stepBand} data-testid="cost-step-band">{stepBandLabel}</span>}
                </span>
              </div>
              <div className={css.stepBody}>
                <span className={css.stepTokens}>
                  {t('step.tokens', {
                    uncached: String(step.uncachedInputTokens),
                    read: String(step.cacheReadTokens),
                    write: String(step.cacheWriteTokens),
                    output: String(step.outputTokens),
                  })}
                </span>
                <span className={css.stepMeta}>
                  {step.priced && step.snapshotVersion !== null
                    ? t('step.snapshot', {
                      time: formatTime(step.snapshotEffectiveAt ?? step.time),
                    })
                    : t('step.unpriced', { reason: reasonText(step, t) })}
                </span>
              </div>
            </li>
            );
          })}
        </ol>
      </section>
    </div>
  )
})
