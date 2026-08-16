/**
 * Package-owned invariant companion for `@gamegeek-saikel/dsh-cost-meter`.
 * @module @gamegeek-saikel/dsh-cost-meter/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@gamegeek-saikel/dsh-cost-meter'

/** Cordis companion plugin name. */
export const name = 'cost-meter-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * Route-disposer symmetry: after the owning fiber of the /cost-meter
 * route unloads, the webserver must no longer answer that path. The probe
 * cycle registers and disposes twice on a reserved path — a leftover from
 * the first cycle makes the second register throw the duplicate error,
 * exactly the asymmetry this package would otherwise share with its host.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('internal/plugin', () => {
    const server = ctx.get('webServer') as
      | { register(route: { kind: 'exact'; path: string; handler: () => void }): () => void }
      | undefined
    if (server === undefined) return // no webserver row in this composition
    const probe = { kind: 'exact' as const, path: '/__dsh_fare_meter_invariant_probe__', handler: () => {} }
    try {
      server.register(probe)()
      server.register(probe)()
    } catch {
      fail('cost-meter webserver route disposer left a route registered — route tables and fiber lifecycles diverged')
    }
  }, { global: true })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */