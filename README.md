<h1 align="center">DSH Cost Meter</h1>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

**DSH Cost Meter** is a DeepSeek conversation cost-tracking plugin for the DeepSeek Harness (DSH) Web GUI — **price-snapshot-anchored per-turn cost** (peak/off-peak aware), **account balance**, a **cost view tab**, **per-message cost chips**, and a **header pill with live streaming estimates**. Every step's cost, price band, and snapshot version are computed *once* from the pricebook snapshot effective at the usage event's own time and then never recomputed — a later price change never rewrites an already-written conversation row.

- Host half (`src/`): DeepSeek `GET /user/balance` query, the persisted snapshot-anchored pricebook, the `sessionCost` projection plus the pricebook-free `sessionCostIndex` message index, subagent cost aggregation, and the trust-fenced `/cost-meter` route.
- Client half (`src/client/`): composer-dock readout, Cost tab, per-reply chip, header pill, and the plugin configuration card — in Simplified Chinese and English.

---

## Installation

The plugin is published on npm as `@gamegeek-saikel/dsh-cost-meter` and ships as an official DSH plugin bundle (both halves — host and browser — are mounted by a single `cordis.patch.yml` row).

Install it into a web profile with the official DSH CLI (via npx — no global installation needed):

```bash
npx @deepseek-ai/dsh plugin --profile web add @gamegeek-saikel/dsh-cost-meter
```

Then start the harness:

```bash
npx @deepseek-ai/dsh web
```

If you have the DSH CLI installed globally, you can also use `dsh` instead of `npx @deepseek-ai/dsh`. To install into another profile, replace `web` with your profile name. The plugin declares and is verified against DSH `^0.1.7-rc.2`. The host half requires Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0` for development.

## Overview

Chat costs in DeepSeek pricing change over time (list prices, USD→CNY exchange, the 2026-08-17 peak/off-peak rollout, and the 2026-09-10 model rename to `deepseek-flash` with its V4.1-Flash price cut), and a conversation spans many turns with cache-hit, cache-miss, cache-write, and output token buckets. Naively recomputing costs at *current* prices makes history drift every time the price table changes.

**Cost Meter** solves this with an **append-only pricebook**: every price/fx/band-table change starts a new immutable `PricebookSnapshot` (monotonic `version`, `effectiveAt`), and each usage event anchors to the snapshot effective at its own time. The result is an immutable per-step cost ledger that only grows — it never mutates. Live streaming estimates are explicitly labeled 估算/estimate because they use *current* prices; they are replaced by the exact anchored value once the step settles.

## Key Properties

| Property | Value |
|---|---|
| Cost anchoring | Append-only pricebook snapshots; step cost computed once at the event's own time |
| Price sources | Manual override > official pricing page > built-in fallback > OpenRouter (fallback only, USD→CNY) > none |
| Official page | Parses the current 2026-09-10 combined zh/en tables (the `deepseek-flash` / `deepseek-v4-pro` columns with OFF-PEAK/PEAK cells per bucket row, and the English UTC schedule) as well as the earlier combined and legacy split tables; the retired `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` ids have no column of their own and bill at the Flash price, exactly as the page states. The built-in list still anchors `single` when the page no longer carries a pre-rollout table |
| Peak pricing | 2026-08-17 00:00 Beijing rollout; peak windows apply Monday–Friday only (the zh and en pages may state different timezones; fallback 09:00–12:00 / 14:00–18:00 Beijing), so Saturdays, Sundays, and all other hours are off-peak at half price |
| Cost formula | Uncached input + cache reads (hit rate) + cache writes (billed at uncached input rate) + output, per 1M tokens, CNY |
| Account balance | Official `GET /user/balance`, cached 60 s, single in-flight request, trust-fenced route |
| Subagent support | Enumerates the conversation's durable subagent tree through `subagents.listDescendants` (nested delegations, settled children, and cold subagent sessions included, with no depth cap); a ledger is read from the resident session's projection when available and otherwise cold-restored from the child's stored log (`sessionQuery.readSession` + `sessionProjections.restore`), so historical subagent spend is also counted after a host restart; falls back to a BFS over the live agent tree when neither service is mounted |
| Conversation total | Main session + every descendant subagent (any depth); subagent totals still render while the main session's own ledger is not materialized |
| UI surfaces | Composer dock · Cost tab · per-reply chip · header pill (live estimate) · plugin configuration page |
| Locale | Simplified Chinese (source) + English |
| Complexity | Fully synchronous fold; O(1) price lookups via in-memory mirror |

## Usage

Once installed, the plugin contributes five browser surfaces (all text shown in Simplified Chinese by default):

| Surface | Slot | Description |
|---|---|---|
| Composer dock readout | `conversation.composer.dock` | Anchored session spend + account balance, refreshed every minute; hover for the category breakdown and snapshot info |
| Cost view tab | `conversation.view` | Whole-conversation totals (main + every subagent nesting level), category totals, the per-subagent list with its depth, and the per-reply anchored ledger |
| Per-reply cost chip | `conversation.chat.assistant-actions` | The anchored cost of one finalized reply as the row's own stat capsule — the same trigger + anchored dialog the shipped 用量 and 用时 capsules use (28px pill, hover fill, `aria-expanded` dialog above the trigger). It closes the row's stat run: after 用量 and 用时, before the timestamp, spaced by the row's own gap, and coloured by the band that priced it (green off-peak, red peak). The dialog lists the three billed categories, the band with its multiplier, the model, and the snapshot version; the slot hands over the message id, which the `sessionCostIndex` projection resolves to ledger coordinates (dash `—` when unpriced) |
| Header pill | `conversation.session.header.utilities` | Anchored total, or a live `≈ ¥x.xx (estimate)` while streaming; click for the detail panel |
| Plugin configuration page | `plugins.row.config` | The cost-meter row's page under 设置 → 插件 (DSH 0.1.7 hosts a plugin's own configuration there, keyed `<package>#<row id>`): per-model overrides, OpenRouter aliases, cache-read discount, FX mode, toggles, and manual refresh. The editable fields are the schema's `volatile()` ones — the deployment fields (endpoint, credential reference, refresh cadence, trusted hosts, history cap) stay hand-edited in the profile patch, which is exactly the split DSH's configuration projection can write |

The `/cost-meter` host route serves the balance snapshot, the pricebook view, and the subagent totals over GET, and applies manual refresh over POST (`{"action":"refresh"}`). Like the `/api` fence, the route only answers requests whose `Host` header names a loopback address or a declared trusted host — the DNS-rebinding-safe check.

## Pricebook & Snapshot Anchoring

The pricebook (`src/pricebook.ts`) is the durable price source, persisted on the `pricebook` storage-domain global slot:

- **Priority chain** — per canonical model key (`provider/model`, bare model, or the `flash`/`pro` pricing key for DeepSeek-family models): manual override > official page > built-in fallback > OpenRouter (fallback only, USD→CNY, cache reads at the configured discount) > none.
- **Snapshot selection** — `snapshotForTime` picks the newest snapshot with `effectiveAt <= event time` (pre-install sessions anchor to the first snapshot once).
- **Peak/off-peak** — before the 2026-08-17 rollout all steps price at the single list price; after it, the band is chosen by the EVENT's own time against the schedule of the pricebook's own page (the zh and en pages each parse their own peak windows — the redesigned English page states UTC — falling back to Beijing 09:00–12:00 / 14:00–18:00, everything else off-peak). The official pages restrict peak windows to Monday–Friday, so Saturdays and Sundays are off-peak all day in the schedule's own timezone. When the combined page has no legacy single-price column, `single` keeps anchoring to the built-in historical list; a page that still carries a separate legacy table wins. Each step's band is anchored once at fold time, so the per-reply cards and chips always show the band that round was billed at — never the band of the moment you are looking.
- **Immutable ledger** — the `sessionCost` projection (`src/session-cost-projection.ts`) folds `request/header` (model) and usage-carrying events into per-step rows; a second usage sample for the same (turn, step) replaces the first (same-step finalization, not a re-price), with O(1) incremental totals. The companion `sessionCostIndex` projection (`src/session-cost-index.ts`) maps each finalized assistant-message id to its ledger coordinates; it reads no pricebook and computes no cost, so folding it can never re-price a session.

## Project Structure

```
src/
  index.ts                      # Host entry: apply() wiring, balance, route, trust fence
  types.ts                      # Wire/public vocabulary + projection-map merge
  pricing.ts                    # Official pricing-page parser, peak pricing, Beijing bands
  pricebook.ts                  # Append-only snapshots, priority chain, storage domain
  session-cost-projection.ts    # sessionCost projection (immutable per-step ledger)
  session-cost-index.ts         # sessionCostIndex: message id → ledger coordinates
  subagent-cost.ts              # Subagent cost aggregation (durable tree + live-registry fallback)
  invariant.ts                  # Route-disposer symmetry invariant companion
  client/                       # Browser half: 5 slot components + math/format/locales
shared/
  tsdown.client.ts              # Shared tsdown preset (CSS Modules, module table, purity gate)
  web-platform.ts               # Browser platform module list
tests/                          # Hermetic vitest suites (network stubbed)
cordis.patch.yml                # Web-profile plugin row (mounts both halves)
```

## Development

```bash
pnpm install
pnpm typecheck   # tsc -b (src only)
pnpm test        # vitest run (hermetic, network stubbed)
pnpm build       # tsc -b && tsdown (lib/ + lib/client.js)
```

The test suites are fully offline: pricing-page HTML, OpenRouter models, and the FX endpoint are all stubbed. Tests cover the trust fence, balance parsing, the pricebook priority chain and snapshot selection, the immutable ledger fold (including same-step replacement and peak/off-peak band selection at the *event* time), the subagent aggregation (nested and cold children, listing-failure fallback, and a multi-level chain over a real `SessionStore` plus projection registry), and the client surfaces (jsdom).

## Documentation

- [`src/pricing.ts`](src/pricing.ts), [`src/pricebook.ts`](src/pricebook.ts), [`src/session-cost-projection.ts`](src/session-cost-projection.ts), [`src/session-cost-index.ts`](src/session-cost-index.ts) — detailed module docs on parsing, anchoring, and the ledger contract
- [`README.zh-CN.md`](README.zh-CN.md) — 简体中文版本

## License

This repository (source, tests, README, and the DSH plugin bundle shape) is licensed under the **MIT License** — see [`LICENSE`](LICENSE).

Copyright (c) 2026 Saikel-Orado-Liu aka GameGeek-Saikel
