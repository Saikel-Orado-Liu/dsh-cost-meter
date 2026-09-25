/**
 * Cost-meter plugin, browser half: contributes the cost surfaces —
 * the composer-dock readout (anchored session spend + account balance), the
 * Cost view tab, the per-reply cost at the end of each completed Turn's
 * timing row, the header pill with the live streaming estimate, and the
 * plugin configuration page (设置 → 插件 → cost-meter 行). The anchored ledger
 * arrives through the `sessionCost` projection; the balance and the pricebook
 * arrive over the trust-fenced host `/cost-meter` route; the editable
 * configuration binds the `cost-meter` Loader entry through the Plugins page's
 * `plugins.row.config` contribution, whose `form` seat carries the values and
 * the revision-fenced write.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (composer.dock etc.).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-session standard-props merge (useSession /
// useProjection / sessionId seats) and the ui-chat SlotMap merge
// (conversation.chat.assistant-actions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-renderer Context augmentation (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Plugins page slot merge (plugins.row.config) and the
// config-page form contract the page hands a row's configuration page.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the shared config-form types (ConfigForm types live in the
// settings package even though DSH 0.1.7 hosts the page on the Plugins page).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type ConversationCostKey } from './locales.ts'
import { SessionCostLine } from './SessionCostLine.tsx'
import { CostView } from './CostView.tsx'
import { AssistantCostChip } from './AssistantCostChip.tsx'
import { SessionCostPill } from './SessionCostPill.tsx'
import { CostPluginCard } from './CostPluginCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cost meter and account balance copy. */
    'cost-meter': ConversationCostKey
  }
}

/** The plugin entry id this package's configuration page is keyed by. */
export const SETTINGS_NAMESPACE = 'cost-meter'

/** The package whose bundle declares the `cost-meter` row. */
export const PACKAGE_NAME = '@gamegeek-saikel/dsh-cost-meter'

/**
 * The `plugins.row.config` dispatch key: `<bundle package name>#<row id>`,
 * exactly as this package's cordis.patch.yml declares the row. The Plugins
 * page reads it to pair the row with this configuration page.
 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${SETTINGS_NAMESPACE}`

/** Required services for locale registration and the slot contributions. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the five slot entries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cost-meter: dictionaries')
  const t = ctx.locale.bind(NS)

  // Composer-dock readout: anchored session spend + balance (after the
  // shipped stats line, order 0).
  ctx.slots.inject(
    'conversation.composer.dock',
    () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'cost-meter',
      order: 1,
      locale: NS,
    }, SessionCostLine),
  )

  // Cost view tab (after trajectory at order 10).
  ctx.slots.inject(
    'conversation.view',
    () => ctx.slots.register({
      name: 'conversation.view',
      id: 'cost',
      order: 20,
      locale: NS,
      label: () => t('view.cost'),
    }, CostView),
  )

  // Per-reply cost in the completed Turn's action row
  // (copy · branch · 用量 · 用时 · ¥3.02 · 9月4日 19:47): DSH 0.1.5 renders the
  // assistant-actions entries in that row's action area and hands each one the
  // finalized message id, so the chip resolves its Turn through the
  // `sessionCostIndex` projection; the capsule's own `order` then closes the
  // stat run after 用量 / 用时 and before the row's timestamp. The `turnTail`
  // chain would instead render on its own line above the row.
  ctx.slots.inject(
    'conversation.chat.assistant-actions',
    () => ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'cost-meter',
      order: 20,
      locale: NS,
    }, AssistantCostChip),
  )

  // Header pill: total / live estimate with the expandable detail.
  // Negative order keeps it left of the built-in Session log utility.
  ctx.slots.inject(
    'conversation.session.header.utilities',
    () => ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'cost-meter',
      order: -10,
      locale: NS,
    }, SessionCostPill),
  )

  // Plugin configuration page (设置 → 插件 → cost-meter 行). DSH 0.1.7 hosts one
  // plugin row's own configuration under `plugins.row.config`, keyed by
  // `<bundle package name>#<row id>`; the Host half opts out of the generated
  // schema form (`settings.configure({ auto: false })`), so this page is what
  // the row's configure control opens.
  ctx.slots.inject(
    'plugins.row.config',
    () => ctx.slots.register({
      name: 'plugins.row.config',
      key: ROW_CONFIG_KEY,
      locale: NS,
    }, CostPluginCard),
  )
}
