/**
 * Per-reply cost at the end of the completed Turn's timing row. Rendered
 * through the `conversation.chat.turnTail` chain slot — the selector only
 * accepts closed Turns, so the extension appears once the reply settled and
 * sits directly after the timing facts (用时 · 首 token · tok/s), with a dot
 * separator and the same label-tertiary type as the clock text.
 *
 * DSH 0.1.5 removed the per-message assistant-actions slot and replaced the
 * legacy chat-node window with turn/step locations; the cost is therefore
 * addressed per Turn: the anchored step ledger (`sessionCost` projection) is
 * filtered to the Turn's own steps and summed. Every price is the anchored
 * snapshot value, never a current-price recompute; an unpriced Turn renders
 * `—` (the Cost tab explains why). The band rides the shipped `Tag` capsule
 * (11px/17px, `success` off-peak / `danger` peak), i.e. the same tag geometry
 * the rest of the product uses.
 */
import { memo, useEffect, useState } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationCostResponse, SessionCostStep } from '../types.ts'
import { bandForTime, peakOffPeakMultiplier } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatMultiplier } from './format.ts'
import css from './AssistantCostChip.module.css'

export type ChipLocale = PropsLocale<'cost-meter'>['t']

export interface AssistantCostChipProps {
  /** The closed Turn selected by the turnTail chain selector. */
  matched: { turn: number }
  useProjection: UseProjection
  t: ChipLocale
}

/** The projection step for one (turn, step) coordinate, if the ledger has it. */
export function stepOf(
  steps: readonly SessionCostStep[] | undefined,
  turn: number,
  step: number,
): SessionCostStep | undefined {
  return steps?.find(entry => entry.turn === turn && entry.step === step)
}

/** The Turn's own ledger steps, in fold order. */
export function stepsOfTurn(
  steps: readonly SessionCostStep[] | undefined,
  turn: number,
): SessionCostStep[] {
  return steps?.filter(entry => entry.turn === turn) ?? []
}

export const AssistantCostChip = memo(function AssistantCostChip({ matched, useProjection, t }: AssistantCostChipProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const costCny = useProjection('sessionCost')
  const costUsd = useProjection('sessionCostUsd')
  const cost = currency === 'USD' ? costUsd : costCny
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)

  useEffect(() => {
    let alive = true
    void fetch(`/cost-meter?currency=${currency}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() as Promise<ConversationCostResponse> : null))
      .then((data) => {
        if (!alive || data === null) return
        setResponse(data)
      })
      .catch(() => { /* the chip keeps the last good pricebook */ })
    return () => {
      alive = false
    }
  }, [currency])

  const steps = stepsOfTurn(cost?.steps, matched.turn)
  const priced = steps.filter(entry => entry.cost !== null)
  if (steps.length === 0) return null
  if (priced.length === 0) {
    // Unpriced turn: show the dash; the native title explains why.
    const reason = steps[0]?.unpricedReason === 'NO_MODEL' ? t('reason.NO_MODEL') : t('reason.NO_PRICE')
    return (
      <span className={css.unpriced} data-cost-chip title={reason} data-testid="cost-chip-unpriced">{t('chip.unpriced')}</span>
    )
  }

  const total = priced.reduce((sum, entry) => sum + (entry.cost ?? 0), 0)
  const amount = `${currencySymbol(currency)}${formatMoney(total)}`
  // Anchored to the Turn's own (last) step: the ledger's `band` was fixed at
  // fold time from the usage event's time, so the badge shows the band that
  // actually priced this reply — not the band of the clock right now.
  const last = priced[priced.length - 1]
  if (last === undefined) return null
  const band = last.band ?? bandForTime(last.time)
  const ratio = peakOffPeakMultiplier(response?.pricebook?.current ?? null, last.provider, last.model)
  const bandLabel = band === 'peak'
    ? ratio === null ? t('band.peak') : t('price.peakRatio', { multiplier: formatMultiplier(ratio) })
    : band === 'offPeak'
      ? ratio === null ? t('band.offPeak') : t('price.offPeakRatio', { multiplier: formatMultiplier(1 / ratio) })
      : null

  return (
    <span className={css.root} data-cost-chip title={t('chip.title', { amount })} data-testid="cost-chip">
      {amount}
      {bandLabel !== null && <Tag tone={band === 'peak' ? 'danger' : 'success'}>{bandLabel}</Tag>}
    </span>
  )
})
