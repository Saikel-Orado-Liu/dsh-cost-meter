/**
 * dsh-fare-meter host half: serves the DeepSeek account balance
 * (official `GET /user/balance`), the pricebook (persisted, snapshot-anchored
 * per-model pricing over the official page / built-in fallback / OpenRouter
 * chain), and drives the `sessionCost` projection that folds every usage
 * event into an immutable per-step cost ledger.
 *
 * The API key resolves per refresh through the credential seam; the balance
 * is cached for `refreshMs` to stay polite to the provider's rate limits;
 * the pricebook refresh cadence is `pricingRefreshHours`. The `/fare-meter`
 * route serves the balance + pricebook view (GET) and applies settings
 * mutations and manual refreshes (POST, trust-fenced like the balance route).
 *
 * @module @gamegeek-saikel/dsh-fare-meter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { fetchPricing } from './pricing.ts'
import {
  DEFAULT_ALIASES,
  DEFAULT_CACHE_READ_DISCOUNT,
  DEFAULT_FX_RATE,
  DEFAULT_SNAPSHOT_HISTORY_LIMIT,
  FX_API_URL,
  OPENROUTER_MODELS_URL,
  PricebookHandle,
  type PricebookResolvedConfig,
} from './pricebook.ts'
import { sessionCostProjection } from './session-cost-projection.ts'
import { collectSubagentCosts, type SubagentAgentsService, type SubagentSessionsService } from './subagent-cost.ts'
import type { BalanceInfo, BalanceSnapshot, ConversationCostResponse, ModelPrice, PricebookView, WireBalanceResponse } from './types.ts'

export type * from './types.ts'
export * from './pricing.ts'
export * from './pricebook.ts'
export * from './session-cost-projection.ts'
export * from './subagent-cost.ts'

/** Stable Cordis plugin name. */
export const name = 'fare-meter'
/** Services required before the route and the projection can register. */
export const inject = ['webServer', 'sessionProjections']

/** Public DeepSeek API base; the internal endpoint comes from config `baseURL`. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'
/** Default credential reference, matching the llm-deepseek adapter. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
/** How long a successful balance snapshot stays fresh (milliseconds). */
export const DEFAULT_REFRESH_MS = 60_000
/** How long a failed refresh stays cached before retrying (milliseconds). */
const FAILED_REFRESH_MS = 10_000
/** Per-request timeout for the provider balance call (milliseconds). */
const BALANCE_TIMEOUT_MS = 10_000
/** Default cadence for re-fetching the official pricing page (hours). */
export const DEFAULT_PRICING_REFRESH_HOURS = 6
/** Max POST body accepted by the settings route (bytes). */
const MAX_BODY_BYTES = 256 * 1024

/** Plugin config: every field is optional in yml and has a sensible default. */
export interface Config {
  /** Credential reference resolved per refresh; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; the balance path `/user/balance` is appended. Defaults to the public API. */
  baseURL?: string
  /** Balance cache lifetime in milliseconds; defaults to 60s. */
  refreshMs?: number
  /** Hours between official-pricing page refreshes; defaults to 6. */
  pricingRefreshHours?: number
  /** Non-loopback authorities this deployment serves, mirroring client-connection trustedHosts. */
  trustedHosts?: string[]
  /** Free exchange-rate endpoint (USD base, `rates.CNY`); defaults to open.er-api.com. */
  fxApiUrl?: string
  /** Fallback USD→CNY rate when auto-fetch never succeeded; defaults to 7.2. */
  defaultFxRate?: number
  /** OpenRouter models directory; defaults to openrouter.ai. */
  openRouterModelsUrl?: string
  /** Whether OpenRouter is allowed as a fallback price source; defaults to true. */
  openRouterEnabled?: boolean
  /** Cap on the persisted snapshot history; defaults to 50. */
  snapshotHistoryLimit?: number
  /** Manual per-model price overrides (the settings section also edits these). */
  overrides?: Record<string, ModelPrice>
  /** OpenRouter model-id → canonical key aliases (the settings section also edits these). */
  aliases?: Record<string, string>
  /** Cache-read price as a fraction of the uncached input price (OpenRouter only). */
  cacheReadDiscount?: number
  /** Exchange-rate mode: auto-fetch or a manually pinned rate. */
  fxMode?: 'auto' | 'manual'
  /** Manually pinned USD→CNY rate (used in manual mode, auto-mode fallback). */
  manualRate?: number
  /** Whether the balance readout is shown in the UI. */
  balanceEnabled?: boolean
}

const modelPriceSchema = z.object({
  single: z.object({
    cacheReadPerMillion: z.number().min(0),
    inputPerMillion: z.number().min(0),
    outputPerMillion: z.number().min(0),
  }),
  offPeak: z.object({
    cacheReadPerMillion: z.number().min(0),
    inputPerMillion: z.number().min(0),
    outputPerMillion: z.number().min(0),
  }),
  peak: z.object({
    cacheReadPerMillion: z.number().min(0),
    inputPerMillion: z.number().min(0),
    outputPerMillion: z.number().min(0),
  }),
})

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(PUBLIC_BASE_URL),
  refreshMs: z.natural().min(1000).default(DEFAULT_REFRESH_MS),
  pricingRefreshHours: z.number().min(1).default(DEFAULT_PRICING_REFRESH_HOURS),
  trustedHosts: z.array(z.string()).default([]),
  fxApiUrl: z.string().default(FX_API_URL),
  defaultFxRate: z.number().min(0.001).default(DEFAULT_FX_RATE),
  openRouterModelsUrl: z.string().default(OPENROUTER_MODELS_URL),
  openRouterEnabled: z.boolean().default(true),
  snapshotHistoryLimit: z.natural().min(1).default(DEFAULT_SNAPSHOT_HISTORY_LIMIT),
  overrides: z.dict(modelPriceSchema, z.string()).default({}),
  aliases: z.dict(z.string(), z.string()).default({ ...DEFAULT_ALIASES }),
  cacheReadDiscount: z.number().min(0).max(1).default(DEFAULT_CACHE_READ_DISCOUNT),
  fxMode: z.union(['auto', 'manual']).default('auto'),
  manualRate: z.number().min(0.001).default(DEFAULT_FX_RATE),
  balanceEnabled: z.boolean().default(true),
}) as z<Config>

/** Resolved plugin facts after schema defaults. */
export interface ResolvedConfig {
  apiKeyEnv: string
  baseURL: string
  refreshMs: number
  pricingRefreshHours: number
  trustedHosts: readonly string[]
  fxApiUrl: string
  defaultFxRate: number
  openRouterModelsUrl: string
  openRouterEnabled: boolean
  snapshotHistoryLimit: number
}

/** Normalized authority of a Host-header value, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Browser-trust fence for the balance route, mirroring the /api fence: the
 * Host header is the one header DNS rebinding cannot forge, and loopback or
 * a declared trusted authority passes.
 * @param headers - request headers.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the request Host is ours.
 */
export function isTrustedRequest(headers: IncomingMessage['headers'], trustedHosts: readonly string[]): boolean {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (isLoopbackHostname(hostUrl.hostname)) return true
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    return entryUrl !== undefined && entryUrl.host === hostUrl.host
  })
}

/**
 * Resolve the API key for one refresh: the credential seam first, the
 * process environment as fallback when no seam is composed.
 * @param ctx - host context.
 * @param env - the credential reference name.
 * @returns the resolved key, or undefined when absent everywhere.
 */
export async function resolveApiKey(ctx: Context, env: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(credentialRef(env))
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const ambient = process.env[env]
  return ambient !== undefined && ambient.length > 0 ? ambient : undefined
}

/**
 * Parse the first balance row, converting the provider's decimal strings to
 * numbers.
 * @param wire - the parsed provider response.
 * @returns the first row, or null when the response carried no rows.
 */
export function pickBalanceInfo(wire: WireBalanceResponse): BalanceInfo | null {
  const info = wire.balance_infos?.[0]
  if (info === undefined) return null
  return {
    currency: info.currency,
    total: Number(info.total_balance),
    granted: Number(info.granted_balance ?? 0),
    toppedUp: Number(info.topped_up_balance ?? 0),
  }
}

/**
 * One provider balance call: resolve the key, GET /user/balance, and fold
 * the result into a {@link BalanceSnapshot}. Never throws — every failure
 * becomes an ok:false snapshot.
 * @param ctx - host context.
 * @param config - resolved plugin facts.
 * @returns the folded snapshot.
 */
export async function fetchBalance(ctx: Context, config: ResolvedConfig): Promise<BalanceSnapshot> {
  const key = await resolveApiKey(ctx, config.apiKeyEnv)
  if (key === undefined) {
    return {
      ok: false,
      code: 'MISSING_CREDENTIAL',
      message: `fare-meter: no API key for "${config.apiKeyEnv}"; store it through the credentials service or export it in the launching environment`,
    }
  }
  let response: Response
  try {
    response = await fetch(`${config.baseURL}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      ok: false,
      code: 'NETWORK',
      message: `fare-meter: balance request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      message: `fare-meter: balance endpoint answered ${response.status} ${response.statusText}`,
    }
  }
  let wire: WireBalanceResponse
  try {
    wire = await response.json() as WireBalanceResponse
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_RESPONSE',
      message: `fare-meter: balance body unparsable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return {
    ok: true,
    isAvailable: wire.is_available === true,
    balance: pickBalanceInfo(wire),
    fetchedAt: Date.now(),
  }
}

/** Read a bounded JSON request body. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const part = chunk as Buffer
    total += part.length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(part)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  return JSON.parse(text) as unknown
}

/** The only POST action left: an immediate remote refresh. The editable
 *  configuration moved to the `fare-meter` settings section. */
interface SettingsAction {
  action: 'refresh'
}

/** The `fare-meter` settings namespace (plugin configuration page). */
export const SETTINGS_NAMESPACE = settingsNamespace('fare-meter')

/**
 * Mount the plugin: open the pricebook domain, refresh every remote source,
 * register the `sessionCost` projection, register the /fare-meter
 * route (GET view + POST settings/refresh), and keep the balance and the
 * official pricing fresh.
 * @param ctx - host context.
 * @param config - plugin config (schema defaults applied by the Loader).
 */
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const resolved: ResolvedConfig = {
    apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: config?.baseURL ?? PUBLIC_BASE_URL,
    refreshMs: config?.refreshMs ?? DEFAULT_REFRESH_MS,
    pricingRefreshHours: config?.pricingRefreshHours ?? DEFAULT_PRICING_REFRESH_HOURS,
    trustedHosts: config?.trustedHosts ?? [],
    fxApiUrl: config?.fxApiUrl ?? FX_API_URL,
    defaultFxRate: config?.defaultFxRate ?? DEFAULT_FX_RATE,
    openRouterModelsUrl: config?.openRouterModelsUrl ?? OPENROUTER_MODELS_URL,
    openRouterEnabled: config?.openRouterEnabled ?? true,
    snapshotHistoryLimit: config?.snapshotHistoryLimit ?? DEFAULT_SNAPSHOT_HISTORY_LIMIT,
  }
  const pricebookConfig: PricebookResolvedConfig = {
    fxApiUrl: resolved.fxApiUrl,
    defaultFxRate: resolved.defaultFxRate,
    openRouterModelsUrl: resolved.openRouterModelsUrl,
    openRouterEnabled: resolved.openRouterEnabled,
    snapshotHistoryLimit: resolved.snapshotHistoryLimit,
  }

  // ── Pricebook: load persisted state, then refresh every remote source. ──
  const pricebook = new PricebookHandle(ctx, pricebookConfig, undefined)
  await pricebook.init()
  await pricebook.refresh()
  ctx.effect(() => () => {
    void pricebook.close()
  }, 'fare-meter: pricebook domain')

  // ── Plugin configuration section: the settings page renders the standard
  //  card; every resolved change is applied to the pricebook and re-anchors.
  let currentSettings: () => Config = () => config ?? {}
  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, (config ?? {}) as never, {
    setSource: (source) => {
      currentSettings = source as () => Config
    },
    onChange: () => {
      pricebook.applySettings(currentSettings())
    },
  })

  // ── sessionCost projection: anchored per-step ledger. ──
  ctx.effect(
    () => ctx.sessionProjections.register(sessionCostProjection(pricebook)),
    'fare-meter: sessionCost projection',
  )

  // ── Balance: cached refresh, one in-flight at a time. ──
  let lastBalance: { at: number; snapshot: BalanceSnapshot } | undefined
  let inflight: Promise<BalanceSnapshot> | undefined
  const refresh = (): Promise<BalanceSnapshot> => {
    const now = Date.now()
    const ttl = lastBalance === undefined
      ? 0
      : lastBalance.snapshot.ok ? resolved.refreshMs : FAILED_REFRESH_MS
    if (lastBalance !== undefined && now - lastBalance.at < ttl) {
      return Promise.resolve(lastBalance.snapshot)
    }
    if (inflight === undefined) {
      inflight = fetchBalance(ctx, resolved).then((snapshot) => {
        lastBalance = { at: Date.now(), snapshot }
        inflight = undefined
        return snapshot
      }, (error) => {
        inflight = undefined
        return {
          ok: false,
          code: 'INTERNAL',
          message: `fare-meter: ${error instanceof Error ? error.message : String(error)}`,
        } as BalanceSnapshot
      })
    }
    return inflight
  }

  // ── Pricing: refresh on startup and on the configured cadence. ──
  const pricingTimer = setInterval(() => {
    void pricebook.refresh()
  }, resolved.pricingRefreshHours * 3_600_000)
  pricingTimer.unref?.()
  ctx.effect(() => () => clearInterval(pricingTimer), 'fare-meter: pricing refresh timer')

  const respond = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  /** Parse the `session` query parameter (the requesting session id). */
  const sessionOf = (req: IncomingMessage): string | undefined => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const value = url.searchParams.get('session')
      return value === null || value.length === 0 ? undefined : value
    } catch {
      return undefined
    }
  }

  const buildResponse = async (rootSessionId: string | undefined): Promise<ConversationCostResponse> => {
    const agents = ctx.get('agents') as SubagentAgentsService | undefined
    const sessionsStore = ctx.get('sessions') as SubagentSessionsService | undefined
    const subagents = rootSessionId === undefined || agents === undefined || sessionsStore === undefined
      ? []
      : collectSubagentCosts(rootSessionId, agents, sessionsStore, ctx.sessionProjections)
    return {
      balance: await refresh(),
      pricebook: pricebook.view(),
      subagents,
    }
  }

  const route: WebRoute = {
    kind: 'exact',
    path: '/fare-meter',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' })
        res.end('method not allowed')
        return
      }
      if (!isTrustedRequest(req.headers, resolved.trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method === 'POST') {
        let action: SettingsAction
        try {
          const body = await readBody(req) as Record<string, unknown>
          if (body.action !== 'refresh') throw new Error(`unknown action "${String(body.action)}"`)
          action = { action: 'refresh' }
        } catch (error) {
          respond(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        try {
          await pricebook.refresh()
        } catch (error) {
          respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        respond(res, 200, await buildResponse(sessionOf(req)))
        return
      }
      respond(res, 200, await buildResponse(sessionOf(req)))
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'fare-meter: /fare-meter route')
}
