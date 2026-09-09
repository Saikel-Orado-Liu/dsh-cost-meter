/**
 * Cost-meter plugin, browser half: contributes the cost surfaces —
 * the composer-dock readout (anchored session spend + account balance), the
 * Cost view tab, the per-reply cost at the end of each completed Turn's
 * timing row, the header pill with the live streaming estimate, and the
 * plugin configuration card (设置 → 插件). The anchored ledger arrives
 * through the `sessionCost` projection; the balance and the pricebook arrive
 * over the trust-fenced host `/cost-meter` route; the editable configuration
 * binds the `cost-meter` settings namespace through the standard settings
 * scope.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ui-conversation SlotMap merge (composer.dock etc.).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-session standard-props merge (useSession /
// useProjection / sessionId seats) and the ui-chat SlotMap merge
// (conversation.chat.turnTail).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-renderer Context augmentation (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings-domain SlotMap merges (settings.plugin.item)
// and the settingsScope service.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the plugin-card slot merge (settings.plugin.item).
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
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

/** The settings namespace this plugin owns (mirrors the host registration). */
export const SETTINGS_NAMESPACE = 'cost-meter'

/** Required services for locale registration, slot contributions, and the settings scope. */
export const inject = ['sessions', 'slots', 'locale', 'settingsScope']

/**
 * Client plugin body: register the dictionaries and the five slot entries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cost-meter: dictionaries')
  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })

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

  // Per-reply cost at the END of a completed Turn's timing row
  // (用时 · 日期): the turnTail chain renders after the timing facts and
  // before the action row. DSH 0.1.5 closed the per-message assistant-actions
  // slot, so the cost is addressed per Turn; the selector declines open turns
  // and the tail stays empty while the reply is in flight.
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      select: (owner) => owner.turn.status === 'closed' ? { turn: owner.turn.turn } : null,
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

  // Plugin configuration card (设置 → 插件), standard plugin-card shape over
  // the `cost-meter` settings namespace. The slot is keyed by the settings
  // namespace the card edits, so the tab pairs this card with the Host-served
  // `cost-meter` namespace.
  ctx.slots.inject(
    'settings.plugin.item',
    () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: SETTINGS_NAMESPACE,
      locale: NS,
      inject: () => ({ scope }),
    }, CostPluginCard),
  )
}
