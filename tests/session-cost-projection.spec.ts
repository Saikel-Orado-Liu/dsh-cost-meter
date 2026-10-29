/**
 * sessionCost projection coverage: model capture from request/context, usage
 * message finalization (stream usage arrives once, on assistant/message), the
 * cost formula (cache writes at the uncached input rate), snapshot-time
 * anchoring with immutable written rows (price changes never recompute old
 * steps), peak/off-peak band selection at the EVENT time, unpriced models,
 * and totals math.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { initialPricebookState, PricebookHandle } from '../src/pricebook.ts'
import { foldSessionCost, type SessionCostState, usageBuckets, viewSessionCost } from '../src/session-cost-projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FALLBACK_CURRENT, FALLBACK_PEAK } from '../src/pricing.ts'
import type { ModelPrice, PricebookSnapshot } from '../src/types.ts'

/** 2026-08-17 10:00 Beijing (peak). */
const POST_PEAK = Date.UTC(2026, 7, 17, 2, 0, 0)
/** 2026-08-17 20:00 Beijing (off-peak). */
const POST_OFFPEAK = Date.UTC(2026, 7, 17, 12, 0, 0)

const flashPrices: Record<string, ModelPrice> = {
  flash: {
    source: 'official',
    single: FALLBACK_CURRENT.flash,
    offPeak: FALLBACK_PEAK.flash.offPeak,
    peak: FALLBACK_PEAK.flash.peak,
  },
}

function snapshotFixture(version: number, effectiveAt: number, web = { searchPerThousand: 5, fetchPerThousand: 5 }): PricebookSnapshot {
  return { version, currency: 'CNY', effectiveAt, source: 'official', usdCnyRate: null, prices: { ...flashPrices }, web }
}

function handleWith(snapshots: PricebookSnapshot[]): PricebookHandle {
  return new PricebookHandle({} as Context, {
    fxApiUrl: 'https://fx.invalid',
    defaultFxRate: 7.2,
    openRouterModelsUrl: 'https://or.invalid',
    openRouterEnabled: true,
    snapshotHistoryLimit: 50,
  }, { ...initialPricebookState(), snapshots })
}

const init = (): SessionCostState => ({
  model: null,
  steps: {},
  totals: { uncachedCost: 0, cacheReadCost: 0, outputCost: 0, cost: 0, pricedSteps: 0, unpricedSteps: 0, steps: 0, webCost: 0, searchRequests: 0, fetchRequests: 0 },
  pendingWeb: {},
  callRoots: {},
  lastCoords: null,
  webBillingStarted: false,
})

function event(type: string, time: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq: 0, time, data } as unknown as SessionEvent
}


/** 2026-11-02 10:00 Beijing: after the Search/Fetch billing start. */
const POST_WEB_BILLING = Date.UTC(2026, 10, 2, 2, 0, 0)
/** 2026-10-30 10:00 Beijing: inside the official grace period. */
const PRE_WEB_BILLING = Date.UTC(2026, 9, 30, 2, 0, 0)

function toolCall(time: number, turn: number, step: number, callId: string, name: string, args: unknown): SessionEvent {
  return event('tool/call', time, { turn, step, callId, name, arguments: JSON.stringify(args) })
}

function toolResult(time: number, turn: number, step: number, callId: string, isError = false): SessionEvent {
  return event('tool/result', time, { turn, step, message: { role: 'tool', toolCallId: callId, isError, content: [] } })
}

function ptcDispatch(time: number, rootCallId: string, name: string, args: unknown, isError = false): SessionEvent {
  return event('tool/ptc-dispatch', time, { rootCallId, parentCallId: rootCallId, subCallId: `${rootCallId}:ptc:1`, name, arguments: args, isError, content: [] })
}

function headerEvent(time: number, model = 'deepseek-v4-flash', provider = 'deepseek-official'): SessionEvent {
  return event('request/context', time, { provider, model })
}

function usageEvent(time: number, turn: number, step: number, usage: Record<string, number>): SessionEvent {
  return event('assistant/message', time, { turn, step, message: {}, usage })
}

describe('usageBuckets', () => {
  it('normalizes optional cache buckets to zero', () => {
    expect(usageBuckets({ inputTokens: 10, outputTokens: 5 }))
      .toEqual({ uncached: 10, cacheRead: 0, cacheWrite: 0, output: 5 })
  })
})

describe('foldSessionCost model capture', () => {
  it('records the session model from request/context', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000, 'deepseek-v4-pro'), handle)
    expect(state.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    // Same model: no new state reference.
    const again = foldSessionCost(state, headerEvent(2_000, 'deepseek-v4-pro'), handle)
    expect(again).toBe(state)
  })
})

describe('foldSessionCost pricing and anchoring', () => {
  it('prices a step at the event-time band and snapshot (peak hour)', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(POST_PEAK, 1, 1, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    const step = viewSessionCost(state).steps[0]
    expect(step.priced).toBe(true)
    expect(step.band).toBe('peak')
    expect(step.snapshotVersion).toBe(1)
    // 1M × 2 + 1M × 0.04 + 1M × 8 = 10.04
    expect(step.cost).toBeCloseTo(10.04)
    expect(step.uncachedCost).toBeCloseTo(2)
    expect(step.cacheReadCost).toBeCloseTo(0.04)
    expect(step.outputCost).toBeCloseTo(8)
    expect(state.totals.cost).toBeCloseTo(10.04)
    expect(state.totals.pricedSteps).toBe(1)
  })

  it('prices an off-peak event at the off-peak band', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(POST_OFFPEAK, 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    // 1M × 1 + 1M × 4 = 5
    expect(viewSessionCost(state).steps[0].cost).toBeCloseTo(5)
    expect(viewSessionCost(state).steps[0].band).toBe('offPeak')
  })

  it('prices pre-rollout events at the single list price', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(Date.UTC(2026, 7, 10, 4, 0, 0), 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    // 1M × 1 + 1M × 2 = 3
    expect(viewSessionCost(state).steps[0].cost).toBeCloseTo(3)
    expect(viewSessionCost(state).steps[0].band).toBe('single')
  })

  it('replaces the first usage sample with the final assistant/message sample', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(5_000, 1, 1, { inputTokens: 10, outputTokens: 20 }), handle)
    expect(state.totals.cost).toBeCloseTo((10 * 1 + 20 * 2) / 1_000_000)
    state = foldSessionCost(state, usageEvent(6_000, 1, 1, { inputTokens: 100, outputTokens: 200 }), handle)
    const view = viewSessionCost(state)
    expect(view.steps).toHaveLength(1)
    expect(view.steps[0].uncachedInputTokens).toBe(100)
    expect(view.steps[0].time).toBe(6_000)
    expect(state.totals.cost).toBeCloseTo((100 * 1 + 200 * 2) / 1_000_000)
    expect(state.totals.steps).toBe(1)
  })

  it('anchors written rows immutably: a later price change never recomputes them', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(POST_PEAK, 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    const before = viewSessionCost(state).steps[0]

    // Prices change: a new snapshot becomes effective AFTER the old event.
    const changedPrices: Record<string, ModelPrice> = {
      flash: {
        source: 'official',
        single: { cacheReadPerMillion: 0.5, inputPerMillion: 50, outputPerMillion: 100 },
        offPeak: { cacheReadPerMillion: 0.5, inputPerMillion: 50, outputPerMillion: 100 },
        peak: { cacheReadPerMillion: 0.5, inputPerMillion: 50, outputPerMillion: 100 },
      },
    }
    handle.state = {
      ...handle.state,
      snapshots: [...handle.state.snapshots, { version: 2, currency: 'CNY', effectiveAt: POST_PEAK + 1_000, source: 'official', usdCnyRate: null, prices: changedPrices }],
    }

    // A later step prices at the NEW snapshot; the old step keeps version 1.
    state = foldSessionCost(state, usageEvent(POST_PEAK + 5_000, 1, 2, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    const view = viewSessionCost(state)
    expect(view.steps[0]).toEqual(before)
    expect(view.steps[0].snapshotVersion).toBe(1)
    expect(view.steps[1].snapshotVersion).toBe(2)
    expect(view.steps[1].cost).toBeCloseTo(150)

    // Replay from init folds the OLD event against the OLD snapshot (v1).
    let replay = init()
    replay = foldSessionCost(replay, headerEvent(1_000), handle)
    replay = foldSessionCost(replay, usageEvent(POST_PEAK, 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    expect(viewSessionCost(replay).steps[0]).toEqual(before)
  })

  it('marks steps unpriced when the model has no price anywhere', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000, 'claude-sonnet-4', 'anthropic'), handle)
    state = foldSessionCost(state, usageEvent(2_000, 1, 1, { inputTokens: 100, outputTokens: 50 }), handle)
    const step = viewSessionCost(state).steps[0]
    expect(step.priced).toBe(false)
    expect(step.cost).toBeNull()
    expect(step.unpricedReason).toBe('NO_PRICE')
    expect(step.uncachedInputTokens).toBe(100) // tokens still recorded
    expect(state.totals.unpricedSteps).toBe(1)
    expect(state.totals.cost).toBe(0)
  })

  it('marks steps unpriced with NO_MODEL when no request/context was seen', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    const state = foldSessionCost(init(), usageEvent(2_000, 1, 1, { inputTokens: 100, outputTokens: 50 }), handle)
    expect(viewSessionCost(state).steps[0].unpricedReason).toBe('NO_MODEL')
  })

  it('ignores zero usage and unrelated events (same state reference)', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    const zero = foldSessionCost(state, usageEvent(2_000, 1, 1, { inputTokens: 0, outputTokens: 0 }), handle)
    expect(zero).toBe(state)
    const unrelated = foldSessionCost(state, event('turn/start', 2_000, { turn: 1 }), handle)
    expect(unrelated).toBe(state)
  })

  it('sorts the view by turn then step and sums totals across turns', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(2_000, 2, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    state = foldSessionCost(state, usageEvent(3_000, 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    const view = viewSessionCost(state)
    expect(view.steps.map(step => step.turn)).toEqual([1, 2])
    expect(view.totals.cost).toBeCloseTo(6)
    expect(view.totals.steps).toBe(2)
  })
})
describe('Search / Fetch billing', () => {
  it('counts successful Search requests and prices them after the billing start', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING, 1, 1, 'c1', 'web_search', { queries: ['a', 'b', 'a'] }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 10, 1, 1, 'c1'), handle)
    const view = viewSessionCost(state)
    expect(view.web).toMatchObject({ searchRequests: 2, fetchRequests: 0, billingStarted: true })
    // 2 requests × 5元 / 1000
    expect(view.web?.cost).toBeCloseTo(0.01)
    expect(view.totals.webCost).toBeCloseTo(0.01)
    expect(view.totals.cost).toBeCloseTo(0.01)
    expect(view.steps).toHaveLength(1)
    expect(view.steps[0].searchRequests).toBe(2)
  })

  it('counts Fetch requests at the same per-request rate', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING, 1, 1, 'c1', 'web_fetch', { url: 'https://example.com' }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 10, 1, 1, 'c1'), handle)
    expect(viewSessionCost(state).web).toMatchObject({ searchRequests: 0, fetchRequests: 1, cost: 0.005 })
  })

  it('counts requests during the grace period but prices them at zero', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(PRE_WEB_BILLING, 1, 1, 'c1', 'web_search', { queries: ['a'] }), handle)
    state = foldSessionCost(state, toolResult(PRE_WEB_BILLING + 10, 1, 1, 'c1'), handle)
    const view = viewSessionCost(state)
    expect(view.web).toMatchObject({ searchRequests: 1, cost: 0, billingStarted: false })
    expect(view.totals.cost).toBe(0)
  })

  it('never bills a failed call', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING, 1, 1, 'c1', 'web_search', { queries: ['a'] }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 10, 1, 1, 'c1', true), handle)
    expect(viewSessionCost(state).web).toMatchObject({ searchRequests: 0, cost: 0 })
  })

  it('attributes a PTC web sub-call to its root tool step', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING, 2, 3, 'root', 'run_code', {}), handle)
    state = foldSessionCost(state, ptcDispatch(POST_WEB_BILLING + 10, 'root', 'web_fetch', { url: 'https://example.com' }), handle)
    const view = viewSessionCost(state)
    expect(view.steps[0]).toMatchObject({ turn: 2, step: 3, fetchRequests: 1 })
    expect(view.web?.cost).toBeCloseTo(0.005)
  })

  it('anchors web prices to the snapshot effective at the call time', () => {
    const handle = handleWith([snapshotFixture(1, 0, { searchPerThousand: 5, fetchPerThousand: 5 })])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING, 1, 1, 'c1', 'web_search', { queries: ['a'] }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 10, 1, 1, 'c1'), handle)
    const before = viewSessionCost(state).steps[0]
    handle.state = {
      ...handle.state,
      snapshots: [...handle.state.snapshots, snapshotFixture(2, POST_WEB_BILLING + 1_000, { searchPerThousand: 50, fetchPerThousand: 50 })],
    }
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING + 2_000, 1, 2, 'c2', 'web_search', { queries: ['a'] }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 2_010, 1, 2, 'c2'), handle)
    const view = viewSessionCost(state)
    expect(view.steps[0]).toEqual(before)
    expect(view.steps[1].cost).toBeCloseTo(0.05)
  })

  it('adds web cost to a token step without disturbing its token buckets', () => {
    const handle = handleWith([snapshotFixture(1, 0)])
    let state = init()
    state = foldSessionCost(state, headerEvent(1_000), handle)
    state = foldSessionCost(state, usageEvent(POST_WEB_BILLING, 1, 1, { inputTokens: 1_000_000, outputTokens: 1_000_000 }), handle)
    state = foldSessionCost(state, toolCall(POST_WEB_BILLING + 10, 1, 1, 'c1', 'web_fetch', { url: 'https://example.com' }), handle)
    state = foldSessionCost(state, toolResult(POST_WEB_BILLING + 20, 1, 1, 'c1'), handle)
    const step = viewSessionCost(state).steps[0]
    // 10:00 Beijing is peak: 1M × 2 + 1M × 8 = 10; plus one Fetch request 0.005
    expect(step.cost).toBeCloseTo(10.005)
    expect(step.webCost).toBeCloseTo(0.005)
    expect(step.uncachedInputTokens).toBe(1_000_000)
    expect(state.totals.cost).toBeCloseTo(10.005)
  })
})