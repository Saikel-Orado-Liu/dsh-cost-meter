<h1 align="center">DSH Cost Meter（对话花费计量）</h1>

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <strong>简体中文</strong>
</p>

**DSH Cost Meter** 是为 DeepSeek Harness（DSH）Web GUI 打造的对话成本追踪插件——**价格快照锚定**的逐轮成本（感知**峰值/闲时**）、**账户余额**、**花费标签页**、**每条回复成本小标签**，以及带**流式实时估算**的**头部胶囊**。每一步的成本、价格档位与快照版本都**只计算一次**——锚定到该用量事件自身时刻生效的价格快照，此后永不重算——因此后续价格变动绝不会改写已写入的对话记录。

- Host 半区（`src/`）：DeepSeek `GET /user/balance` 余额查询、持久化的快照锚定价格簿、`sessionCost` 投影、子代理成本聚合，以及带信任围栏的 `/cost-meter` 路由。
- Client 半区（`src/client/`）：输入框下方读数、花费标签页、每条回复成本小标签、头部胶囊，以及插件配置卡——内置简体中文与英文。

---

## 安装

本插件已发布到 npm：`@gamegeek-saikel/dsh-cost-meter`，以官方 DSH 插件 bundle 形态交付（单个 `cordis.patch.yml` 行同时挂载 host 与浏览器两半）。

通过官方 DSH CLI（npx 方式，无需全局安装）装入 web profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add @gamegeek-saikel/dsh-cost-meter
```

然后启动：

```bash
npx @deepseek-ai/dsh web
```

如果已全局安装 DSH CLI，也可以使用 `dsh` 代替 `npx @deepseek-ai/dsh`。安装到其他 profile 时，把 `web` 替换成你的 profile 名称即可。开发环境要求 Node `^22.19.0 || >=24.0.0` 与 pnpm `11.7.0`。

## 概述

DeepSeek 的价格随时间变化（官方价目表、USD→CNY 汇率、以及 2026-08-17 上线的峰值/闲时分时计价），而一次对话跨越很多轮，且每轮都含缓存命中、缓存未命中、缓存写入与输出等 token 桶。若按"当前价格"重算成本，每次价目变动都会让历史记录漂移。

**Cost Meter** 用**只追加的价格簿**解决这一问题：每次价格/汇率/分时表变化都会开启一个新的不可变 `PricebookSnapshot`（单调 `version`、`effectiveAt`），每个用量事件锚定到其自身时刻生效的快照。结果是一个**只增长、永不改写**的不可变逐步成本账本。流式实时估算明确标注为"估算"——因为它使用*当前*价格；一旦该步结算，即被精确的锚定值取代。

## 关键性质

| 性质 | 值 |
|---|---|
| 成本锚定 | 只追加价格簿快照；步成本在事件自身时刻只计算一次 |
| 价格来源 | 手动覆盖 > 官方价格页 > 内置回退 > OpenRouter（仅回退，USD→CNY）> 无 |
| 峰值定价 | 2026-08-17 00:00 北京生效；高峰 09:00–12:00 / 14:00–18:00（北京），闲时为半价 |
| 成本公式 | 未命中输入 + 缓存命中（命中价）+ 缓存写入（按未命中输入价计）+ 输出，每百万 tokens，CNY |
| 账户余额 | 官方 `GET /user/balance`，缓存 60 秒，单飞请求，路由带信任围栏 |
| 子代理支持 | 沿活跃代理树 BFS；对话总花费 = 主会话 + 全部后代 |
| UI 表面 | 输入框读数 · 花费标签页 · 回复小标签 · 头部胶囊（实时估算）· 设置卡 |
| 本地化 | 简体中文（键源）+ 英文 |
| 复杂度 | 全同步折叠；经内存镜像 O(1) 查价 |

## 用法

安装后，插件贡献五个浏览器表面（默认显示简体中文文案）：

| 表面 | 插槽 | 说明 |
|---|---|---|
| 输入框下方读数 | `conversation.composer.dock` | 锚定的本会话花费 + 账户余额，每分钟刷新；悬停查看分类明细与快照信息 |
| 花费标签页 | `conversation.view` | 全对话总花费（主会话 + 子代理）、分类小计、子代理列表与逐回复锚定账本 |
| 每条回复成本小标签 | `conversation.chat.assistant-actions` | 单条已定稿回复的锚定成本（无价格时显示 `—`） |
| 头部胶囊 | `conversation.session.header.utilities` | 锚定总花费；流式中显示 `预计 ¥x.xx（估算）`；点击展开详情面板 |
| 插件配置卡 | `settings.plugin.item` | 按模型覆盖价、OpenRouter 别名、缓存折扣、汇率模式、开关与立即刷新 |

`/cost-meter` 宿主路由通过 GET 提供余额快照、价格簿视图与子代理合计；通过 POST（`{"action":"refresh"}`）执行手动刷新。与 `/api` 围栏一致，路由只应答 `Host` 头为回环地址或已声明可信主机的请求——这是防 DNS 重绑定的安全校验。

## 价格簿与快照锚定

价格簿（`src/pricebook.ts`）是持久的定价源，持久化在 `pricebook` 存储域全局槽上：

- **优先级链**——按规范模型键（`provider/model`、裸模型名，或 DeepSeek 系模型的 `flash`/`pro` 定价键）：手动覆盖 > 官方页面 > 内置回退 > OpenRouter（仅回退，USD→CNY，缓存读按配置折扣）> 无。
- **快照选取**——`snapshotForTime` 取 `effectiveAt <= 事件时间` 的最新快照（安装前的会话一次性锚到首个快照）。
- **峰值/闲时**——2026-08-17 上线前所有步按单一价目计费；上线后按北京时间选档（高峰 09:00–12:00 / 14:00–18:00，其余闲时）。
- **不可变账本**——`sessionCost` 投影（`src/session-cost-projection.ts`）把 `request/header`（模型）与携带用量的事件折叠为逐步记录；同一 (turn, step) 的第二次用量样本**替换**第一条（同一步终结，而非重新计价），总计以 O(1) 增量维护。

## 项目结构

```
src/
  index.ts                      # Host 入口：apply() 装配、余额、路由、信任围栏
  types.ts                      # wire/公共类型 + 投影映射合并
  pricing.ts                    # 官方价格页解析、峰值定价、北京时段
  pricebook.ts                  # 只追加快照、优先级链、存储域
  session-cost-projection.ts    # sessionCost 投影（不可变逐步账本）
  subagent-cost.ts              # BFS 子代理成本聚合
  invariant.ts                  # 路由释放对称性 invariant 伴生插件
  client/                       # 浏览器半区：5 个插槽组件 + 数学/格式化/本地化
shared/
  tsdown.client.ts              # 共享 tsdown 预设（CSS Modules、模块表、纯度门）
  web-platform.ts               # 浏览器平台模块清单
tests/                          # 封闭式 vitest 套件（网络全部 stub）
cordis.patch.yml                # web profile 插件行（同时挂载两半）
```

## 开发

```bash
pnpm install
pnpm typecheck   # tsc -b（仅 src）
pnpm test        # vitest run（封闭式，网络 stub）
pnpm build       # tsc -b && tsdown（lib/ + lib/client.js）
```

测试套件完全离线：价格页 HTML、OpenRouter 模型目录与汇率接口全部 stub。覆盖：信任围栏、余额解析、价格簿优先级链与快照选取、不可变账本折叠（含同一步替换与按*事件时间*选峰值/闲时档）、子代理 BFS 聚合，以及客户端表面（jsdom）。

## 文档

- [`src/pricing.ts`](src/pricing.ts)、[`src/pricebook.ts`](src/pricebook.ts)、[`src/session-cost-projection.ts`](src/session-cost-projection.ts)——解析、锚定与账本契约的详细模块注释
- [`README.md`](README.md) — English version

## 许可证

本仓库（源码、测试、README 与 DSH 插件 bundle 形态）以 **MIT License** 授权——见 [`LICENSE`](LICENSE)。

Copyright (c) 2026 Saikel-Orado-Liu aka GameGeek-Saikel
