/**
 * Pure-function coverage for the host half: trust fence, balance parsing,
 * key resolution, and the provider call with a mocked fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_API_KEY_ENV,
  fetchBalance,
  isLoopbackHostname,
  isTrustedRequest,
  pickBalanceInfo,
  PUBLIC_BASE_URL,
  resolveApiKey,
} from '../src/index.ts'
import type { WireBalanceResponse } from '../src/types.ts'

const mockFetch = vi.fn<typeof fetch>()

afterEach(() => {
  vi.restoreAllMocks()
  mockFetch.mockReset()
})

describe('isLoopbackHostname', () => {
  it('accepts localhost, IPv6 loopback, and any IPv4 address in 127/8', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.255.255.254')).toBe(true)
  })

  it('rejects public addresses and malformed IPv4 segments', () => {
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('192.168.1.1')).toBe(false)
    expect(isLoopbackHostname('127.0.0.256')).toBe(false)
    expect(isLoopbackHostname('127.0.0')).toBe(false)
  })
})

describe('isTrustedRequest', () => {
  it('accepts loopback Host headers without a trust list', () => {
    expect(isTrustedRequest({ host: '127.0.0.1:3080' }, [])).toBe(true)
    expect(isTrustedRequest({ host: 'localhost' }, [])).toBe(true)
  })

  it('accepts declared trusted authorities and rejects everything else', () => {
    const trusted = ['192.168.1.10:3080']
    expect(isTrustedRequest({ host: '192.168.1.10:3080' }, trusted)).toBe(true)
    expect(isTrustedRequest({ host: '192.168.1.10' }, trusted)).toBe(false)
    expect(isTrustedRequest({ host: 'evil.example' }, trusted)).toBe(false)
  })

  it('rejects missing or unparsable Host headers', () => {
    expect(isTrustedRequest({}, [])).toBe(false)
    expect(isTrustedRequest({ host: 'not an authority' }, [])).toBe(false)
  })
})

describe('pickBalanceInfo', () => {
  it('converts the first row decimal strings to numbers', () => {
    const wire: WireBalanceResponse = {
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      ],
    }
    expect(pickBalanceInfo(wire)).toEqual({ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 })
  })

  it('returns null without rows and defaults missing split fields to zero', () => {
    expect(pickBalanceInfo({})).toBeNull()
    expect(pickBalanceInfo({ balance_infos: [{ currency: 'USD', total_balance: '5.5' }] }))
      .toEqual({ currency: 'USD', total: 5.5, granted: 0, toppedUp: 0 })
  })
})

describe('resolveApiKey', () => {
  it('prefers the credential seam over the environment', async () => {
    const credentials = { resolve: vi.fn(async () => ({ value: 'seam-key', source: 'test' })) }
    const ctx = { get: vi.fn(() => credentials) } as unknown as Context
    expect(await resolveApiKey(ctx, DEFAULT_API_KEY_ENV)).toBe('seam-key')
  })

  it('falls back to the environment when no seam is composed', async () => {
    const ctx = { get: vi.fn(() => undefined) } as unknown as Context
    const previous = process.env[DEFAULT_API_KEY_ENV]
    process.env[DEFAULT_API_KEY_ENV] = 'env-key'
    try {
      expect(await resolveApiKey(ctx, DEFAULT_API_KEY_ENV)).toBe('env-key')
    } finally {
      if (previous === undefined) delete process.env[DEFAULT_API_KEY_ENV]
      else process.env[DEFAULT_API_KEY_ENV] = previous
    }
  })

  it('returns undefined when the key is absent everywhere', async () => {
    const ctx = { get: vi.fn(() => undefined) } as unknown as Context
    const previous = process.env[DEFAULT_API_KEY_ENV]
    delete process.env[DEFAULT_API_KEY_ENV]
    try {
      expect(await resolveApiKey(ctx, DEFAULT_API_KEY_ENV)).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env[DEFAULT_API_KEY_ENV] = previous
    }
  })
})

describe('fetchBalance', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
  })

  const config = {
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    baseURL: PUBLIC_BASE_URL,
    refreshMs: 60_000,
    pricingRefreshHours: 6,
    trustedHosts: [],
  }

  it('folds a healthy provider response into an ok snapshot', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
      }),
    } as unknown as Response)
    const ctx = { get: vi.fn(() => ({ resolve: async () => ({ value: 'key', source: 'test' }) })) } as unknown as Context
    const snapshot = await fetchBalance(ctx, config)
    expect(snapshot).toMatchObject({ ok: true, isAvailable: true })
    if (snapshot.ok) expect(snapshot.balance).toEqual({ currency: 'CNY', total: 110, granted: 0, toppedUp: 0 })
    expect(mockFetch).toHaveBeenCalledWith(
      `${PUBLIC_BASE_URL}/user/balance`,
      expect.objectContaining({ headers: { authorization: 'Bearer key' } }),
    )
  })

  it('reports MISSING_CREDENTIAL without any key', async () => {
    const ctx = { get: vi.fn(() => undefined) } as unknown as Context
    const previous = process.env[DEFAULT_API_KEY_ENV]
    delete process.env[DEFAULT_API_KEY_ENV]
    try {
      const snapshot = await fetchBalance(ctx, config)
      expect(snapshot).toMatchObject({ ok: false, code: 'MISSING_CREDENTIAL' })
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      if (previous !== undefined) process.env[DEFAULT_API_KEY_ENV] = previous
    }
  })

  it('reports NETWORK when the provider call throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const ctx = { get: vi.fn(() => ({ resolve: async () => ({ value: 'key', source: 'test' }) })) } as unknown as Context
    const snapshot = await fetchBalance(ctx, config)
    expect(snapshot).toMatchObject({ ok: false, code: 'NETWORK' })
  })

  it('reports HTTP_<status> for non-2xx provider answers', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as unknown as Response)
    const ctx = { get: vi.fn(() => ({ resolve: async () => ({ value: 'bad-key', source: 'test' }) })) } as unknown as Context
    const snapshot = await fetchBalance(ctx, config)
    expect(snapshot).toMatchObject({ ok: false, code: 'HTTP_401' })
  })

  it('never throws: unparsable provider bodies become ok:false snapshots', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new SyntaxError('unexpected token') },
    } as unknown as Response)
    const ctx = { get: vi.fn(() => ({ resolve: async () => ({ value: 'key', source: 'test' }) })) } as unknown as Context
    const snapshot = await fetchBalance(ctx, config)
    expect(snapshot).toMatchObject({ ok: false })
  })
});
