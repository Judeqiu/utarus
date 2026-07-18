# Domain Agent Integration Guide

This document is the canonical reference for **wiring a domain agent into Utarus**. It documents the `DomainExtension` contract, the data model, the channel identity model, and the patterns the framework expects — and it uses **[Invage](https://github.com/Judeqiu/invage)** (the investor agent) as the running example throughout.

**Audience:** engineers building a new agent on top of Utarus (Binary, Marie, Invage, or a new vertical).  
**Companion docs:**
- [`webui-integration.md`](webui-integration.md) — **start here for browser chat** (SPA, conversations, env, enrich rules)
- [`onboarding-integration.md`](onboarding-integration.md) — access gate, invite codes, demo mode
- [`billing.md`](billing.md) — Stripe paywall (plans, webhooks, enablement checklist)
- [`paywall-stripe-design.md`](paywall-stripe-design.md) — full paywall design
- [`webui-chat-design.md`](webui-chat-design.md) — deeper WebUI architecture / history
- [README](../README.md) — install + first-run
- `src/extension.ts` — TypeScript source of truth for `DomainExtension`

---

## 1. The two-layer model

```
┌──────────────────────────────────────────────────────────┐
│  Domain agent (e.g. invage/)                              │
│  • DomainExtension impl                                  │
│  • Domain tools (portfolio, market data, playbook)       │
│  • Domain skills (investment-analysis, firecrawl, …)     │
│  • Domain-specific onboarding that runs alongside the    │
│    framework gate (e.g. invage's BIND-token QR flow)     │
└──────────────────────────────────────────────────────────┘
                        │ depends on
                        ▼
┌──────────────────────────────────────────────────────────┐
│  Utarus framework                                        │
│  • DomainExtension contract — src/extension.ts           │
│  • createFramework({ extension }) — composes system      │
│    prompt, tools, skills, agent pool                     │
│  • Per-user YAML state — src/state/                      │
│  • Per-channel identity resolution                       │
│    (telegram / slack / web slug)                         │
│  • Access gate, invite redeem, demo mode, admin codes    │
│  • Skills framework + use_skill tool                     │
│  • Telegram / Slack / CLI / Web interfaces               │
│  • BinDrive file portal + post_html_report               │
│  • Usage caps + optional Stripe billing / paywall        │
└──────────────────────────────────────────────────────────┘
```

**The contract between the layers is `DomainExtension`.** Anything an agent shares with the next vertical (user state shape, invite flow, channel routing, BinDrive) belongs in the framework. Anything that says "portfolio", "ticker", "playbook", or names a domain workflow belongs in the domain.

| Concern | Framework owns | Domain owns |
|---|---|---|
| User identity | `UserIdentity` (`id`, `slug`, `created_at`, channel ids, `auth_token`) | Nothing — never invent user fields |
| User profile | `display_name`, `contact_email` (required by coherence check) | Extra `profile.*` fields via index signature |
| Top-level state keys | `user`, `profile`, `log` | New top-level keys (e.g. `portfolio`, `playbook`) |
| Onboarding | INV- instant redeem, ADM- admin codes, demo mode, web login/redeem | Optional custom flow as slash command (e.g. invage `/bind BIND-…`) or landing `POST /api/onboard/register` |
| Tools | `use_skill`, user/invite tools, firecrawl, `post_html_report`, BinDrive | Domain tools (e.g. `get_portfolio`, `add_holding`) |
| Channels | Telegram, Slack, CLI, **WebUI chat** (SPA + SSE + multi-chat) | — |
| Chat history | `data/chats/<slug>/…` conversations, AI titles | Never store `enrichMessage` text as the user bubble |
| Slash commands | `/demomode`, invite/admin commands, `/usage`; WebUI `/clear` `/help` | Domain commands via `DomainExtension.{telegram,slack,web}Commands` |

---

## 2. Data model

The full TypeScript source is `src/state/types.ts`. The shape is intentionally small — most fields are framework-owned and the domain extends via index signatures.

### 2.1 `UserIdentity`

```ts
interface UserIdentity {
  id: string;          // UUID, channel-independent canonical id
  slug: string;        // lowercase kebab-case, used as filename
  created_at: string;  // YYYY-MM-DD
  telegram_user_ids?: number[];
  slack_user_ids?: string[];
  auth_token?: string; // portal/API auth (treated as a password)
}
```

**Design rationale:**

- **`id` is the canonical primary key.** It's a UUID, assigned at creation, never reused, and never changes. Use this when you need a stable cross-channel reference (e.g. foreign keys in an external system).
- **`slug` is the filename.** Derived from display name at creation (`Alice Chen` → `alice-chen`), with a collision suffix when needed (`alice-chen-3f2a`). Stored as `data/users/<slug>.yaml`.
- **`telegram_user_ids` / `slack_user_ids` are arrays.** A user may legitimately have multiple Telegram accounts or multiple Slack workspaces. The arrays support linking a second identity later without rewriting the schema.
- **`auth_token` is a password.** Never log it. Never return it from a `GET`. The framework's `admin-router` strips it from listings; domain code that surfaces user data should follow the same rule.

> ⚠️ **The framework reserves all `UserIdentity` fields.** Domains do not write here at runtime. The only legitimate path to mutating identity is the framework's own onboarding tools.

### 2.2 `UserProfile`

```ts
interface UserProfile {
  display_name: string;   // required (coherence check fails without it)
  contact_email: string;  // required (coherence check fails without it)
  [key: string]: unknown; // domain extension point
}
```

**Design rationale:**

- `display_name` and `contact_email` are required because the framework's `assertCoherent` checks them on every load — missing either fails fast. This catches half-written YAML before it reaches domain code.
- The index signature is the **domain extension point for shallow profile data**. Examples:
  - Binary adds `profile.company_name`, `profile.role`.
  - Marie adds `profile.specialty`, `profile.years_experience`.
  - Invage keeps portfolio/playbook as **top-level keys** (see §2.3) because they're large structured objects, not flat profile fields.

### 2.3 `UserState`

```ts
interface UserState {
  user: UserIdentity;
  profile: UserProfile;
  log: LogEntry[];
  // …plus any domain-added top-level keys
}
```

**The framework owns the three reserved top-level keys: `user`, `profile`, `log`.** Domains add new top-level keys for their own structured state. Invage adds two:

```ts
// invage: src/state/portfolio-state.ts
export interface InvestorState extends UserState {
  portfolio?: Record<string, Holding>;
  playbook?: Partial<InvestmentPlaybook> | InvestmentPlaybook;
}
```

The pattern: **extend `UserState` with optional domain fields.** Optional because:
1. Existing YAML files written before the domain field existed still load.
2. Fresh users start without the field; the domain initializes it on first mutation (e.g. `state.portfolio ??= {}`).

### 2.4 `LogEntry`

```ts
interface LogEntry {
  ts: string;   // YYYY-MM-DD
  action: string;
  [key: string]: unknown;
}
```

The framework appends entries for framework-owned actions (`created`, `invite_redeemed`, `profile_updated`, `telegram_linked`, …). **Domain code is free to push its own entries** — the index signature accepts any extra fields. Use this for audit trails of domain mutations.

```ts
// invage pattern
state.log.push({
  ts: new Date().toISOString().slice(0, 10),
  action: 'holding_added',
  ticker: 'AAPL',
  avg_price: 200,
  units: 5,
  category: 'SL Technology S1',
});
saveState(state);
```

### 2.5 `InviteCode` and `AdminOnboardCode`

Both are array-serialized to `data/invites.yaml` and `data/admin_codes.yaml`. Domains do **not** touch these directly — the framework's invite/admin tools and slash commands are the only entry points. Documented in [`onboarding-integration.md`](onboarding-integration.md).

---

## 3. Channel identity model

A user can chat with the agent from up to three channel families:

| Channel | Chat-platform id | Resolver | Notes |
|---|---|---|---|
| Telegram | `telegram_user_id` (number) | `resolveUserByTelegramUser(id)` | Linked via `INV-` redeem or `/link` |
| Slack | `slack_user_id` (string, e.g. `U0ABC123`) | `resolveUserBySlackUser(id)` | Linked via `INV-` redeem or `/bind` (domain) |
| Web | **none** — session is `auth_token` → cookie → slug | `resolveUserBySlug(slug)` | The framework gate resolves the slug from the session and passes it through `EnrichMessageContext.userSlug` |

### 3.1 The three resolvers

```ts
import {
  resolveUserByTelegramUser,
  resolveUserBySlackUser,
  resolveUserBySlug,
  type UserState,
} from 'utarus';

const byTg  = resolveUserByTelegramUser(123456789);    // UserState | null
const bySlk = resolveUserBySlackUser('U0ABC123');      // UserState | null
const bySlg = resolveUserBySlug('alice-chen');         // UserState | null
```

All three return `null` when no user is linked — never throw. Callers must surface a domain-appropriate error (or, for the access gate, redirect to onboarding).

### 3.2 The web channel — the re-onboarding trap

Web sessions have **no chat-platform id**. The framework's web middleware:
1. Reads the `bindrive_session` cookie.
2. Resolves it to an `AuthUser { slug }`.
3. Passes `slug` into the agent pipeline as `EnrichMessageContext.userSlug`.

If your `enrichMessage` only handles `telegramUserId` and `slackUserId`, the web channel falls through to the "no investor found" branch and the agent will re-onboard an already-onboarded user.

✅ **Correct shape:**

```ts
// invage: src/extension.ts
async enrichMessage(ctx) {
  let investor = null;
  if (ctx.telegramUserId != null) {
    investor = resolveUserByTelegramUser(ctx.telegramUserId);
  } else if (ctx.slackUserId) {
    investor = resolveUserBySlackUser(ctx.slackUserId);
  } else if (ctx.userSlug) {
    // Web channel — gate resolved slug from the session.
    investor = resolveUserBySlug(ctx.userSlug);
  }
  return investor ? prefix(investor, ctx) + ctx.text : ctx.text;
}
```

The `ctx.userSlug` branch is mandatory for any domain that supports the web channel.

### 3.3 Casting `UserState` to a domain state type

The framework resolvers return `UserState`. Domains that extend the YAML with extra top-level keys cast at the boundary:

```ts
import { loadState, type UserState } from 'utarus';
import type { InvestorState } from './state/portfolio-state.js';

const state = loadState(slug) as InvestorState;
state.portfolio ??= {};
```

This is **not** a fallback — it's a typed view of the same YAML file. The framework's `assertCoherent` guarantees the base shape; the domain's cast asserts the extension shape.

---

## 4. State I/O contract

### 4.1 `loadState` / `saveState`

```ts
import { loadState, saveState } from 'utarus';

loadState(slug);          // UserState — throws if file missing or incoherent
saveState(state);         // writes data/users/<slug>.yaml — returns path
```

- **`loadState` fails fast** on missing files, parse errors, or incoherent shape (missing `user.slug`, `profile.display_name`, etc.). Never wrap in try/catch to fall back to defaults — surface the error.
- **`saveState` round-trips the full object** via `yaml.stringify`. Domain-added top-level keys survive the round trip unchanged.
- **No caching layer.** Every `loadState` hits disk; every `saveState` writes synchronously. This is deliberate — correctness over performance. If you measure a real bottleneck, raise it; don't add caching speculatively.

### 4.2 The `InvestorState` pattern (extend + cast)

```ts
// invage: src/state/portfolio-state.ts (full file, ~50 LOC)

import type { UserState } from 'utarus';
import type { Holding } from '../market/types.js';
import { resolvePlaybook, applyPlaybookPatch, type InvestmentPlaybook, type PlaybookPatch } from '../playbook/index.js';

export interface InvestorState extends UserState {
  portfolio?: Record<string, Holding>;
  playbook?: Partial<InvestmentPlaybook> | InvestmentPlaybook;
}

export function getPortfolio(state: InvestorState): Record<string, Holding> {
  return state.portfolio ?? {};
}

export function setPortfolio(state: InvestorState, p: Record<string, Holding>) {
  state.portfolio = p;
}

export function getPlaybook(state: InvestorState): InvestmentPlaybook {
  return resolvePlaybook(state.playbook ?? null);
}

export function updatePlaybook(state: InvestorState, patch: PlaybookPatch): InvestmentPlaybook {
  const next = applyPlaybookPatch(getPlaybook(state), patch);
  state.playbook = next;
  return next;
}
```

Notice what's **not** here:
- ❌ No `loadInvestorState` — callers use `loadState` from utarus and cast.
- ❌ No `saveInvestorState` — callers use `saveState` from utarus.
- ❌ No `assertCoherent` — the framework's check covers the base shape.
- ❌ No `resolveInvestorBy{Telegram,Slack,Slug}` — callers use the framework resolvers and cast.

This is the post-refactor shape. The pre-refactor invage duplicated all of these; the duplication has been deleted.

### 4.3 Where domain fields live

| Field shape | Where it goes | Example |
|---|---|---|
| Flat string/number tied to identity | `profile.<field>` (index signature) | `profile.company_name`, `profile.risk_tolerance` |
| Large structured object, mutated often | New top-level key | `portfolio: { AAPL: {…}, MSFT: {…} }` |
| Workflow / phase machine | New top-level key + log entries | `playbook: {…}`, `onboarding_stage: 'awaiting_email'` |

---

## 5. The `DomainExtension` contract

Source: [`src/extension.ts`](../src/extension.ts). Implement exactly the fields your domain needs; omit the rest.

### 5.1 `purpose` *(required)*

Appended verbatim to the framework system prompt. This is where you tell the agent who it is, what's in scope, and the hard domain rules.

```ts
// invage: src/extension.ts
const INVAGE_PURPOSE = `You are Invester — an investment research and portfolio analyst for individual investors…
// ~150 lines: voice rules, fact-grounding rules, scope, session protocol
`;
```

**Tips:**
- Lead with identity and voice; the framework prompt already covers voice defaults.
- Be explicit about what's in/out of scope — the framework prompt is permissive, so domains must draw lines.
- Include concrete workflow bullet points ("When the user asks to analyze a stock: 1. load skill X, 2. call tool Y, 3. …"). The model follows these.
- Spell out hard rules (no fabrication, cite sources, etc.) — the framework prompt's defaults are good but domain-specific reinforcement helps.

### 5.2 `tools` *(required)*

A fresh array (or a factory function) of domain tools. The framework merges them with its own (`use_skill`, `get_user`, invite tools, firecrawl, `post_html_report`, BinDrive).

```ts
// static
tools: () => createInvageTools(),

// dynamic (per-user / per-admin)
tools: (userSlug, isAdmin) => isAdmin ? adminTools(userSlug) : userTools(userSlug),
```

See §6.1 for the channel-identity pattern every domain tool should follow.

### 5.3 `skills` *(required)*

Static knowledge documents the agent loads on demand via the `use_skill` tool. Two-step pattern: register the markdown content with the framework, then return the catalog.

```ts
// invage: src/skills.ts (excerpt)
import { readFileSync } from 'fs';
import { registerDomainSkill, type Skill } from 'utarus';

const CATALOG = [
  {
    id: 'investment-analysis',
    name: 'Investment Analysis',
    description: '3-axis portfolio classification + single-stock evaluation + value gates',
    keywords: ['analyze', 'portfolio', 'undervalued', 'pe', 'peg'],
  },
  // …
] as const;

export function registerInvageSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const raw of CATALOG) {
    const content = readFileSync(join(KNOWLEDGE_DIR, `${raw.id}.md`), 'utf-8');
    registerDomainSkill(raw.id, content);   // ← (id, content) — two args
    skills.push({ ...raw, kind: 'knowledge' });
  }
  return skills;
}
```

Then in the extension:

```ts
const INVAGE_SKILLS: Skill[] = registerInvageSkills();

export const invageExtension: DomainExtension = {
  // …
  skills: INVAGE_SKILLS,
};
```

See `src/skills/` for the framework's own skill files.

### 5.4 `telegramCommands` / `slackCommands` / `webCommands` *(optional)*

Domain-specific slash commands. Framework owns channel admin commands (`/invite`, `/demomode`, `/admincode` on Telegram/Slack; `/clear` and `/help` on WebUI) plus `/usage` on all chat channels. Domains add their own on each channel they care about.

```ts
// invage: src/extension.ts
slackCommands: [
  {
    name: 'bind',
    description: 'Finish registration with a BIND- code from investor.lextok.com',
    adminOnly: false,
    usageHint: 'BIND-XXXXXXXX',
    handler: (ctx) => handleBindCommand(ctx),
  },
  {
    name: 'onboard',
    description: 'List or reject QR-onboarded registrations (admin)',
    adminOnly: true,
    usageHint: 'list [pending|used|rejected|all] | reject <token> [reason]',
    handler: (ctx) => handleOnboardCommand(ctx),
  },
],

// Same idea for the browser chat — user types `/bind BIND-…` in the composer
webCommands: [
  {
    name: 'bind',
    description: 'Finish registration with a BIND- code',
    adminOnly: false,
    usageHint: 'BIND-XXXXXXXX',
    handler: async ({ args, userSlug, isAdmin }) => {
      // return reply text (markdown ok); no LLM run
      return handleBindForWeb({ args, userSlug, isAdmin });
    },
  },
],
```

**WebUI notes:**
- Type **`/`** in the composer to open a Slack-style command menu (catalog from `GET /api/chat/commands`). Pick a command, add args if needed, send.
- When the user sends `/name args…`, the server matches `DomainExtension.webCommands` and returns `{ kind: 'reply', text }` — the agent is **not** called.
- `adminOnly` is enforced on the server.
- Reserved names (do not register): `clear`, `help` (SPA client handles them).
- Handler context: `{ args, userSlug, isAdmin, conversationId? }`.

**Slack notes:** Command names must not collide with framework-owned names (`invite`, `demomode`, `admincode`). Register the command in the Slack app manifest as well.

### 5.5 `enrichMessage` *(optional but recommended)*

Per-turn context injection. Receives `EnrichMessageContext`, returns the (possibly modified) text the agent sees.

```ts
// invage: src/extension.ts
async enrichMessage(ctx) {
  let investor: InvestorState | null = null;
  if (ctx.telegramUserId != null) {
    investor = resolveUserByTelegramUser(ctx.telegramUserId) as InvestorState | null;
  } else if (ctx.slackUserId) {
    investor = resolveUserBySlackUser(ctx.slackUserId) as InvestorState | null;
  } else if (ctx.userSlug) {
    investor = resolveUserBySlug(ctx.userSlug) as InvestorState | null;
  }
  if (!investor) return ctx.text;

  return (
    `[Investor context: You are working with user "${investor.user.slug}" ` +
    `(${investor.profile.display_name}, email=${investor.profile.contact_email}). ` +
    `Saved holdings: ${Object.keys(investor.portfolio ?? {}).length}. ` +
    channelHint(ctx) + ']\n\n' +
    playbookAgentGuidance(getPlaybook(investor)) + '\n\n' +
    ctx.text
  );
}
```

**Must handle all three channel families** (telegram / slack / web) — see §3.2.

**Special return values:**
- Empty string `''` → framework skips the agent entirely (use sparingly; better to return `REPLY: <text>`).
- `REPLY: <text>` → framework sends `<text>` as the reply without invoking the agent. Useful for cheap short-circuits, but the framework gate already handles the common cases (invite codes, demo mode, unlinked denial).

### 5.6 `buildSessionAnnouncement` / `resolveEntitySlug` *(optional, skip for invage-like agents)*

Used by agents that have a **sub-entity model** (e.g. Binary has "sellers" — a user acts *as* a seller, with per-seller state). Invage doesn't have this; users act as themselves. Skip these if your domain has no sub-entity.

---

## 6. Patterns

### 6.1 Channel-aware tools (`channelIdParams`)

Every domain tool that mutates user state needs to know **which user**. The channel id comes from the message context — never ask the user for it.

**Pattern:**

```ts
// invage: src/tools/channel.ts
import { Type } from 'typebox';
import {
  resolveUserBySlackUser,
  resolveUserByTelegramUser,
  resolveUserBySlug,
} from 'utarus';
import type { InvestorState } from '../state/portfolio-state.js';

export const channelIdParams = {
  telegram_user_id: Type.Optional(Type.Number({
    description: 'Telegram user ID from message context (Telegram channel).',
  })),
  slack_user_id: Type.Optional(Type.String({
    description: 'Slack user ID from message context (Slack channel).',
  })),
  user_slug: Type.Optional(Type.String({
    description: 'User slug from message context (Web channel).',
  })),
} as const;

export type ChannelIds = {
  telegram_user_id?: number;
  slack_user_id?: string;
  user_slug?: string;
};

export function resolveInvestorFromChannel(p: ChannelIds): InvestorState {
  if (p.user_slug) {
    const s = resolveUserBySlug(p.user_slug) as InvestorState | null;
    if (s) return s;
    throw new Error(`No user with slug "${p.user_slug}".`);
  }
  if (p.telegram_user_id != null) {
    const s = resolveUserByTelegramUser(p.telegram_user_id) as InvestorState | null;
    if (s) return s;
    throw new Error(`No user linked to Telegram ID ${p.telegram_user_id}.`);
  }
  if (p.slack_user_id) {
    const s = resolveUserBySlackUser(p.slack_user_id) as InvestorState | null;
    if (s) return s;
    throw new Error(`No user linked to Slack ID ${p.slack_user_id}.`);
  }
  throw new Error('Provide user_slug, telegram_user_id, or slack_user_id from message context.');
}
```

**Then in every tool:**

```ts
// invage: src/tools/portfolio.ts
const addHolding: AgentTool = {
  name: 'add_holding',
  parameters: Type.Object({
    ...channelIdParams,           // ← merges in the three channel fields
    ticker: Type.String({ … }),
    avg_price: Type.Number({ … }),
    units: Type.Number({ … }),
  }),
  async execute(_id, raw) {
    const p = raw as ChannelIds & { ticker: string; avg_price: number; units: number };
    const state = resolveInvestorFromChannel(p);   // ← one resolver call
    // … mutate state …
    saveState(state);                               // ← framework I/O
    return ok(`Added ${p.ticker}`, { … });
  },
};
```

The model sees the channel ids in the message context (enrichMessage puts them there for Slack/Telegram; the web channel hint is in `purpose`) and passes them through. Never invent ids.

### 6.2 Domain onboarding alongside the access gate

The framework gate handles `INV-` codes, `ADM-` codes, and demo mode. But some domains need a **custom onboarding flow** (e.g. invage's QR-token flow that bakes in a specific Slack workspace invite). The pattern: run it as a **slash command**, not as free text. Slash commands bypass the access gate.

```ts
// invage: src/onboard/handshake.ts (excerpt)
import { ensureChannelUser, resolveUserBySlackUser } from 'utarus';

export function handleBind({ payload, slackUserId }: BindArgs): BindResult {
  const token = payload.trim().toUpperCase();
  const entry = findToken(token);
  if (!entry || entry.status !== 'pending' || isExpired(entry)) {
    return { reply: 'Bad token. Register at https://investor.lextok.com' };
  }

  // Already linked → mark token used, stop.
  const existing = resolveUserBySlackUser(slackUserId);
  if (existing) {
    markUsed(token, slackUserId, existing.user.slug);
    return { reply: `Already registered as ${existing.user.slug}.` };
  }

  // Delegate user creation to the framework — never duplicate.
  const user = ensureChannelUser({
    slackUserId,
    displayName: entry.display_name,
    contactEmail: entry.email_submitted,
    source: 'invite',
  });

  markUsed(token, slackUserId, user.slug);
  return { reply: `Welcome, ${entry.display_name}!`, slug: user.slug };
}
```

**Key rules:**
1. **Always delegate user creation to `ensureChannelUser`.** Never duplicate the slug derivation / state file write. The framework's `ensureChannelUser` accepts `contactEmail` and handles Slack/Telegram/web uniformly.
2. **Slash commands bypass the gate.** A user can run `/bind BIND-…` without an invite code — the gate never sees it.
3. **Free-text onboarding does not bypass the gate.** If the user types `BIND-…` in a normal message, the gate runs first and rejects it (or, in demo mode, auto-creates a profile). Only slash commands skip the gate.

### 6.3 HTML reports via `post_html_report`

The framework ships a generic `post_html_report` tool that writes HTML to BinDrive and returns a view URL. Domains should reuse it for any "save this as a page" workflow.

```ts
// model invocation (the agent does this automatically when asked for HTML)
post_html_report({
  title: 'Portfolio Analysis — 2026-07-15',
  body_markdown: '<full markdown or HTML>',
  owner_slug: 'alice-chen',
})
→ { view_url: 'https://chat.investor.lextok.com/files/abc123/view?t=…' }
```

For investor-styled reports, invage wraps this with a `save_report` tool that runs the portfolio analysis first, renders the result through its own HTML template, then calls `post_html_report` internally.

---

## 7. WebUI integration

> **Full guide:** [`webui-integration.md`](webui-integration.md). This section is the short form for domain agents.

### 7.0 What shipped in the framework

WebUI is **not** a domain concern. The package includes:

- React SPA (`utarus/web/`, served from `web/dist`)
- Chat + multi-conversation APIs (`/api/chat/*`)
- Web login / redeem / demo (`/api/onboard/*`)
- Admin REST (`/api/admin/*`)
- BinDrive (`/api/files/*`)

**Domain boot (preferred):**

```ts
const framework = createFramework({ extension: myExtension });

if (process.env.WEBAPP_PORT) {
  framework.startWebApp({
    port: parseInt(process.env.WEBAPP_PORT, 10),
    // Optional domain-only routes (e.g. landing QR register):
    extraRouters: [{ path: '/api/onboard', router: landingRegisterRouter }],
  });
}
```

Do **not** reimplement the SPA or chat routers in the domain repo.

### 7.0.1 Conversations (multi-chat)

| Path on disk | Purpose |
|---|---|
| `data/chats/<slug>/index.json` | Sidebar list |
| `data/chats/<slug>/<uuid>.json` | Messages for one chat |

Agent cache key: `web:<slug>:<conversationId>`. Refresh restores history. First reply gets an **AI title** for the sidebar and browser tab.

**Display vs agent prompt:** store and show only the human-typed string. Domain `enrichMessage` output is prepended for the model only (see [webui-integration.md §4–5](webui-integration.md)).

### 7.1 Authentication surfaces (reference)

Utarus exports the password primitives so domain agents don't reimplement them.

```ts
import {
  hashPassword,           // (plain: string) => Promise<string>   bcrypt cost 10
  verifyPassword,         // (plain, hash) => Promise<boolean>
  generateMemorablePassword,  // () => string   "river-stone-cloud" form
  authenticateUser,       // (identifier, password) => Promise<AuthUser | null>
} from 'utarus';
```

**`UserIdentity.password_hash?`** — optional bcrypt hash. A user without this field cannot authenticate via username+password (no fallback path — fail fast with 401). Populate via:

- `ensureChannelUser({ ..., presetPassword? })` — at profile creation. When `presetPassword` is omitted, a memorable one is generated. The plaintext is returned in `InstantRedeemResult.presetPassword` (one-shot).
- `scripts/backfill-passwords.mjs <data-root>` — one-shot CLI for existing users. Prints `<slug>\t<email>\t<preset>` to stdout; admin pipes to a file, distributes out-of-band, then shreds the file.
- A domain `POST /api/profile/password` endpoint (auth-gated) for users to set their own. Pattern: `state.user.password_hash = await hashPassword(newPassword); saveState(state)`.

**Dual login endpoint contract** (recommended for domain agents):

```
POST /api/onboard/login
Body (either):
  { auth_token: string }                // legacy token path
  { identifier: string, password: string }  // username (slug OR email) + password
Response:
  { type: 'user' | 'admin', slug, displayName }   + Set-Cookie: bindrive_session
```

Dispatch: if `auth_token` present → `resolveByToken`. Else if both `identifier` and `password` → `authenticateUser`. Else 400 with a clear "either X or Y required" message. Never fall through from one method to the other.

**Never expose `password_hash` over the wire.** Any `GET /users/:slug` endpoint (e.g. for an admin console) must strip both `auth_token` AND `password_hash` before serializing — they're secrets, not data.

---

## 8. Walkthrough — wiring Invage end-to-end

This is the minimal sequence from "blank repo" to "running agent".

### 8.1 The entry point

```ts
// invage: src/index.ts (pattern)
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
process.env.UTARUS_LOADED_BY_HOST = '1';

import { createFramework } from 'utarus';
import { invageExtension } from './extension.js';

const framework = createFramework({ extension: invageExtension });

// WebUI (same process as agent pool) — see docs/webui-integration.md
if (process.env.WEBAPP_PORT) {
  const { onboardRouter } = await import('./onboard/api.js'); // domain landing only
  framework.startWebApp({
    port: parseInt(process.env.WEBAPP_PORT, 10),
    extraRouters: [{ path: '/api/onboard', router: onboardRouter }],
  });
}

// Boot chat channels as configured (env-driven).
if (process.env.SLACK_BOT_TOKEN) void framework.startSlack();
if (process.env.TELEGRAM_BOT_TOKEN) void framework.startTelegram();
// framework.startCli();  // local REPL when not BOT_ONLY
```

### 8.2 The extension

```ts
// invage: src/extension.ts (excerpt)
export const invageExtension: DomainExtension = {
  purpose: INVAGE_PURPOSE,                   // §5.1
  tools: () => createInvageTools(),          // §5.2 + §6.1
  skills: INVAGE_SKILLS,                     // §5.3
  telegramCommands: [{ name: 'guidance', … }],     // §5.4
  slackCommands: [{ name: 'guidance', … }, { name: 'bind', … }, { name: 'onboard', … }],
  enrichMessage,                             // §5.5 (with web branch per §3.2)
};
```

### 8.3 Domain state on top of framework state

```ts
// invage: src/state/portfolio-state.ts — InvestorState extends UserState
//   §4.2 for the full file
```

### 8.4 Domain tools following the channel-id pattern

```ts
// invage: src/tools/portfolio.ts — add_holding, remove_holding, get_portfolio, …
//   §6.1 for the channel.ts helper every tool uses
```

### 8.5 Boot sequence

1. `createFramework({ extension })` composes the system prompt, merges skill catalogs, prepares the tool factory.
2. `framework.startWebApp()` serves SPA + chat + BinDrive; `startSlack` / `startTelegram` as configured.
3. **Slack/Telegram:** inbound → `resolveInboundMessage` → `enrichMessage` → `getOrCreateAgent(slug)` → reply.
4. **Web:** browser login → `POST /api/chat/messages` → gate + enrich → `getOrCreateAgent(slug, isAdmin, 'web', conversationId)` → SSE stream; messages persist under `data/chats/<slug>/`.
5. Domain tools resolve the user via channel ids **or** slug, mutate state via `saveState`, return text.

---

## 9. Hard rules and common pitfalls

| Rule | Why |
|---|---|
| **No fallback for code/logic errors.** Surface raw errors; fail fast. | Per project policy. Silent fallbacks mask bugs and corrupt state. |
| **Never duplicate framework exports.** If `loadState` exists in utarus, do not write `loadInvestorState`. | Duplication drifts. The framework I/O is the source of truth. |
| **Always handle all three channels** in `enrichMessage` and in any domain resolver. | Missing the web branch causes the re-onboarding trap (§3.2). |
| **Store only user-visible text** in chat history; enrich is for the model. | Polluted blue bubbles when switching chats ([webui-integration.md](webui-integration.md)). |
| **Run WebUI in the agent process** (`WEBAPP_PORT` on the same unit as the pool). | Chat SSE has no agent if drive-only. |
| **`auth_token` is a password.** Never log it; never return it from a `GET`. | Treat like a credential. |
| **Never edit a reserved framework field** (`user.id`, `user.slug`, `user.created_at`, channel-id arrays) from domain code. | The framework owns identity. Use the framework tools (`link_telegram`, etc.). |
| **Don't add caching for state I/O.** | Premature optimization. The framework is synchronous on purpose. |
| **Don't write your own access gate.** | The framework gate handles `INV-`/`ADM-`/demo. Domains add custom flows as slash commands that bypass the gate. |

---

## 10. Reference: public API surface

The framework exports the following from the package root (`src/index.ts`). Domain agents import from `'utarus'` only.

**Bootstrapping:**
```ts
createFramework({ extension }): Framework
```

**Domain contract:**
```ts
type DomainExtension, EnrichMessageContext, Skill, LoadedSkill
```

**State (I/O + resolvers):**
```ts
loadState(slug): UserState
saveState(state): string
blankState({ slug, displayName, contactEmail }): UserState
stateExists(slug): boolean
stateFilePath(slug): string
assertValidSlug(slug): void
listUserSlugs(): string[]
resolveUserBySlug(slug): UserState | null
resolveUserBySlackUser(id): UserState | null
resolveUserByTelegramUser(id): UserState | null
type UserState, UserIdentity, UserProfile, LogEntry, InviteCode, AdminOnboardCode
```

**Onboarding (framework-owned):**
```ts
redeemInviteInstantly({ code, displayName, slackUserId?, telegramUserId?, web? }): InstantRedeemResult
ensureChannelUser({ displayName, slackUserId?, telegramUserId?, web?, source, contactEmail? }): InstantRedeemResult
fetchSlackDisplayName(slackUserId): Promise<string>
resolveInboundMessage({ text, linkedUser, isAdmin, channelDisplayName?, enrichMessage? }): Promise<{kind, …}>
type InstantRedeemParams, InstantRedeemResult, EnsureChannelUserSource
```

**Invite + admin codes:**
```ts
createInviteCode(params): InviteCode
validateInviteCode(code): InviteCode
markInviteUsed(code, telegramUserId, slug, slackUserId?): InviteCode
listInviteCodes(filter?): InviteCode[]
createAdminOnboardCode(params): AdminOnboardCode
revokeAdminOnboardCode(code): AdminOnboardCode
listAdminOnboardCodes(filter?): AdminOnboardCode[]
loadDynamicAdminIds(): number[]
addDynamicAdminId(id): void
```

**Demo mode:**
```ts
isDemoModeEnabled(): boolean
getDemoModeState(): DemoModeState
setDemoMode(params): void
parseDemoModeArgs(args): { … }
formatDemoModeStatus(): string
```

**Auth (web):**
```ts
createLinkToken(params): LinkTokenResult
appendLinkToken(url, token): string
buildAuthedUrl(baseUrl, path, params): { url, token, expiresAt, expiresInMs }
signedBinDriveViewUrl(ownerSlug, filename, opts?): { url, expiresAt, expiresInMs, token }
publicBinDriveOrigin(): string
createSession(user): string  // returns session token for cookie
resolveByToken(token): AuthUser | null
authenticateUser(identifier, password): Promise<AuthUser | null>
hashPassword / verifyPassword / generateMemorablePassword
requireAuth, requireAdmin, targetSlug  // Express middlewares
type AuthUser, CreateLinkTokenParams, LinkTokenResult
```

**Web server + WebUI:**
```ts
// Preferred: full SPA + chat + BinDrive + admin (needs Framework)
framework.startWebApp({ port?, extraRouters?, webDistDir? }): Express
framework.buildWebApp({ extraRouters?, webDistDir? }): Express

// Standalone BinDrive only (no chat agent pool)
startBinDrive(opts?): Express
createBinDriveApp(): Express
resolveWebDistDir(): string
UTARUS_VERSION: string

// Conversation store (usually used via /api/chat; exported for tests/tools)
listConversations(slug)
createConversation(slug, opts?)
getConversation(slug, id)
// …
```

**Telegram formatting:**
```ts
escapeHtml(s): string
convertMarkdownTables(md): string
markdownToTelegramHtml(md): string
splitTelegramHtml(html, maxLen): string[]
```

**HTML delivery:**
```ts
wantsHtmlDelivery(text): boolean
publishHtmlReport(params): Promise<PublishHtmlReportResult>
createPostHtmlReportTool(): AgentTool
type PublishHtmlReportParams, PublishHtmlReportResult
```

**Usage caps:**
```ts
loadUsage(slug): UsageState
getCap(slug, kind): number | undefined
attachUsageTracking(emit): void
```

**Config:**
```ts
config: AppConfig
resolveDataRoot(): string
getCurrentChatId(ctx): number | null  // Telegram helper
registerDomainSkill(id, content): void
allSkillIds(): string[]
SKILLS: Skill[]
```

If something you need isn't here, check `src/index.ts` — exports may have been added since this doc was written. If it genuinely doesn't exist, open a design discussion before duplicating it in your domain.
