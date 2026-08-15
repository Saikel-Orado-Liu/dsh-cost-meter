/**
 * Plugin configuration card (设置 → 插件 → fare-meter): the standard
 * DSH plugin-card shape (collapsible header, disclosure body, save/discard
 * footer) over the `fare-meter` settings namespace. Every editable
 * field binds the settings scope (`ctx.settingsScope.bind`) — the same
 * transport the shipped llm-deepseek / bash / web-search cards use — so the
 * card looks, stages, and persists like every other plugin configuration.
 * The JSON textareas carry the two structured fields (per-model price
 * overrides, OpenRouter aliases); the refresh button is a plain action.
 */
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Button, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationCostResponse } from '../types.ts'
import { formatTime } from './format.ts'
import css from './CostPluginCard.module.css'

export type PluginCardLocale = PropsLocale<'fare-meter'>['t']

export interface CostPluginCardProps {
  /** The bound settings scope for the `fare-meter` namespace. */
  scope: SettingsScope<unknown>
  t: PluginCardLocale
}

/** One staged field group the card writes through the scope. */
interface Staged {
  overridesText: string
  aliasesText: string
  cacheReadDiscount: string
  fxMode: 'auto' | 'manual'
  manualRate: string
  balanceEnabled: boolean
  openRouterEnabled: boolean
}

interface SectionShape {
  overrides?: Record<string, unknown>
  aliases?: Record<string, string>
  cacheReadDiscount?: number
  fxMode?: 'auto' | 'manual'
  manualRate?: number
  balanceEnabled?: boolean
  openRouterEnabled?: boolean
}

const json = (value: unknown): string => JSON.stringify(value ?? {}, null, 2)

export const CostPluginCard = memo(function CostPluginCard({ scope, t }: CostPluginCardProps) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  ) as SettingsScopeSnapshot<SectionShape>

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)

  // Seed the staged form from the latest accepted section.
  const value = snapshot.value
  useEffect(() => {
    setStaged({
      overridesText: json(value?.overrides),
      aliasesText: json(value?.aliases),
      cacheReadDiscount: String(value?.cacheReadDiscount ?? 0.25),
      fxMode: value?.fxMode ?? 'auto',
      manualRate: String(value?.manualRate ?? 7.2),
      balanceEnabled: value?.balanceEnabled ?? true,
      openRouterEnabled: value?.openRouterEnabled ?? true,
    })
  }, [value])

  // Snapshot info for the header hint (source/time, no version numbers).
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void fetch('/fare-meter', { cache: 'no-store' })
        .then(res => (res.ok ? res.json() as Promise<ConversationCostResponse> : null))
        .then((data) => {
          if (!alive || data === null) return
          setResponse(data)
        })
        .catch(() => { /* keep the last snapshot info */ })
    }
    load()
    return () => {
      alive = false
    }
  }, [])

  const current = response?.pricebook.current ?? null
  const source = current === null
    ? t('source.none')
    : t(`source.${current.source}` as 'source.manual')

  const write = async (field: string, fieldValue: unknown): Promise<void> => {
    setBusy(true)
    setStatus(null)
    setError(null)
    try {
      await scope.set(field, fieldValue)
      setStatus(t('settings.saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (staged === null) return
    setError(null)
    let overrides: Record<string, unknown>
    let aliases: Record<string, string>
    try {
      overrides = JSON.parse(staged.overridesText) as Record<string, unknown>
      aliases = JSON.parse(staged.aliasesText) as Record<string, string>
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    void write('overrides', overrides)
    void write('aliases', aliases)
    const discount = Number(staged.cacheReadDiscount)
    if (Number.isFinite(discount) && discount >= 0 && discount <= 1) void write('cacheReadDiscount', discount)
    const rate = Number(staged.manualRate)
    if (Number.isFinite(rate) && rate > 0) void write('manualRate', rate)
    if (staged.fxMode === 'auto' || staged.fxMode === 'manual') void write('fxMode', staged.fxMode)
    void write('balanceEnabled', staged.balanceEnabled)
    void write('openRouterEnabled', staged.openRouterEnabled)
  }

  const refresh = (): void => {
    setBusy(true)
    setStatus(null)
    setError(null)
    void fetch('/fare-meter', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh' }),
    })
      .then(res => (res.ok ? res.json() as Promise<ConversationCostResponse> : null))
      .then((data) => {
        if (data !== null) setResponse(data)
        setStatus(t('settings.saved'))
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const hint = current === null
    ? t('settings.noSnapshot')
    : `${t('settings.current', { source, time: formatTime(current.effectiveAt) })}`

  return (
    <li className={css.card + (open ? ` ${css.cardOpen}` : '')} data-testid="cost-plugin-card">
      <button type="button" className={css.header} onClick={() => setOpen(prev => !prev)} aria-expanded={open}>
        <span className={css.headText}>
          <span className={css.name}>{t('settings.title')}</span>
          <span className={css.description}>{hint}</span>
        </span>
        {error !== null && <span className={css.pending}>{t('settings.error', { error })}</span>}
        <IconChevronDownOutline14 className={css.chevron + (open ? ` ${css.chevronOpen}` : '')} />
      </button>
      {open && (
        <div className={css.body}>
          <div className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.discount')}</span>
            </div>
            <input
              className={css.input}
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={staged?.cacheReadDiscount ?? ''}
              onChange={event => setStaged(prev => prev === null ? prev : { ...prev, cacheReadDiscount: event.target.value })}
            />
          </div>
          <div className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.fx')}</span>
            </div>
            <div className={css.inline}>
              <select
                className={css.select}
                value={staged?.fxMode ?? 'auto'}
                onChange={event => setStaged(prev => prev === null ? prev : { ...prev, fxMode: event.target.value as 'auto' | 'manual' })}
              >
                <option value="auto">{t('settings.fx.auto')}</option>
                <option value="manual">{t('settings.fx.manual')}</option>
              </select>
              <input
                className={css.input}
                type="number"
                min={0.001}
                step={0.01}
                value={staged?.manualRate ?? ''}
                onChange={event => setStaged(prev => prev === null ? prev : { ...prev, manualRate: event.target.value })}
              />
            </div>
          </div>
          <label className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.balance')}</span>
              <input
                className={css.checkbox}
                type="checkbox"
                checked={staged?.balanceEnabled ?? true}
                onChange={event => setStaged(prev => prev === null ? prev : { ...prev, balanceEnabled: event.target.checked })}
              />
            </div>
          </label>
          <label className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.openrouter')}</span>
              <input
                className={css.checkbox}
                type="checkbox"
                checked={staged?.openRouterEnabled ?? true}
                onChange={event => setStaged(prev => prev === null ? prev : { ...prev, openRouterEnabled: event.target.checked })}
              />
            </div>
          </label>
          <div className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.overrides')}</span>
            </div>
            <textarea
              className={css.textarea}
              value={staged?.overridesText ?? ''}
              spellCheck={false}
              onChange={event => setStaged(prev => prev === null ? prev : { ...prev, overridesText: event.target.value })}
            />
            <div className={css.hint}>{t('settings.jsonHint')}</div>
          </div>
          <div className={css.field}>
            <div className={css.head}>
              <span className={css.label}>{t('settings.aliases')}</span>
            </div>
            <textarea
              className={css.textarea}
              value={staged?.aliasesText ?? ''}
              spellCheck={false}
              onChange={event => setStaged(prev => prev === null ? prev : { ...prev, aliasesText: event.target.value })}
            />
          </div>
          <div className={css.footer}>
            {status !== null && <span className={css.status}>{status}</span>}
            <span className={css.spacer} />
            <Button variant="outline" onClick={() => setStaged(null)}>{t('settings.discard')}</Button>
            <Button variant="primary" onClick={save} disabled={busy || snapshot.status !== 'ready'}>{t('settings.save')}</Button>
            <Button variant="outline" onClick={refresh} disabled={busy}>{busy ? t('settings.refreshing') : t('settings.refresh')}</Button>
          </div>
        </div>
      )}
    </li>
  )
})
