/**
 * Per-reply cost, appended to the completed Turn's action row. Rendered
 * through the `conversation.chat.assistant-actions` list slot: DSH 0.1.5
 * renders those entries inside the action row itself (copy · branch · usage ·
 * 用时 3分12秒 · 9月4日 19:47), and the chip's `order` places it after the
 * timing text, so the price closes the same row the timing facts end.
 *
 * The slot hands over only the finalized message id, so the `sessionCostIndex`
 * projection resolves it to the (turn, step) coordinates the anchored ledger
 * is keyed by; the Turn's own steps are then summed. Every price is the
 * anchored snapshot value, never a current-price recompute; an unpriced Turn
 * renders `—` (the Cost tab explains why). The band rides the shipped `Tag`
 * capsule (11px/17px, `success` off-peak / `danger` peak), i.e. the same tag
 * geometry the rest of the product uses.
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
  /** Durable id of the finalized assistant message owning this action row. */
  messageId: string
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

export const AssistantCostChip = memo(function AssistantCostChip({ messageId, useProjection, t }: AssistantCostChipProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const costCny = useProjection('sessionCost')
  const costUsd = useProjection('sessionCostUsd')
  const cost = currency === 'USD' ? costUsd : costCny
  const index = useProjection('sessionCostIndex')
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

  // The action row carries the message id; the index carries its coordinates.
  const coordinates = index?.steps[messageId]
  const steps = coordinates === undefined ? [] : stepsOfTurn(cost?.steps, coordinates.turn)
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
