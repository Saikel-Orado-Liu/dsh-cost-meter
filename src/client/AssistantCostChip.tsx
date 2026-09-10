/**
 * Per-reply cost, rendered in the completed Turn's action row. Contributed
 * through the `conversation.chat.assistant-actions` list slot, whose entries
 * DSH 0.1.5 draws in the row's action area (after the copy action, ahead of the
 * branch button); a flex `order` then seats the capsule after the shipped 用量
 * and 用时 capsules and before the row's timestamp, closing the stat run with
 * the row's own 8px gaps between neighbours.
 *
 * The control is the row's own stat-capsule shape — the same trigger + portaled
 * dialog the shipped 用量 and 用时 capsules use (28px pill, 13px/24px tertiary
 * label, hover fill, an `aria-expanded` dialog anchored above the trigger
 * through `useAnchoredPosition` + `useDismissOnOutsidePointer`). Clicking it
 * opens the reply's anchored breakdown: the three billed categories, the band
 * that priced it, the model, and the snapshot version.
 *
 * The price itself is the band-coloured label (green off-peak, red peak,
 * neutral before the rollout), so the row carries the status without a second
 * tag capsule. The slot hands over only the finalized message id, so the
 * `sessionCostIndex` projection resolves it to the (turn, step) coordinates the
 * anchored ledger is keyed by; the Turn's own steps are then summed. Every
 * price is the anchored snapshot value, never a current-price recompute; an
 * unpriced Turn renders `—` (the Cost tab explains why).
 */
import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconGaugeOutline16,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationCostResponse, SessionCostStep } from '../types.ts'
import { bandForTime, peakOffPeakMultiplier } from './cost-math.ts'
import { currencySymbol, displayCurrency, formatMoney, formatMultiplier, formatTime } from './format.ts'
import css from './AssistantCostChip.module.css'

export type ChipLocale = PropsLocale<'cost-meter'>['t']

export interface AssistantCostChipProps {
  /** Durable id of the finalized assistant message owning this action row. */
  messageId: string
  useProjection: UseProjection
  t: ChipLocale
}

/** Distance kept between the trigger and its dialog (the shipped stat panels' own gap). */
const PANEL_GAP = 8
/** Distance kept between the dialog and the viewport edges. */
const PANEL_MARGIN = 12
/** Pre-measurement placement: mounted but invisible, so the first frame can size it. */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 } as const

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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

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

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

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

  const symbol = currencySymbol(currency)
  const money = (value: number): string => `${symbol}${formatMoney(value)}`
  const amount = money(priced.reduce((sum, entry) => sum + (entry.cost ?? 0), 0))
  // Anchored to the Turn's own (last) step: the ledger's `band` was fixed at
  // fold time from the usage event's time, so the capsule is coloured by the
  // band that actually priced this reply — not the band of the clock now.
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
    <span
      className={css.root}
      ref={rootRef}
      data-cost-chip
      data-band={band === 'single' ? undefined : band}
      data-testid="cost-chip"
    >
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <IconGaugeOutline16 />
        <span className={css.label}>{amount}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          role="dialog"
          aria-label={t('chip.detail.title')}
          style={pos ?? MEASURE_STYLE}
          data-testid="cost-chip-detail"
        >
          <div className={css.title}>
            <span className={css.titleLabel}><IconGaugeOutline16 />{t('chip.detail.title')}</span>
            <span className={css.titleValue}>{amount}</span>
          </div>
          <div className={css.titleRule} aria-hidden />
          <dl className={css.details}>
            <dt>{t('view.uncached')}</dt>
            <dd>{money(priced.reduce((sum, entry) => sum + entry.uncachedCost, 0))}</dd>
            <dt>{t('view.cacheRead')}</dt>
            <dd>{money(priced.reduce((sum, entry) => sum + entry.cacheReadCost, 0))}</dd>
            <dt>{t('view.output')}</dt>
            <dd>{money(priced.reduce((sum, entry) => sum + entry.outputCost, 0))}</dd>
            <dt>{t('chip.detail.band')}</dt>
            <dd>{bandLabel ?? t('band.single')}</dd>
            <dt>{t('chip.detail.model')}</dt>
            <dd>{last.model}</dd>
            {last.snapshotVersion !== null && (
              <>
                <dt>{t('chip.detail.snapshot')}</dt>
                <dd>{t('step.snapshot', { version: String(last.snapshotVersion), time: formatTime(last.snapshotEffectiveAt ?? last.time) })}</dd>
              </>
            )}
          </dl>
        </div>,
        document.body,
      )}
    </span>
  )
})
