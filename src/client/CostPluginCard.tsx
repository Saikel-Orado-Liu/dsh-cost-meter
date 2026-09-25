/**
 * Plugin configuration page (设置 → 插件 → cost-meter 行). DSH 0.1.7 renders a
 * row's own configuration through the Plugins page's `plugins.row.config`
 * slot, which dispatches the contribution twice: `view: 'summary'` supplies
 * the row's one-liner, and `view: 'page'` is the body of the page the row's
 * configure control opens — the page itself draws the title, icon, and crumb.
 *
 * The page owner hands the form seat in `form`: `state` is the accepted,
 * schema-resolved value of this plugin's Loader entry with the revision that
 * fences the next write, and `mutate` submits path edits against that
 * revision. There is no settings scope to bind any more; writes ride the same
 * profile-patch path the generated forms use, so the card stages, saves, and
 * persists like every other plugin configuration. The JSON textareas carry the
 * two structured fields (per-model price overrides, OpenRouter aliases); the
 * refresh button is a plain action against the plugin's own host route.
 */
import { memo, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConversationCostResponse } from '../types.ts'
import { formatTime } from './format.ts'
import css from './CostPluginCard.module.css'

export type PluginCardLocale = PropsLocale<'cost-meter'>['t']

/**
 * One path-addressed edit the configuration page submits. Derived from the
 * form contract rather than imported, so the card depends on the page's own
 * seat and not on a wire package it never calls.
 */
type ConfigOp = Parameters<ConfigPageForm['mutate']>[0][number]

export interface CostPluginCardProps {
  /** Which view the Plugins page asks for: the row's one-liner or the page body. */
  view: 'summary' | 'page'
  /** Host-owned values and write actions; the page omits it outside its own row page. */
  form?: ConfigPageForm | undefined
  t: PluginCardLocale
}

/** One staged field group the card writes through the form. */
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
/** The section's set of user-overridden fields, read from the raw user layer. */
const overridden = (user: unknown): Record<string, unknown> =>
  typeof user === 'object' && user !== null && !Array.isArray(user) ? user as Record<string, unknown> : {}

export const CostPluginCard = memo(function CostPluginCard({ view, form, t }: CostPluginCardProps) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [response, setResponse] = useState<ConversationCostResponse | null>(null)

  const snapshot = form?.state as ConfigFormSnapshot<SectionShape> | undefined
  const value = snapshot?.value

  // Seed the staged form from the latest accepted section. The snapshot
  // reference is stable until the Host value actually changes, so an
  // in-progress edit survives an unrelated re-render of the Plugins page.
  useEffect(() => {
    if (value === undefined) return
    setStaged({
      overridesText: json(value.overrides),
      aliasesText: json(value.aliases),
      cacheReadDiscount: String(value.cacheReadDiscount ?? 0.25),
      fxMode: value.fxMode ?? 'auto',
      manualRate: String(value.manualRate ?? 7.2),
      balanceEnabled: value.balanceEnabled ?? true,
      openRouterEnabled: value.openRouterEnabled ?? true,
    })
  }, [value])

  // Snapshot info for the row's one-liner (source/time, no version numbers).
  useEffect(() => {
    if (view !== 'page') return undefined
    let alive = true
    const load = (): void => {
      void fetch('/cost-meter', { cache: 'no-store' })
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
  }, [view])

  const current = response?.pricebook.current ?? null
  const source = current === null
    ? t('source.none')
    : t(`source.${current.source}` as 'source.manual')

  // The row's one-liner: the Plugins page shows it as the row's description
  // fallback (a package that ships its own description keeps it). It states
  // what the page configures rather than fetching one, so listing the rows
  // costs no request.
  if (view === 'summary') return <span className={css.summary}>{t('settings.summary')}</span>

  /**
   * Submit one batch of field edits as path operations against the revision
   * the editor read. An unchosen select/number keeps its accepted value, so
   * the batch always restates the whole card.
   */
  const save = (): void => {
    if (staged === null || form === undefined) return
    setBusy(true)
    setStatus(null)
    setError(null)
    let overrides: Record<string, unknown>
    let aliases: Record<string, string>
    try {
      overrides = JSON.parse(staged.overridesText) as Record<string, unknown>
      aliases = JSON.parse(staged.aliasesText) as Record<string, string>
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
      return
    }
    const ops: ConfigOp[] = [
      { op: 'set', path: ['overrides'], value: overrides },
      { op: 'set', path: ['aliases'], value: aliases },
      { op: 'set', path: ['fxMode'], value: staged.fxMode },
      { op: 'set', path: ['balanceEnabled'], value: staged.balanceEnabled },
      { op: 'set', path: ['openRouterEnabled'], value: staged.openRouterEnabled },
    ]
    const discount = Number(staged.cacheReadDiscount)
    if (Number.isFinite(discount) && discount >= 0 && discount <= 1) {
      ops.push({ op: 'set', path: ['cacheReadDiscount'], value: discount })
    }
    const rate = Number(staged.manualRate)
    if (Number.isFinite(rate) && rate > 0) ops.push({ op: 'set', path: ['manualRate'], value: rate })
    void form.mutate(ops, snapshot?.revision)
      .then((accepted) => {
        if (accepted) setStatus(t('settings.saved'))
        else setError(t('settings.rejected'))
      }, (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setBusy(false))
  }

  const refresh = (): void => {
    setBusy(true)
    setStatus(null)
    setError(null)
    void fetch('/cost-meter', {
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

  // A namespace the Host does not serve to this client (or one whose connection
  // keeps preferences process-local) has no form seat: the page still opens,
  // but nothing here can be edited.
  if (form === undefined || snapshot === undefined || snapshot.status === 'unavailable') {
    return (
      <div className={css.page} data-testid="cost-plugin-card">
        {error !== null && <p className={css.error}>{t('settings.error', { error })}</p>}
        <p className={css.hint}>{t('settings.unavailable')}</p>
        <div className={css.footer}>
          {status !== null && <span className={css.status}>{status}</span>}
          <span className={css.spacer} />
          <Button variant="outline" onClick={refresh} disabled={busy}>
            {busy ? t('settings.refreshing') : t('settings.refresh')}
          </Button>
        </div>
      </div>
    )
  }

  const user = overridden(snapshot.user)
  const readOnly = !snapshot.writable
  const hintText = current === null
    ? t('settings.noSnapshot')
    : `${t('settings.current', { source, time: formatTime(current.effectiveAt) })}`

  return (
    <div className={css.page} data-testid="cost-plugin-card">
      <p className={css.hint}>{hintText}</p>
      <div className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.discount')}</span>
          {'cacheReadDiscount' in user && <span className={css.overridden}>{t('settings.overridden')}</span>}
        </div>
        <input
          className={css.input}
          type="number"
          min={0}
          max={1}
          step={0.01}
          disabled={readOnly}
          value={staged?.cacheReadDiscount ?? ''}
          onChange={event => setStaged(prev => prev === null ? prev : { ...prev, cacheReadDiscount: event.target.value })}
        />
      </div>
      <div className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.fx')}</span>
          {('fxMode' in user || 'manualRate' in user) && <span className={css.overridden}>{t('settings.overridden')}</span>}
        </div>
        <div className={css.inline}>
          <select
            className={css.select}
            disabled={readOnly}
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
            disabled={readOnly || staged?.fxMode === 'auto'}
            value={staged?.manualRate ?? ''}
            onChange={event => setStaged(prev => prev === null ? prev : { ...prev, manualRate: event.target.value })}
          />
        </div>
      </div>
      <label className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.balance')}</span>
          {'balanceEnabled' in user && <span className={css.overridden}>{t('settings.overridden')}</span>}
          <input
            className={css.checkbox}
            type="checkbox"
            disabled={readOnly}
            checked={staged?.balanceEnabled ?? true}
            onChange={event => setStaged(prev => prev === null ? prev : { ...prev, balanceEnabled: event.target.checked })}
          />
        </div>
      </label>
      <label className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.openrouter')}</span>
          {'openRouterEnabled' in user && <span className={css.overridden}>{t('settings.overridden')}</span>}
          <input
            className={css.checkbox}
            type="checkbox"
            disabled={readOnly}
            checked={staged?.openRouterEnabled ?? true}
            onChange={event => setStaged(prev => prev === null ? prev : { ...prev, openRouterEnabled: event.target.checked })}
          />
        </div>
      </label>
      <div className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.overrides')}</span>
          {'overrides' in user && <span className={css.overridden}>{t('settings.overridden')}</span>}
        </div>
        <textarea
          className={css.textarea}
          value={staged?.overridesText ?? ''}
          spellCheck={false}
          readOnly={readOnly}
          onChange={event => setStaged(prev => prev === null ? prev : { ...prev, overridesText: event.target.value })}
        />
        <div className={css.hint}>{t('settings.jsonHint')}</div>
      </div>
      <div className={css.field}>
        <div className={css.head}>
          <span className={css.label}>{t('settings.aliases')}</span>
          {'aliases' in user && <span className={css.overridden}>{t('settings.overridden')}</span>}
        </div>
        <textarea
          className={css.textarea}
          value={staged?.aliasesText ?? ''}
          spellCheck={false}
          readOnly={readOnly}
          onChange={event => setStaged(prev => prev === null ? prev : { ...prev, aliasesText: event.target.value })}
        />
      </div>
      {error !== null && <p className={css.error}>{t('settings.error', { error })}</p>}
      <div className={css.footer}>
        {status !== null && <span className={css.status}>{status}</span>}
        <span className={css.spacer} />
        <Button variant="outline" onClick={() => setStaged(null)} disabled={busy || readOnly}>{t('settings.discard')}</Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={busy || readOnly || snapshot.status !== 'ready' || staged === null}
        >
          {t('settings.save')}
        </Button>
        <Button variant="outline" onClick={refresh} disabled={busy}>{busy ? t('settings.refreshing') : t('settings.refresh')}</Button>
      </div>
    </div>
  )
})
