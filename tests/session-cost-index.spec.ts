/**
 * `sessionCostIndex` coverage: the finalized-message id → ledger coordinates
 * map the per-reply chip resolves through. The unit is pricebook-free by
 * design, so these cases pin its purity (no cost, no pricebook read) as much
 * as its folding.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSessionCostIndex, sessionCostIndexProjection } from '../src/session-cost-index.ts'

function event(type: string, data: Record<string, unknown>): SessionEvent {
  return { type, seq: 0, time: 0, data } as unknown as SessionEvent
}

/** One `assistant/message` carrying a durable message id and its coordinates. */
function messageEvent(turn: number, step: number, id: string): SessionEvent {
  return event('assistant/message', { turn, step, message: { id, content: [] } })
}

describe('foldSessionCostIndex', () => {
  it('maps a finalized message id to its turn and step', () => {
    const state = foldSessionCostIndex({ steps: {} }, messageEvent(3, 2, 'msg-a'))
    expect(state.steps).toEqual({ 'msg-a': { turn: 3, step: 2 } })
  })

  it('accumulates every finalized message of the session', () => {
    let state = foldSessionCostIndex({ steps: {} }, messageEvent(1, 1, 'msg-a'))
    state = foldSessionCostIndex(state, messageEvent(2, 1, 'msg-b'))
    state = foldSessionCostIndex(state, messageEvent(2, 2, 'msg-c'))
    expect(state.steps).toEqual({
      'msg-a': { turn: 1, step: 1 },
      'msg-b': { turn: 2, step: 1 },
      'msg-c': { turn: 2, step: 2 },
    })
  })

  it('keeps the same state reference for events it does not own', () => {
    const state = { steps: { 'msg-a': { turn: 1, step: 1 } } }
    expect(foldSessionCostIndex(state, event('request/context', { provider: 'p', model: 'm' }))).toBe(state)
    expect(foldSessionCostIndex(state, event('turn/start', { turn: 2 }))).toBe(state)
  })

  it('keeps the same state reference when the coordinates did not move', () => {
    const state = { steps: { 'msg-a': { turn: 1, step: 1 } } }
    expect(foldSessionCostIndex(state, messageEvent(1, 1, 'msg-a'))).toBe(state)
  })

  it('re-anchors a message id whose coordinates changed', () => {
    const state = foldSessionCostIndex({ steps: {} }, messageEvent(1, 1, 'msg-a'))
    const moved = foldSessionCostIndex(state, messageEvent(4, 2, 'msg-a'))
    expect(moved.steps['msg-a']).toEqual({ turn: 4, step: 2 })
  })

  it('ignores messages without a usable durable id', () => {
    const state = { steps: {} }
    expect(foldSessionCostIndex(state, event('assistant/message', { turn: 1, step: 1, message: {} }))).toBe(state)
    expect(foldSessionCostIndex(state, event('assistant/message', { turn: 1, step: 1, message: { id: '' } }))).toBe(state)
  })
})

describe('sessionCostIndexProjection', () => {
  it('declares the index key, an empty init, and its own state version', () => {
    const unit = sessionCostIndexProjection()
    expect(unit.key).toBe('sessionCostIndex')
    expect(unit.init()).toEqual({ steps: {} })
    expect(unit.stateVersion).toBe(1)
    expect(unit.wire.view(unit.init())).toEqual({ steps: {} })
  })

  it('validates the folded state through the persisted-state schema', () => {
    const unit = sessionCostIndexProjection()
    const state = unit.apply(unit.init(), messageEvent(2, 1, 'msg-a'))
    expect(unit.stateSchema.parse(state)).toEqual({ steps: { 'msg-a': { turn: 2, step: 1 } } })
    expect(unit.wire.viewSchema.parse(unit.wire.view(state))).toEqual(state)
  })
})
