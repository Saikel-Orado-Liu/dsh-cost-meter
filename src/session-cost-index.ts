/**
 * The `sessionCostIndex` projection unit: durable assistant-message id →
 * ledger coordinates.
 *
 * DSH 0.1.5 renders the per-reply extension inside the completed Turn's action
 * row (`conversation.chat.assistant-actions`) and hands that slot only the
 * finalized message id, while the anchored cost ledger is keyed by
 * (turn, step). This index bridges the two.
 *
 * It is deliberately a unit of its own: it reads no pricebook and computes no
 * cost, so folding it can never re-price a session. The two cost ledgers keep
 * their cached checkpoints untouched, which matters because a cache-version
 * bump would replay every event against the pricebook mirror and could move
 * values for steps whose anchoring snapshot has since been pruned.
 *
 * @module @gamegeek-saikel/dsh-cost-meter/session-cost-index
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionCostCoordinates, SessionCostIndex } from './types.ts'

/** Internal fold state; the wire view is the identical shape. */
export type SessionCostIndexState = SessionCostIndex

const coordinatesSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
}).strict()

const indexSchema = z.object({
  steps: z.record(z.string(), coordinatesSchema),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Fold state behind `sessionCostIndex`. */
    sessionCostIndex: SessionCostIndexState
  }
}

/**
 * Fold one committed event onto the index: every `assistant/message` records
 * the durable id it finalized, keyed to its own (turn, step) coordinates — the
 * same coordinates the cost ledgers use, so a chip can sum the Turn's steps.
 * @param state - the state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference for events the unit does not own).
 */
export function foldSessionCostIndex(state: SessionCostIndexState, event: SessionEvent): SessionCostIndexState {
  if (event.type !== 'assistant/message') return state
  const id = event.data.message.id
  if (typeof id !== 'string' || id.length === 0) return state
  const previous = state.steps[id]
  if (previous !== undefined && previous.turn === event.data.turn && previous.step === event.data.step) return state
  return {
    ...state,
    steps: { ...state.steps, [id]: { turn: event.data.turn, step: event.data.step } },
  }
}

/**
 * The projection unit: a pricebook-free, pure map from finalized message id to
 * ledger coordinates.
 * @returns the definition to register with `ctx.sessionProjections`.
 */
export function sessionCostIndexProjection(): {
  key: 'sessionCostIndex'
  stateSchema: typeof indexSchema
  init: () => SessionCostIndexState
  apply: (state: SessionCostIndexState, event: SessionEvent) => SessionCostIndexState
  wire: {
    viewSchema: typeof indexSchema
    view: (state: SessionCostIndexState) => SessionCostIndex
  }
  stateVersion: number
} {
  return {
    key: 'sessionCostIndex',
    stateSchema: indexSchema,
    init: () => ({ steps: {} }),
    apply: foldSessionCostIndex,
    wire: {
      viewSchema: indexSchema,
      view: state => state,
    },
    stateVersion: 1,
  }
}
