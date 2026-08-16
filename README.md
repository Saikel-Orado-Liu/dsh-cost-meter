<h1 align="center">DSH Cost Meter</h1>

<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

**DSH Cost Meter** is a DeepSeek conversation cost-tracking plugin for the DeepSeek Harness (DSH) Web GUI — **price-snapshot-anchored per-turn cost** (peak/off-peak aware), **account balance**, a **cost view tab**, **per-message cost chips**, and a **header pill with live streaming estimates**. Every step's cost, price band, and snapshot version are computed *once* from the pricebook snapshot effective at the usage event's own time and then never recomputed — a later price change never rewrites an already-written conversation row.

- Host half (`src/`): DeepSeek `GET /user/balance` query, the persisted snapshot-anchored pricebook, the `sessionCost` projection, subagent cost aggregation, and the trust-fenced `/cost-meter` route.
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

If you have the DSH CLI installed globally, you can also use `dsh` instead of `npx @deepseek-ai/dsh`. To install into another profile, replace `web` with your profile name. The host half requires Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0` for development.

## Overview

Chat costs in DeepSeek pricing change over time (list prices, USD→CNY exchange, and the upcoming 2026-08-17 peak/off-peak rollout), and a conversation spans many turns with cache-hit, cache-miss, cache-write, and output token buckets. Naively recomputing costs at *current* prices makes history drift every time the price table changes.

**Cost Meter** solves this with an **append-only pricebook**: every price/fx/band-table change starts a new immutable `PricebookSnapshot` (monotonic `version`, `effectiveAt`), and each usage event anchors to the snapshot effective at its own time. The result is an immutable per-step cost ledger that only grows — it never mutates. Live streaming estimates are explicitly labeled 估算/estimate because they use *current* prices; they are replaced by the exact anchored value once the step settles.

## Key Properties

| Property | Value |
|---|---|
| Cost anchoring | Append-only pricebook snapshots; step cost computed once at the event's own time |
| Price sources | Manual override > official pricing page > built-in fallback > OpenRouter (fallback only, USD→CNY) > none |
| Peak pricing | 2026-08-17 00:00 Beijing rollout; peak 09:00–12:00 / 14:00–18:00 Beijing, off-peak half price |
| Cost formula | Uncached input + cache reads (hit rate) + cache writes (billed at uncached input rate) + output, per 1M tokens, CNY |
| Account balance | Official `GET /user/balance`, cached 60 s, single in-flight request, trust-fenced route |
| Subagent support | BFS over the live agent tree; conversation totals = main session + descendants |
| UI surfaces | Composer dock · Cost tab · per-reply chip · header pill (live estimate) · settings card |
| Locale | Simplified Chinese (source) + English |
| Complexity | Fully synchronous fold; O(1) price lookups via in-memory mirror |

## Usage

Once installed, the plugin contributes five browser surfaces (all text shown in Simplified Chinese by default):

| Surface | Slot | Description |
|---|---|---|
| Composer dock readout | `conversation.composer.dock` | Anchored session spend + account balance, refreshed every minute; hover for the category breakdown and snapshot info |
| Cost view tab | `conversation.view` | Whole-conversation totals (main + subagents), category totals, per-subagent list, and the per-reply anchored ledger |
| Per-reply cost chip | `conversation.chat.assistant-actions` | The anchored cost of one finalized reply (dash `—` when unpriced) |
| Header pill | `conversation.session.header.utilities` | Anchored total, or a live `≈ ¥x.xx (estimate)` while streaming; click for the detail panel |
| Plugin card | `settings.plugin.item` | Per-model overrides, OpenRouter aliases, cache-read discount, FX mode, toggles, and manual refresh |

The `/cost-meter` host route serves the balance snapshot, the pricebook view, and the subagent totals over GET, and applies manual refresh over POST (`{"action":"refresh"}`). Like the `/api` fence, the route only answers requests whose `Host` header names a loopback address or a declared trusted host — the DNS-rebinding-safe check.

## Pricebook & Snapshot Anchoring

The pricebook (`src/pricebook.ts`) is the durable price source, persisted on the `pricebook` storage-domain global slot:

- **Priority chain** — per canonical model key (`provider/model`, bare model, or the `flash`/`pro` pricing key for DeepSeek-family models): manual override > official page > built-in fallback > OpenRouter (fallback only, USD→CNY, cache reads at the configured discount) > none.
- **Snapshot selection** — `snapshotForTime` picks the newest snapshot with `effectiveAt <= event time` (pre-install sessions anchor to the first snapshot once).
- **Peak/off-peak** — before the 2026-08-17 rollout all steps price at the single list price; after it, the band is chosen by Beijing time (peak 09:00–12:00 / 14:00–18:00, everything else off-peak).
- **Immutable ledger** — the `sessionCost` projection (`src/session-cost-projection.ts`) folds `request/header` (model) and usage-carrying events into per-step rows; a second usage sample for the same (turn, step) replaces the first (same-step finalization, not a re-price), with O(1) incremental totals.

## Project Structure

```
src/
  index.ts                      # Host entry: apply() wiring, balance, route, trust fence
  types.ts                      # Wire/public vocabulary + projection-map merge
  pricing.ts                    # Official pricing-page parser, peak pricing, Beijing bands
  pricebook.ts                  # Append-only snapshots, priority chain, storage domain
  session-cost-projection.ts    # sessionCost projection (immutable per-step ledger)
  subagent-cost.ts              # BFS subagent cost aggregation
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

The test suites are fully offline: pricing-page HTML, OpenRouter models, and the FX endpoint are all stubbed. Tests cover the trust fence, balance parsing, the pricebook priority chain and snapshot selection, the immutable ledger fold (including same-step replacement and peak/off-peak band selection at the *event* time), subagent BFS aggregation, and the client surfaces (jsdom).

## Documentation

- [`src/pricing.ts`](src/pricing.ts), [`src/pricebook.ts`](src/pricebook.ts), [`src/session-cost-projection.ts`](src/session-cost-projection.ts) — detailed module docs on parsing, anchoring, and the ledger contract
- [`README.zh-CN.md`](README.zh-CN.md) — 简体中文版本

## License

This repository (source, tests, README, and the DSH plugin bundle shape) is licensed under the **MIT License** — see [`LICENSE`](LICENSE).

Copyright (c) 2026 Saikel-Orado-Liu aka GameGeek-Saikel
