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
import { memo } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionCostStep } from '../types.ts'
import { currencySymbol, formatMoney } from './format.ts'
import css from './AssistantCostChip.module.css'

export type ChipLocale = PropsLocale<'fare-meter'>['t']

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
  const step = useSession(snapshot => stepOfMessage(snapshot, messageId))
  const cost = useProjection('sessionCost')
  const ledger = step === null ? undefined : stepOf(cost?.steps, step.turn, step.step)

  if (ledger === undefined || ledger.cost === null) {
    if (ledger === undefined) return null
    // Unpriced reply: show the dash; the native title explains why.
    const reason = ledger.unpricedReason === 'NO_MODEL' ? t('reason.NO_MODEL') : t('reason.NO_PRICE')
    return (
      <span className={css.unpriced} data-cost-chip title={reason} data-testid="cost-chip-unpriced">{t('chip.unpriced')}</span>
    )
  }

  const amount = `${currencySymbol('CNY')}${formatMoney(ledger.cost)}`
  return (
    <span className={css.root} data-cost-chip title={t('chip.title', { amount })} data-testid="cost-chip">{amount}</span>
  )
})
