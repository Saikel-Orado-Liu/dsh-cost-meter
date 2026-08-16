/**
 * Per-reply cost chip: the anchored cost of ONE finalized reply. Rendered
 * through the assistant-actions slot but visually joined to the reply's
 * timing row (01:51 · 用时 · 首 token · tok/s): a flex `order` places it
 * after the clock text, and the type matches the clock's (label-tertiary,
 * 14px) with a dot separator, so it reads as part of the same metadata run.
 * The `messageId` owner prop maps to the assistant node's (turn, step),
 * which addresses the projection's step ledger — the cost is the anchored
 * snapshot value, never a current-price recompute. Unpriced replies render
 * `—` (the Cost tab explains why).
 */
import { memo, useEffect, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ConversationCostResponse, SessionCostStep } from '../types.ts'
import { bandForTime, peakOffPeakMultiplier } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatMultiplier } from './format.ts'
import css from './AssistantCostChip.module.css'

export type ChipLocale = PropsLocale<'cost-meter'>['t']

export interface AssistantCostChipProps {
  /** Stable identity of the finalized assistant message the actions address. */
  messageId: MessageId
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  useProjection: UseProjection
  t: ChipLocale
}

/**
 * Locate a finalized assistant node by its message id and return its
 * (turn, step) coordinates, or null when the node is out of window.
 * @param snapshot - the conversation snapshot.
 * @param messageId - the addressed message identity.
 * @returns the step coordinates, or null.
 */
export function stepOfMessage(
  snapshot: ConversationSnapshot,
  messageId: MessageId,
): { turn: number; step: number } | null {
  const nodes = snapshot.chat.legacy.nodes
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node?.kind === 'assistant' && node.messageId === messageId && node.turn !== undefined) {
      return { turn: node.turn, step: node.step }
    }
  }
  return null
}

/** The projection step for one (turn, step) coordinate, if the ledger has it. */
export function stepOf(
  steps: readonly SessionCostStep[] | undefined,
  turn: number,
  step: number,
): SessionCostStep | undefined {
  return steps?.find(entry => entry.turn === turn && entry.step === step)
}

export const AssistantCostChip = memo(function AssistantCostChip({ messageId, useSession, useProjection, t }: AssistantCostChipProps) {
  const currency = displayCurrency(t as (key: string, params?: Record<string, string>) => string)
  const step = useSession(snapshot => stepOfMessage(snapshot, messageId))
  const costCny = useProjection('sessionCost')
  const costUsd = useProjection('sessionCostUsd')
  const cost = currency === 'USD' ? costUsd : costCny
  const ledger = step === null ? undefined : stepOf(cost?.steps, step.turn, step.step)
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

  if (ledger === undefined || ledger.cost === null) {
    if (ledger === undefined) return null
    // Unpriced reply: show the dash; the native title explains why.
    const reason = ledger.unpricedReason === 'NO_MODEL' ? t('reason.NO_MODEL') : t('reason.NO_PRICE')
    return (
      <span className={css.unpriced} data-cost-chip title={reason} data-testid="cost-chip-unpriced">{t('chip.unpriced')}</span>
    )
  }

  const amount = `${currencySymbol(currency)}${formatMoney(ledger.cost)}`
  const band = bandForTime(Date.now())
  const ratio = peakOffPeakMultiplier(response?.pricebook?.current ?? null, ledger.provider, ledger.model)
  const bandLabel = band === 'peak'
    ? ratio === null ? t('band.peak') : t('price.peakRatio', { multiplier: formatMultiplier(ratio) })
    : band === 'offPeak'
      ? ratio === null ? t('band.offPeak') : t('price.offPeakRatio', { multiplier: formatMultiplier(1 / ratio) })
      : null

  return (
    <span className={css.root} data-cost-chip title={t('chip.title', { amount })} data-testid="cost-chip">
      {amount}
      {bandLabel !== null && <span className={css.bandBadge} data-band={band} data-testid="cost-chip-band">{bandLabel}</span>}
    </span>
  )
})
