---
layout: default
title: WebUI Chat — Design Doc
---

# WebUI Chat Interface — Design Doc

A first-class web chat channel for the Invester agent, sitting alongside the existing Telegram and Slack channels. Same agent pool, same per-user YAML state, same invite/admin gate.

Status: **design**. No code yet.

---

## 1. Goals

1. **Talk to the agent from a browser** — same agent pool, same tools, same per-user YAML state as Telegram/Slack. **Conversation context is isolated per channel** — see §4.
2. **Token streaming** — see the answer build up live, see which tool is running, surface errors visibly. Parity with the Slack UX (`eyes → gear → ✅/❌`).
3. **First-class markdown** — Invester's analysis replies have tables, code blocks, lists. Telegram/Slack flatten tables to bullets; the WebUI should render real [GFM](https://github.github.com/gfm/) including tables.
4. **Reuse, do not fork** — same `Framework`, same `getOrCreateAgent`, same `resolveInboundMessage` gate, same `auth_token` login surface that BinDrive already uses.
5. **One process, one port** — do not introduce a new daemon. Hang chat off the existing webapp process.

## 2. Non-goals

- **No new auth system.** We reuse Utarus `auth_token` + `WEBAPP_ADMIN_CREDENTIALALS` + short-lived link tokens. No OAuth, no separate user table.
- **No new agent runtime.** We use the framework's per-key agent pool. The web channel gets its own conversation context keyed `web:<slug>`, isolated from Slack/Telegram. The user's **profile, portfolio, playbook, log, BinDrive files, and skills** remain shared because they all key off `slug` in the YAML — only the in-memory conversation is per-channel.
- **No response caching, batching, or prefetch** (per project hard rule #3). Straight-through request → agent → stream.
- **No fallback paths** (hard rule #2). Agent errors surface to the UI; missing auth 401s; no silent defaults.
- **No mobile native app.** Mobile is the responsive web page.
- **Phase 2 (called out, not designed here):** persisted chat history, file uploads, voice input, multi-account switcher.

## 3. What already exists (and is reused)

Verified against `node_modules/utarus/src/`:

| Capability | Source | What we get for free |
|---|---|---|
| Per-user agent pool, 24h TTL, 100-cap | `agent.ts` → `getOrCreateAgent(cacheKey, slug, isAdmin, opts)` | Cache key is channel-scoped — web uses `web:<slug>`, Slack/Telegram keep today's keys (`<slug>` for linked, `tg-<id>` / `slack-<id>` for unlinked). Same pool, separate conversations. **Requires a small, backward-compatible framework change** — see §4. |
| Streaming events | `agent.subscribe(event)` in `pi-agent-core` | Event types: `message_update.text_delta`, `message_end.stopReason`, `tool_execution_start`, `tool_execution_end`. Same shape Slack already uses. |
| Steer when busy | `agent.steer({role, content, timestamp})` | User can queue a follow-up while a run is in flight. |
| Abort watchdog | `agent.abort()` after 10 min (`AGENT_RUN_TIMEOUT_MS`) | Surfaces as `stopReason: 'aborted'`. |
| Invite / admin / demo gate | `onboarding/access-gate.ts` → `resolveInboundMessage` | Handles `INV-` instant redeem, `ADM-` admin onboard, demo mode. One call. |
| LLM token cap | `usage/caps.ts` → `getCap`; `checkLlmCap()` in `slack/app.ts` | Reject run before it starts if user is over cap. |
| HTML report delivery | `report/html-delivery.ts` → `publishHtmlReport` + `wantsHtmlDelivery` | Long answers (>3000 chars) or explicit "html report" requests publish to BinDrive and return a view URL. |
| Asset-producing tools | `tools/post-html-report.ts` (`post_html_report`), `tools/write-report.ts` (`write_report`), invage `src/tools/save_report.ts` + `snapshot.ts`, framework `bindrive_*` | Agent already publishes HTML/JSON/CSV to BinDrive and writes the signed view URL into its reply. The WebUI just has to *render* those URLs intelligently — see §8.4. |
| BinDrive file endpoints | `webapp/routes.ts` | `GET /api/files` (list), `POST /api/files` (upload, JSON or multipart), `GET /api/files/:name` (download, `Content-Disposition: attachment`), `GET /api/files/:name/view` (inline HTML view), `DELETE /api/files/:name`. All `requireAuth` + cookie-friendly. **Gap:** `/view` hard-codes `text/html` — see §8.8 for a new `/raw` variant that sniffs Content-Type per extension so `<img>`/`<video>`/`<audio>` work. |
| Signed view URLs | `webapp/auth.ts` → `signedBinDriveViewUrl`, `createLinkToken`, `buildAuthedUrl` | Short-lived `?t=<token>` deep links. Used by Slack/Telegram today to send users to BinDrive in their phone browser. Same primitive lets the WebUI render an asset URL that opens without a re-login prompt. |
| Web auth | `webapp/auth.ts` → `requireAuth`, `resolveByToken`, `createSession`, `createLinkToken`, `tryExchangeLinkToken` | Bearer token / cookie / `?t=` link token. Session cookie is `bindrive_session`, 24h TTL. |
| Express app shell | `webapp/server.ts` → `createBinDriveApp()` | cookie-parser, body parsers, `/login`, `/logout`, `/api/files/*`, `/health`. Already extended by `src/webapp/server.ts` to mount `/api/onboard`. |
| Admin commands | Slack/Telegram slash handlers | We re-implement the same admin REST endpoints (logic exists in `state/index.ts`: `createInviteCode`, `createAdminOnboardCode`, `setDemoMode`, etc.). |
| Markdown helpers | `interfaces/slack/markdown-to-html.ts`, `interfaces/telegram-format.ts` | We don't want these — they flatten for chat apps. We render raw GFM in the browser. |

## 4. Data model

**No schema migration required.** This is the most important constraint and the reason the design is small.

The existing user file `data/users/<slug>.yaml` is the source of truth:

```yaml
user:
  id: 550e8400-...
  slug: alice
  created_at: 2026-07-14
  telegram_user_ids: [123456789]   # existing
  slack_user_ids: ["U01ABCDEF"]    # existing
  auth_token: 660e8400-...         # ← the WebUI logs in with this
profile:
  display_name: Alice Chen
  contact_email: alice@example.com
log: [...]
portfolio: {...}                   # domain-specific
playbook: {...}                    # domain-specific
```

`auth_token` is already described in the framework README as *"Auth token for any external portal/API the user needs to reach."* It is the right key for the WebUI:

- **Login** = "enter your `auth_token`". Resolves one-to-one to a user via `resolveByToken(token)` → `{type:'user', slug, displayName, userId}`.
- **Session** = existing `bindrive_session` cookie. Same cookie works for `/api/files/*` (BinDrive) and `/api/chat/*` (new).
- **Agent cache key** = `web:<slug>` — see §4.2 below for why this is a separate key, not the bare `<slug>` Slack/Telegram use.

No new identity field is needed on the YAML. The web channel does not get its own `web_user_ids[]` array because the auth_token already uniquely identifies the user. (If we later want "log in with Slack/Google instead of typing a UUID", that becomes a new resolver — not a schema change.)

### 4.1 Shared vs isolated across channels

The user said: web must not share its conversation with Slack/Telegram, but profile/memory/skills must remain shared. This falls out naturally from the data model once the cache key is channel-scoped:

| Layer | Lives in | Shared across channels? | Why |
|---|---|---|---|
| Profile (`display_name`, `contact_email`, …) | `data/users/<slug>.yaml` | **Yes** | Same file for every channel. |
| Portfolio holdings | `data/users/<slug>.yaml#portfolio` | **Yes** | Same file. A holding added from web shows up in Slack on the next `get_portfolio`. |
| Playbook | `data/users/<slug>.yaml#playbook` | **Yes** | Same file. |
| Activity log | `data/users/<slug>.yaml#log` | **Yes** | Single audit trail. |
| BinDrive files | `data/drive/<slug>/` | **Yes** | Same directory. |
| Skills catalog | `framework.allSkills` | **Yes** | Framework-wide. |
| Agent conversation context (in-memory) | `pi-agent-core`'s `Agent.state` | **No** | Cache key is per-channel: `tg:<id>` or `<slug>` for Telegram, `<slug>` for Slack, **`web:<slug>` for web**. |
| Active run / "agent is streaming" flag | per-cache-key `Agent.state.isStreaming` | **No** | A web run and a Slack run can both be live for the same user without contending. |

Net behavior the user sees: open the web UI, get a fresh conversation. The agent still knows your portfolio, your playbook, your name — because it re-reads the YAML every turn. What it doesn't have is the back-and-forth from your last Slack session.

### 4.2 Framework change: split cache key from tool slug

Today the framework conflates two roles in one string:

```ts
// utarus/src/framework.ts (current)
const getOrCreateAgent = (userSlug: string, isAdmin: boolean) =>
  baseGetOrCreateAgent(userSlug, /* <- used as BOTH cache key and tool slug */
                       isAdmin, { systemPrompt, tools: allTools, ... });
```

The string is both the cache Map key (isolates conversation) and the argument passed to `opts.tools(userSlug, isAdmin)` (so tools know which YAML to load). For Slack/Telegram this is fine because linked users share their `<slug>` conversation. For web we need them to diverge.

**Proposed change (small, backward-compatible):**

```ts
// utarus/src/agent.ts
export function getOrCreateAgent(
  cacheKey: string,           // isolates the in-memory conversation
  userSlug: string,           // passed to tools, used to load YAML
  isAdmin: boolean,
  opts: GetOrCreateAgentOptions,
): Agent { /* … unchanged body, just uses cacheKey for the Map … */ }

// utarus/src/framework.ts
const getOrCreateAgent = (
  userSlug: string,
  isAdmin: boolean,
  channelScope?: 'web',       // extend later: 'slack' | 'telegram' if we want full isolation
) => baseGetOrCreateAgent(
    channelScope ? `${channelScope}:${userSlug}` : userSlug,
    userSlug,
    isAdmin,
    { systemPrompt, tools: allTools, enforceCaps: !isAdmin },
  );

// Framework wrapper the chat router uses
framework.getOrCreateAgent(slug, isAdmin, 'web');
```

Existing callers (Telegram, Slack, CLI) don't pass `channelScope` — their behavior is unchanged. Only the web chat router passes `'web'`. If we later decide to isolate Slack from Telegram too, that's the same parameter with different values — no further API change.

Usage caps (`usage/agent-tracking.js`) also key off the cache key today. We want usage to be **per-user, not per-channel** — a user shouldn't triple their token budget by hitting three channels. The caps wrapper needs to be invoked with `userSlug`, not `cacheKey`. This is the same one-line change inside the framework: pass `userSlug` to `wrapToolsWithCaps` and `attachUsageTracking`.

### 4.3 Tool resolution for the web channel

Domain tools in `src/tools/` resolve the user via `channelIdParams` + `resolveInvestorFromChannel` (`src/tools/channel.ts`). Today that accepts `telegram_user_id` OR `slack_user_id`. Web has neither — the agent only knows the slug from the message context that `defaultLinkedContext` injects.

Add `user_slug` as a third resolution path:

```ts
// src/tools/channel.ts (proposed)
export const channelIdParams = {
  telegram_user_id: Type.Optional(Type.Number({ description: 'Telegram user ID (Telegram channel).' })),
  slack_user_id:    Type.Optional(Type.String({  description: 'Slack user ID (Slack channel).' })),
  user_slug:        Type.Optional(Type.String({  description: 'User slug (Web channel). Provide this OR telegram_user_id OR slack_user_id.' })),
} as const;

export function resolveInvestorFromChannel(p: ChannelIds): InvestorState {
  if (p.user_slug) {
    const state = resolveInvestorBySlug(p.user_slug);     // new helper: loadState(slug) + InvestorState shape
    if (!state) throw new Error(`No user with slug "${p.user_slug}".`);
    return state;
  }
  // …existing telegram / slack branches unchanged…
}
```

Every portfolio tool inherits this automatically because they all spread `...channelIdParams`. The agent's tool descriptions tell it to pass whichever ID is in the message context — web's context has the slug, so the LLM picks `user_slug`.

The framework's `access-gate.ts` already injects the slug into the agent prompt via `defaultLinkedContext`:

```
[User context: You are working with user "alice" (Alice Chen, contact=alice@example.com). …]
```

so the LLM has the slug in view when it picks tool parameters. No prompt change needed.

### 4.4 Onboarding a brand-new user via the web (in Phase 1)

Today `ensureChannelUser` requires `slackUserId` or `telegramUserId`. A web user has neither. **This is now in scope for Phase 1** (was Phase 2 — pulled in per review).

The framework change is small and symmetric with the existing chat-platform path:

```ts
// utarus/src/onboarding/instant-invite.ts (proposed)
export type EnsureChannelUserSource = 'invite' | 'demo';

export function ensureChannelUser(params: {
  displayName: string;
  slackUserId?: string;
  telegramUserId?: number;
  /** Set when onboarding from the web (no chat platform id available). */
  web?: boolean;
  source: EnsureChannelUserSource;
  inviteCode?: string;
}): InstantRedeemResult {
  const hasChannelId = !!params.slackUserId || params.telegramUserId != null;
  if (!hasChannelId && !params.web) {
    throw new Error('ensureChannelUser requires slackUserId, telegramUserId, or web: true');
  }
  // …existing branches for slack/telegram lookup unchanged…
  // For web: skip the resolveUserBy{Telegram,Slack} lookup (no id),
  // build the slug from displayName (same slugBaseFromDisplayName path),
  // save state with empty telegram_user_ids / slack_user_ids.
  // The returned `authToken` is what the web session logs in with.
}
```

`resolveInboundMessage` in `access-gate.ts` gets a parallel branch: when an unauthenticated web visitor POSTs `INV-XXXXXXXX` + display name to `/api/onboard/redeem`, the chat router calls `redeemInviteInstantly({ code, displayName, web: true })` directly (no agent turn required). The endpoint returns the freshly-minted `auth_token`; the browser immediately creates a session and redirects to `/`.

**What is unchanged:**

- `validateInviteCode`, `markInviteUsed`, the `INV-XXXXXXXX` format, single-use semantics.
- The YAML shape — web users are stored identically to chat-platform users, just with empty `telegram_user_ids`/`slack_user_ids` arrays.
- Admin tools for issuing/revoking codes — same endpoints, same shapes.

**What this enables that wasn't possible before:** a person with no Telegram/Slack account can fully onboard through the web. They get the same agent, same portfolio tools, same BinDrive. Their `auth_token` works as their login forever; if they later install Slack, an admin can run a `/link` command (future work) to add their slack_user_id to the same YAML.

### 4.5 Persisted conversations (shipped)

WebUI multi-chat is server-persisted under `data/chats/<slug>/`:

```
data/chats/<slug>/
  index.json                 # ConversationSummary[] (newest first)
  <conversationId>.json      # full Conversation + messages[]
```

- Each conversation has its own agent cache key: `web:<slug>:<conversationId>`.
- On refresh, the SPA reloads the list and the active conversation (remembered in `localStorage`).
- `/clear` clears messages in the **current** conversation (keeps the list entry).
- Delete removes the conversation file + index entry + agent cache.
- Domain YAML (`data/users/<slug>.yaml`) is unchanged — only chat transcripts live under `chats/`.

## 5. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser — React SPA (Vite + Tailwind)                              │
│                                                                    │
│   POST /api/chat/messages      → { messageId }                     │
│   GET  /api/chat/stream/:id    ← SSE (delta / tool / done / error) │
│   POST /api/chat/clear                                             │
│   GET  /api/chat/agent            → { isStreaming, displayName }   │
│   POST /login  /logout          (existing)                         │
│   /api/admin/*                  (admin REST — invites, demomode)   │
└────────────────────────────┬───────────────────────────────────────┘
                             │ HTTPS (one port — WEBAPP_PORT)
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ express app  =  createBinDriveApp()  +  chatRouter                 │
│                                                                    │
│   cookie-parser, /login, /logout, /api/files/*, /api/onboard       │
│   requireAuth (Bearer | cookie | ?t=)  →  req.user = AuthUser      │
│                                                                    │
│   chatRouter:                                                      │
│     POST /messages                                                 │
│       1. linkedUser = loadState(req.user.slug)                     │
│       2. resolveInboundMessage({text, linkedUser, isAdmin})        │
│       3. checkLlmCap → 429 if over                                 │
│       4. agent = framework.getOrCreateAgent(slug, isAdmin)         │
│       5. if agent.state.isStreaming → agent.steer(...) / 409       │
│       6. messageId = register stream subscriber                    │
│       7. fire agent.prompt(text) + waitForIdle() in background     │
│       8. return { messageId }                                      │
│                                                                    │
│     GET /stream/:messageId  (SSE)                                  │
│       1. look up subscriber registry                               │
│       2. replay buffered events (client reconnect scenario)        │
│       3. pipe live events until done|error|aborted                 │
│                                                                    │
│   framework (createFramework({ extension: invageExtension }))      │
│     ↳ in-process agent pool. Web chat keys agents as `web:<slug>`,│
│       isolating its conversation from Telegram + Slack. YAML state│
│       (profile/portfolio/playbook/log) and skills remain shared.  │
└────────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ data/users/<slug>.yaml  (existing — source of truth)               │
└────────────────────────────────────────────────────────────────────┘
```

### Where it runs

Today: `npm run dev` boots the framework + Telegram + Slack + CLI. `npm run webapp` boots a **separate** BinDrive-only process (no agent).

After this change:

- The chat routes need the in-memory agent pool. The pool is not exposed across processes. **Therefore the chat routes must live in the agent process.**
- Cleanest restructure: `src/index.ts` builds the framework as today, then *also* boots the express listener (`createBinDriveApp()` + chat router + onboard router) on `WEBAPP_PORT` inside the same process. BinDrive-as-separate-process remains supported as a deployment variant — it serves files independently and does not need the agent.
- Net operational change: one fewer systemd unit in the common case. The existing `npm run webapp` script stays for BinDrive-only deployments.

## 6. Transport — why SSE, not WebSocket

Token streaming is **server→client only**. The client sends one POST per turn; the server streams back a potentially long sequence of deltas. This is the textbook SSE case.

| | SSE | WebSocket |
|---|---|---|
| Direction | server→client (we only need this) | bidirectional (unused) |
| Transport | HTTP/1.1 or HTTP/2 | upgrade handshake |
| Reconnect | built-in (`retry:` + `Last-Event-ID`) | manual |
| Proxy/LB friendliness | high (it's just HTTP) | mixed (some LBs time out the upgrade) |
| Browser API | `EventSource` — 4 lines | `WebSocket` — more, plus a reconnection wrapper |
| Existing infrastructure | express does it natively | needs `ws` or similar |

WebSocket's bidirectional capability is wasted: we have nothing to push from server-to-client other than the stream itself. SSE it is.

We keep one POST endpoint per turn (not "send message via SSE") because:
- POST is idempotent-enough for our case (the gate + cap check + steer-vs-reject decision must happen server-side before the run starts).
- It cleanly maps to a `messageId` the client can reconnect to with `Last-Event-ID` if the SSE drops.

## 7. Protocol

### 7.1 Send a message

`POST /api/chat/messages`

```json
{
  "text": "Analyze my portfolio for sectors > 30%"
}
```

Auth: `requireAuth` (Bearer `auth_token`, or `bindrive_session` cookie, or `?t=` link token).

Server:

1. `linkedUser = loadState(req.user.slug)` — fail-fast if the user file disappeared (401 → "session invalid").
2. `inbound = await resolveInboundMessage({ text, linkedUser, isAdmin: req.user.type === 'admin' })`.
   - Note: we pass **no** `slackUserId`/`telegramUserId`. The gate still handles `INV-`/`ADM-`/demo for the rare case a web user pastes a code into chat.
3. If `inbound.kind === 'reply'` → return `{ kind: 'reply', text }` (HTTP 200, no agent call). Client renders it directly.
4. `cap = checkLlmCap(req.user.slug, isAdmin)` — if over → HTTP 429 + `{ error: 'cap_exceeded', message, current, cap }`.
5. `agent = framework.getOrCreateAgent(req.user.slug, isAdmin, 'web')` — keys the conversation as `web:<slug>`, isolated from any Slack/Telegram run the same user may have live.
6. If `agent.state.isStreaming`:
   - If `body.queue === false` (default) → HTTP 409 + `{ error: 'busy' }`. Client shows "still working on your last message…".
   - If `body.queue === true` → `agent.steer({role:'user', content: inbound.text, timestamp: Date.now()})`, return `{ kind: 'queued' }`.
7. Otherwise: `messageId = randomUUID()`. Register a `StreamSession` keyed by `messageId` in an in-process `Map`. The `agent.subscribe(...)` callback writes events into this session's ring buffer (last N events kept for replay on reconnect). Kick off `runAgent(messageId, agent, inbound.text)` in the background — the request returns immediately.
8. Return `{ kind: 'run', messageId }`.

### 7.2 Stream a message

`GET /api/chat/stream/:messageId`

Response: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (disable nginx buffering).

Event types (one per `event:` block):

```
event: ack
data: {"messageId":"...","slug":"alice","agentName":"Invester"}

event: tool_start
data: {"toolCallId":"call_1","name":"get_portfolio","startedAt":1721000000000}

event: tool_end
data: {"toolCallId":"call_1","ok":true,"durationMs":240}

event: delta
data: {"text":"Looking","cumulative":"Looking"}
data: {"text":" at","cumulative":"Looking at"}
…

event: heartbeat
data: {"elapsedMs":4200,"activeTools":["portfolio_analyzer"]}

event: done
data: {"text":"…full final answer…","stopReason":"stop","htmlReportUrl":null,"assets":[
  {"kind":"html","url":"/api/files/invester-report-20260714.html/view?slug=alice","filename":"invester-report-20260714.html","ownerSlug":"alice","bytes":48213},
  {"kind":"image","url":"/api/files/sector-allocation.png?slug=alice","filename":"sector-allocation.png","ownerSlug":"alice","bytes":9120},
  {"kind":"csv","url":"/api/files/snapshot-20260714.csv?slug=alice","filename":"snapshot-20260714.csv","ownerSlug":"alice","bytes":1244}
]}

event: error
data: {"message":"Agent error: ...","phase":"during_run"}

event: cap
data: {"message":"🚫 You've hit your monthly LLM token cap","current":123456,"cap":200000}

event: end
data: {}
```

Semantics:

- `ack` — first event, always. Confirms the run started.
- `tool_start` / `tool_end` — pairs; `tool_end` has `ok: boolean` and `durationMs`.
- `delta` — `text` is the new token; `cumulative` is the full text so far. Client can use either; `cumulative` is what Slack's updater uses and is safer for re-renders.
- `heartbeat` — sent every 3s while the run is in progress (parity with Slack's `monitor.beat()`). Client can render an "Xs elapsed" timer. If no event arrives for 30s the client shows a warning.
- `done` — final text + `stopReason` (`stop` | `toolUse` | `length` | `aborted`). The server scans the final text for BinDrive asset references (see §8.6) and emits them as a structured `assets[]` list. The text itself still contains the markdown links/images — the renderer produces inline embeds from those; `assets[]` is metadata for the attachment strip, prefetch hints, and the "Open full report" affordance (replaces the old `htmlReportUrl` scalar — that field is now `assets.find(a => a.kind === 'html')?.url`).
- `error` — replaces `done`. Always followed by `end`.
- `cap` — sent before the agent call when the cap is hit; followed by `end`.
- `end` — terminal. Client closes the EventSource.

**Reconnect:** if the EventSource drops (network blip), the client reopens with `?last_event_id=<id>` (or the SSE standard `Last-Event-ID` header). Server replays events from the session's ring buffer with `id:` fields, then continues live. Sessions expire 5 min after the run finishes (client must finish reading by then).

### 7.3 Clear context

`POST /api/chat/clear` → `framework.clearAgentContext(req.user.slug)` → `{ ok: true }`. Same as Slack/Telegram `/clear`.

### 7.4 Agent status

`GET /api/chat/agent` → `{ slug, displayName, isStreaming, hasContext }` (for the UI to render an "agent is thinking" banner across page refreshes).

### 7.5 Slash commands (client-side)

The chat input recognises `/clear` and `/help` locally — they hit the REST endpoints, not the agent. `/clear` calls 7.3. `/help` opens a modal. This matches how Slack handles them.

### 7.6 Admin REST

Same operations as the Telegram/Slack slash commands, REST-shaped. All under `/api/admin/*`, all `requireAdmin`.

```
POST   /api/admin/invites              { comment? }            → { code, createdAt }
GET    /api/admin/invites              ?filter=all|unused|used → [ InviteCode ]
POST   /api/admin/admincodes           { comment? }            → { code, createdAt }
GET    /api/admin/admincodes           ?filter=…               → [ AdminOnboardCode ]
POST   /api/admin/admincodes/revoke    { code }                → { ok }
POST   /api/admin/demomode             { enabled }             → { enabled, updatedAt }
GET    /api/admin/demomode                                      → { enabled, updatedAt }
GET    /api/admin/users                                        → [ { slug, displayName, createdAt } ]
GET    /api/admin/users/:slug                                  → UserState
```

These reuse `createInviteCode`, `createAdminOnboardCode`, `revokeAdminOnboardCode`, `setDemoMode`, `getDemoModeState`, `listUserSlugs`, `loadState` from `state/index.ts` + `onboarding/demo-mode.ts`.

## 8. Rendering: markdown and embedded assets

The web channel is the first surface where the agent's reply can be richer than flattened plain text. We render full GFM **and** detect asset references in the reply to embed them inline — HTML reports in sandboxed iframes, images inline, CSVs as tables, PDFs in a viewer, video/audio as native players.

### 8.1 Markdown formatting rules

The agent's system prompt today tells it "you are displayed in Telegram/Slack — never use markdown tables, flatten to bullets". That instruction is wrong for the WebUI: tables are exactly what an analysis reply needs.

Two ways to fix this:

- **Phase 1 (no framework change):** the chat router prepends a one-line channel hint to the user's message before calling the agent:
  ```
  [Channel: web — render full GFM markdown. Tables are welcome. Code blocks use fenced syntax.
   For BinDrive assets, write standard markdown links/images using the URLs your tools returned.
   Keep total length reasonable.]

  <original user text>
  ```
  This nudges the model without touching the system prompt. Cheap, reversible, ship it.
- **Phase 2 (cleaner, requires utarus change):** lift the formatting section out of `buildSystemPrompt` and pass it via `FrameworkHandle.extension.channelFormatting` (a new optional field) so each channel supplies its own. Slack/Telegram pass "no tables, use bullets"; web passes "full GFM + standard markdown asset links". The system prompt becomes channel-agnostic.

Decision: ship Phase 1. Note Phase 2 as a follow-up.

### 8.2 Rendering stack

- `react-markdown` — the standard React markdown renderer.
- `remark-gfm` — tables, strikethrough, task lists, autolinks.
- `remark-math` + `rehype-katex` — Invester occasionally uses inline math; matches the KaTeX pipeline already used in `AlanStudent1`.
- `rehype-highlight` (or `shiki`) — syntax highlighting for code blocks.
- `rehype-raw` — **only inside sandboxed HTML-report iframes**, never in the main chat surface. Lets agent-authored HTML reports render their own inline styles/scripts.
- `rehype-sanitize` with a GFM-safe schema — **XSS guard on the chat surface**, mandatory because the text comes from an LLM. Schema extended to allow `data-asset-kind`, `data-asset-url`, `data-asset-filename` on `<a>`/`<img>`, plus a tightly-scoped `<iframe>` allowlist (see §8.7 Security).
- `remark-bindrive-assets` (custom, ~80 lines) — a remark plugin that walks link/image nodes, recognises BinDrive URLs, classifies them by file extension, and tags the node with `data-asset-kind`. See §8.5.

Streaming markdown: re-render on every `delta` event. `react-markdown` is fast enough for our reply sizes (a few KB); we memoise the component on `cumulative` so only the document tree diffs.

### 8.3 Asset categories

The agent already produces these today (via `post_html_report`, `write_report`, `save_report`, `save_snapshot`, `bindrive_*`). The WebUI renders each kind appropriately:

| Kind | Extension(s) | Source tool | Inline rendering | Phase |
|---|---|---|---|---|
| `html` | `.html` | `post_html_report`, `save_report` | Sandboxed `<iframe>` with "Open in new tab" + "Download" buttons. `sandbox="allow-scripts allow-same-origin allow-popups"` — scripts allowed (charts), same-origin allowed (loads BinDrive resources), but isolated from the parent page's cookies/DOM. | 1 |
| `image` | `.png .jpg .jpeg .gif .webp .svg` | (none today; future `save_chart`) | Inline `<img>` with click-to-zoom lightbox. | 1 |
| `csv` | `.csv` | `save_snapshot` (occasionally) | Fetched client-side, parsed, rendered as a GFM table. Row cap (default 200); overflow → "Show all N rows" toggles a code-block view. | 1 |
| `json` | `.json` | `save_snapshot` | Syntax-highlighted code block; if the top-level value is an array of objects, render as a table (same rules as CSV). | 1 |
| `pdf` | `.pdf` | (none today) | `<iframe src="/api/files/<name>/raw?slug=…">` — Chrome/Firefox/Safari all have built-in PDF viewers. Fallback: "Open PDF" button. | 1 |
| `text` | `.txt .md .log` | various | Code block + download link. | 1 |
| `video` | `.mp4 .webm .mov .m4v` | (none today; user upload) | `<video controls preload="metadata">`. | 2 |
| `audio` | `.mp3 .wav .ogg .m4a` | (none today; user upload) | `<audio controls preload="metadata">`. | 2 |
| `unknown` | anything else | — | Generic file card: filename + size + download button. | 1 |
| External link | `https://example.com/…` | agent writes a URL inline | Standard `<a target="_blank" rel="noopener noreferrer">`. **Never embedded.** Optional unfurl preview (OpenGraph) in Phase 2. | 1 (link) / 2 (unfurl) |

### 8.4 How the agent references assets

The agent uses standard markdown — no custom syntax. The renderer recognises the URL shape.

```markdown
Here's your full analysis:

[Open the 3-axis report](/api/files/invester-report-20260714.html/view?slug=alice)

Sector allocation:

![Sector allocation chart](/api/files/sector-allocation.png?slug=alice)

Raw snapshot for downstream use: [snapshot-20260714.csv](/api/files/snapshot-20260714.csv?slug=alice)
```

The same reply rendered in Slack today would just be flat text with URLs. In the WebUI, the renderer rewrites these nodes into embedded components (§8.5).

**Accepted URL shapes** (matched by the remark plugin, regex case-insensitive):

- `/api/files/<name>/view?slug=<ownerSlug>` — inline HTML view
- `/api/files/<name>?slug=<ownerSlug>` — raw download (image, csv, pdf, video, audio, text)
- `/api/files/<name>/raw?slug=<ownerSlug>` — raw with correct Content-Type (see §8.8)
- `https://<WEBAPP_PUBLIC_BASE_URL>/api/files/...` — absolute variant of the above
- Bare path without `?slug=` — only valid when `ownerSlug === req.user.slug`; the renderer injects the slug automatically (defensive — the agent should always include it).

Anything else is treated as an external link and rendered with `target="_blank"`.

### 8.5 Renderer pipeline

`react-markdown` with custom components:

```
markdown text
   │
   ▼
remark-gfm             (tables, strikethrough, autolinks)
remark-math            (inline/block math)
remark-bindrive-assets (custom: walk link/image nodes, classify by URL + extension,
                        tag with data-asset-kind, normalise the URL to /api/files/<name>/raw?slug=)
   │
   ▼
rehype-katex
rehype-highlight
rehype-sanitize        (allowlist schema — strips anything not approved;
                        allows data-asset-* attributes; <iframe> only with
                        sandbox attribute and same-origin src)
   │
   ▼
react-markdown components map:
  a       → <AssetLink>      (decides embed-vs-link based on data-asset-kind)
  img     → <AssetImage>     (lightbox, error fallback to file card)
  code    → <CodeBlock>      (syntax highlight + copy button)
  table   → <Table>          (sticky header, horizontal scroll for wide tables)
  iframe  → <SandboxedIframe> (HTML/PDF embed)
```

Component responsibilities:

- **`AssetLink`** inspects `data-asset-kind`. For `html`/`pdf` it renders an embedded viewer with a header strip ("📊 invester-report-20260714.html · 48 KB · [Open ↗] [Download ⬇]"). For `csv`/`json` it fetches the file and renders a table/code block. For `text`/`unknown` it renders a file card. For external links it renders a normal `<a>`.
- **`AssetImage`** renders `<img loading="lazy" src=…>` and swaps to a lightbox on click. On HTTP error (e.g. 401 from a stale session), it shows a "Session expired — reload" placeholder instead of a broken image.
- **`SandboxedIframe`** always sets `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`. The `src` is verified same-origin before render (defence-in-depth; rehype-sanitize already strips cross-origin iframes).

### 8.6 Server-side asset extraction

The `done` SSE event carries an `assets[]` array (see §7.2). The server scans the final agent text with a single regex pass after the run completes:

```ts
// src/webapp/chat/extract-assets.ts (proposed)
const ASSET_URL = /(?:\/api\/files\/([a-z0-9._-]+)(?:\/view|\/raw)?\?slug=([a-z0-9-]+))/gi;

const EXT_KIND: Record<string, AssetKind> = {
  html: 'html', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image',
  gif: 'image', webp: 'image', svg: 'image', csv: 'csv', json: 'json',
  txt: 'text', md: 'text', log: 'text', mp4: 'video', webm: 'video',
  mov: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio',
};

export function extractAssets(text: string, viewerSlug: string): AssetRef[] {
  const out = new Map<string, AssetRef>();
  for (const m of text.matchAll(ASSET_URL)) {
    const [, filename, ownerSlug] = m;
    if (ownerSlug !== viewerSlug) continue;            // strip cross-slug refs
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const kind = EXT_KIND[ext] ?? 'unknown';
    const url = m[0];
    if (out.has(url)) continue;
    out.set(url, { kind, url, filename, ownerSlug });
  }
  return [...out.values()];
}
```

This is the same pattern Telegram's interface uses to find files to send as documents (`slack/app.ts` lines 510–543), extended to all asset kinds and exposed as metadata. The client uses `assets[]` to:

- Render the attachment strip below the message ("📎 3 attachments: report · chart · csv").
- Hint the browser to `rel=prefetch` image/PDF assets as soon as the `done` event arrives, so the embed-in-render path is warm.

The text itself is unchanged — the inline embeds come from the markdown links via the remark plugin. `assets[]` is parallel metadata, not a render instruction.

### 8.7 Security

Asset embedding multiplies the surface area for XSS and cross-user access. Rules:

1. **Same-origin allowlist for embedding.** Only URLs whose path starts with `/api/files/` (or absolute equivalents matching `WEBAPP_PUBLIC_BASE_URL`) are eligible for inline rendering. Everything else — including `data:`, `javascript:`, `file:`, and external `https://` — is rendered as a plain link, never as `<img src>` / `<iframe src>` / `<video src>`. The remark plugin enforces this; `rehype-sanitize` is the backstop.
2. **Owner-slug check.** The renderer drops any asset URL whose `?slug=` does not equal `req.user.slug` (or, for admins, the slug they're currently viewing). The BinDrive endpoint enforces the same at the HTTP layer via `targetSlug`; this is defence-in-depth so the UI doesn't render broken/403 embeds.
3. **Sandboxed iframes only.** HTML and PDF embeds always carry `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`. Scripts run (charts work), but the iframe cannot reach the parent page's DOM, cookies, or `localStorage`. `allow-top-navigation` is deliberately **not** granted — the report cannot redirect the chat page.
4. **`rehype-sanitize` schema.** The default schema allows `<a>`, `<img>`, table elements, code, etc. We extend it to:
   - Allow `data-asset-kind`, `data-asset-url`, `data-asset-filename` on `<a>` and `<img>`.
   - Allow `<iframe>` **only** with a `sandbox` attribute present and `src` matching the `/api/files/` allowlist.
   - Strip `<script>`, `<object>`, `<embed>`, `<form>`, inline event handlers, `style=`, all `on*=` attributes.
5. **CSP headers.** The chat page ships `Content-Security-Policy` that disallows inline scripts in the parent document and restricts `frame-src` to `'self'`. The HTML-report iframe loads same-origin content; its own CSP (set by the report template) can be looser because the sandbox already isolates it.
6. **Asset upload path is admin/auth-scoped.** The existing `POST /api/files?slug=` requires `requireAuth` and uses `targetSlug` (user can only upload to their own slug; admin can specify any). No new exposure.
7. **Noexec on `/raw`.** The new `/api/files/:name/raw` endpoint (§8.8) sets `X-Content-Type-Options: nosniff` and only serves extensions in the allowlist with their canonical Content-Type. Unknown extensions fall through to `application/octet-stream` (download).

### 8.8 New endpoint: `/api/files/:name/raw` (small framework addition)

Today `/api/files/:name/view` hard-codes `Content-Type: text/html` and `Content-Disposition: inline`. That's correct for HTML reports but wrong for everything else — an `<img>` whose response advertises `text/html` will not render. The download endpoint (`/api/files/:name`) sets `Content-Disposition: attachment`, which also breaks inline `<img>`/`<video>` (browsers refuse to render attachments).

**Proposed addition to `utarus/src/webapp/routes.ts`:**

```ts
const RAW_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  pdf:  'application/pdf',
  png:  'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif:  'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  csv:  'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt:  'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  mp4:  'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3:  'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
};

router.get('/api/files/:name/raw', requireAuth, (req, res) => {
  const slug = targetSlug(req, (req as any).user);
  const name = basename(req.params.name as string);
  const filePath = join(driveDir(slug), name);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = RAW_CONTENT_TYPES[ext] ?? 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(readFileSync(filePath));
});
```

Backward-compatible — `/view` and the download endpoint are unchanged. The remark plugin rewrites every BinDrive image/video/audio/PDF URL to `/raw` before render.

### 8.9 File upload from the composer (Phase 2)

Once the basic embed path ships, user-side uploads fall out for free:

- Composer gets a paperclip button. Drop or pick a file → `POST /api/files?slug=<me>` (multipart) → existing endpoint stores it and returns `{ ok, name, size }`.
- The composer inserts `[<filename>](/api/files/<filename>?slug=<me>)` (or `![<filename>](...)` for images) into the message text.
- The agent sees the link in its prompt. The `bindrive_read_file` framework tool already exists for the agent to fetch and parse the contents.
- Renders inline in the user's own bubble using the same pipeline as agent-authored assets.

Limits (per project rule "no premature optimisation" — these are safety caps, not tuning):
- 25 MB per upload (Slack parity).
- 100 MB total per user drive (matches BinDrive's implicit expectation; admin can raise per-user via a future tool).

## 9. Frontend

### Stack

- **Vite + React 18 + TypeScript** — matches `AlanStudent1` / `academic-search-engine` conventions in the monorepo.
- **Tailwind CSS** — same.
- **TanStack Query** — small amount of REST state (admin lists, agent status). The SSE stream is raw `EventSource`, not Query.
- **lucide-react** — icons.
- **zod** — validate admin REST payloads (matches the "fail fast" rule; the server is strict).

### Page map

```
/login                  — token entry (existing BinDrive login, lightly restyled)
/                       — chat (default)
/admin/invites          — admin: invite codes
/admin/users            — admin: user list
/admin/users/:slug      — admin: user detail
/admin/demomode         — admin: demo mode toggle
```

### Chat page layout

```
┌──────────────────────────────────────────────────────────────┐
│ Invester · alice           [⌘K commands] [⚙ admin] [logout]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ── Tuesday, July 14 ──                                      │
│                                                              │
│  user: Analyze my portfolio for sectors > 30%                │
│                                                              │
│  Invester:                                                  │
│  ┌─ 🔧 get_portfolio · 240ms ✅ ─────────────────────────┐   │
│  │                                                        │   │
│  │  Looking at your portfolio, Technology is at 42%,      │   │
│  │  above your 35% cap. Suggested trim:                   │   │
│  │                                                        │   │
│  │  | Ticker | Weight | Over by |                         │   │
│  │  |--------|--------|---------|                         │   │
│  │  | AAPL   | 12%    | 2%     |                          │   │
│  │  | MSFT   | 18%    | 8%     |                          │   │
│  │                                                        │   │
│  │  ┌─ 📊 invester-report-20260714.html · 48 KB ────────┐ │   │
│  │  │ [sandboxed iframe — full 3-axis report renders   │ │   │
│  │  │  inline with charts; header strip has Open ↗ and │ │   │
│  │  │  Download ⬇ buttons]                              │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                        │   │
│  │  ┌─ 🖼  sector-allocation.png · 9 KB ────────────────┐ │   │
│  │  │           [inline image, click to zoom]            │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                        │   │
│  │  📎 3 attachments: report · chart · snapshot.csv       │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  [📎 file]  Ask Invester…                             [↵]    │
│  /help for commands · shift+enter for newline                │
└──────────────────────────────────────────────────────────────┘
```

Tool chips render inline above the assistant message — same affordance as Slack's `🔧 get_portfolio running... (2s)` chip, but compact once complete.

Embedded assets render where the agent's markdown links/images appear (HTML report iframe + inline chart in the mockup above). The attachment strip at the bottom of the bubble is populated from the `done.assets[]` SSE field — quick visual summary and a click-target for download.

While streaming:
- The assistant bubble renders live markdown from `delta.cumulative`. Asset references appear as placeholder cards ("📊 invester-report-…") until the `done` event arrives, then hydrate into full embeds.
- The active tool chip shows `🔧 portfolio_analyzer · 4s…` and ticks every heartbeat.
- The send button is replaced with a `■ stop` button that POSTs to `/api/chat/abort` → `agent.abort()`.
- The input is disabled.

### Build & serve

- `npm run web:dev` — Vite dev server on `:5173`, proxies `/api/*` to `:3001`. Matches the standard Vite layout.
- `npm run web:build` — outputs `dist/web/` static bundle.
- In production the express app serves `dist/web/` for non-API GETs (catch-all to `index.html` for client-side routing). One port, one process.

## 10. Auth flows

### Existing user (has `auth_token`)

1. Browser → `/login` → form posts `auth_token` (no username).
2. Server: `resolveByToken(token)` → `createSession(user)` → set `bindrive_session` cookie → redirect `/`.
3. All subsequent `/api/chat/*` calls carry the cookie.

### Admin

Same `/login` form, but with username + password → `authenticateAdmin(username, password)`. Session is `{type:'admin', slug:'admin'}`. Admin can hit `/api/admin/*` and can also `/api/chat/*` (admins bypass caps).

### Deep link from Slack/Telegram (Phase 2, but designed for now)

The agent in Slack can already produce a BinDrive view URL via `signedBinDriveViewUrl`. The same primitive gives us a chat deep link: a slash command like `/web` on Slack mints a link token bound to the user's slug and `pathPrefix: '/'`, posts `https://investor.lextok.com/?t=<token>` in the channel. The user clicks → `tryExchangeLinkToken` exchanges for a session cookie → they land in the WebUI already logged in. No new mint code needed; just a new slash command.

### New user via web invite redeem (Phase 1 — in scope)

The login page offers a "Redeem invite code" form: display name + `INV-XXXXXXXX`.

`POST /api/onboard/redeem`:

```json
{ "display_name": "Alice Chen", "code": "INV-1045661D" }
```

Server:

1. `validateInviteCode(code)` — fails fast if used / revoked / not found.
2. `redeemInviteInstantly({ code, displayName, web: true })` — uses the framework extension designed in §4.4. Creates `data/users/<slug>.yaml` with empty `telegram_user_ids`/`slack_user_ids`, marks the code used, returns `{ slug, displayName, authToken }`.
3. `createSession({type:'user', slug, displayName})` → set `bindrive_session` cookie.
4. Return `{ slug, redirect: '/' }`. The browser never sees the raw `auth_token` in the response body (it lives only in the YAML and the session).

If demo mode is on, the login page replaces the auth-token field with a single "Try the demo" button — display name only → same endpoint with `code: null` and the router calls `ensureChannelUser({ displayName, web: true, source: 'demo' })`.

**Failure modes (no fallback, all surfaced):**

| Condition | HTTP | Body |
|---|---|---|
| Code missing or malformed | 400 | `{ error: 'invalid_code' }` |
| Code already used / revoked | 409 | `{ error: 'code_not_redeemable', message }` |
| Display name empty / >60 chars | 400 | `{ error: 'invalid_display_name' }` |
| Slug collision (rare) | 409 | `{ error: 'slug_taken', message }` |
| Framework extension not yet shipped | 500 | `{ error: 'web_onboarding_disabled', message: '...' }` — server-side guard until §4.4 lands. |

## 11. Concurrency & lifecycle

- **One active run per channel per user** — enforced by checking `agent.state.isStreaming` on the **`web:<slug>`-keyed agent** before `agent.prompt()`. A web run and a Slack run for the same user can both be live without contending, because they are separate Agent instances in the pool.
- **Cross-channel queueing is out of scope.** If you're running a long analysis in Slack and switch to web, the web conversation starts fresh and is independent. (Today's Slack↔Telegram shared-key behavior means those two *do* contend; web does not join that.)
- **Queue or reject** — client picks. Default is reject (HTTP 409, client shows "still working…"). Setting `body.queue=true` calls `agent.steer(...)` instead.
- **Abort** — `POST /api/chat/abort` → `agent.abort()`. The SSE emits `done` with `stopReason: 'aborted'`. The stop button in the UI hits this.
- **Watchdog** — 10-min timeout reuses the Slack constant `AGENT_RUN_TIMEOUT_MS`. On timeout: `agent.abort()`, SSE emits `error` with `phase: 'watchdog'`.
- **Eviction** — the framework evicts idle agents after 24h. From the user's perspective the conversation resets; the UI shows "Session refreshed" on the next message. Domain state in `data/users/<slug>.yaml` is unaffected.
- **Process crash** — in-memory session map is lost. The client sees the SSE drop, gets `error: 'disconnected'`, and reopens with `Last-Event-ID`. The server has no buffered events (registry is gone) so it returns HTTP 404 + `{error: 'run_lost'}`. Client surfaces "Your last message was interrupted — please resend."

## 12. Security

- **Auth required on every route.** `requireAuth` middleware. Unauthenticated → 401 JSON for `/api/*`, redirect to `/login` for pages. Same rule as BinDrive today. Asset URLs (`/api/files/…`) inherit the same gate — the session cookie authenticates `<img>`/`<iframe>`/`<video>` requests automatically.
- **`auth_token` is a UUID, treated as a password.** Never logged, never returned by any GET. The `/api/admin/users/:slug` response strips it for everyone except admins viewing their own record (and even then, only if explicitly requested via `?include_token=true`).
- **`rehype-sanitize` on all rendered markdown.** LLM output is untrusted. Schema allows GFM plus a tightly-scoped `<iframe sandbox>` allowlist and `data-asset-*` attributes. Full rules in §8.7.
- **Asset embedding isolation.** Same-origin URL allowlist, owner-slug check, sandboxed iframes without `allow-top-navigation`, CSP `frame-src 'self'`. Details in §8.7.
- **CORS** — disabled by default. The SPA is same-origin. If we later want a separate frontend host, scope a strict allowlist.
- **CSRF** — session cookie is `SameSite=Lax`, which covers the form-POST cases. SSE GETs are not CSRF-sensitive (no side effect).
- **Rate limit** — `express-rate-limit` on `/api/chat/messages`: 30 messages per minute per session. Hard cap on `/login`: 5 per minute per IP. (Per hard rule #3, this is a safety guard, not optimisation.)
- **Admin escalation** — `requireAdmin` middleware. The session's `type` is set at login time from `authenticateAdmin`; there is no path that promotes a user session to admin via the chat API.
- **No new secrets in `.env`.** Reuses `WEBAPP_ADMIN_CREDENTIALALS`, `UTARUS_REPORTS_URL`, `SESSION_SECRET`, plus the new `WEBAPP_PUBLIC_BASE_URL` (canonical origin for self-referential links). Optional `WEBAPP_RATE_LIMIT_PER_MIN`.

## 13. Phased rollout

### Phase 1 — MVP (this design)

- **Framework changes (small, backward-compatible):**
  - `getOrCreateAgent(cacheKey, slug, isAdmin, opts)` — split cache key from tool slug. Framework wrapper accepts `channelScope: 'web'`.
  - `ensureChannelUser({ displayName, web: true, source, inviteCode? })` — web invite redeem without a chat platform id.
  - `getCap` / `attachUsageTracking` keyed by `slug`, not `cacheKey`, so usage caps stay per-user across channels.
  - `GET /api/files/:name/raw?slug=` — new endpoint serving the right `Content-Type` per extension (§8.8). Required for `<img>`/`<video>`/`<audio>` to render.
- **Domain changes (invage):**
  - `src/tools/channel.ts` — add `user_slug` to `channelIdParams` and a slug-resolution branch to `resolveInvestorFromChannel`.
- **Chat router:** `POST /messages`, `GET /stream/:id`, `POST /clear`, `GET /agent`, `POST /abort`. `done` event carries `assets[]` (§7.2, §8.6).
- **Onboard:** `POST /api/onboard/redeem` (web invite redeem, demo-mode aware).
- **Admin REST:** invites, admincodes, demomode, users.
- **React SPA:** chat page + login + admin invites/users. Asset-aware renderer: `remark-bindrive-assets` plugin + `AssetLink`/`AssetImage`/`SandboxedIframe` components (§8.5). Inline embeds for HTML reports, images, CSV, JSON, PDF, text.
- **Auth:** `auth_token` login for existing users; web invite redeem for new users; admin password for admins.
- **Slash command on Slack/Telegram:** `/mytoken` DMs the user their `auth_token` so they can paste it into the web login. (For users who already exist on a chat platform.)

### Phase 2

- `/web` slash command on Slack/Telegram that mints a link token and posts the WebUI URL — the click-through flow already designed in §10.
- Persisted chat history (`data/chat_history/<slug>.jsonl`).
- File upload from composer (§8.9) — paperclip button, drop file, auto-insert markdown link, agent can read via `bindrive_read_file`.
- `<video>` / `<audio>` embeds (the rendering pipeline supports them in Phase 1; this Phase-2 line covers user uploads and any future agent tool that produces media).
- External link unfurl cards (OpenGraph preview for `https://` links the agent writes inline).
- Admin `/link` to merge a chat-platform id into an existing web user's YAML.

### Phase 3 (called out, not designed)

- Per-channel formatting in the framework system prompt (the architectural clean-up in §8.1).
- Agent-authored charts: a `save_chart` tool that takes Vega-Lite or Plotly spec and renders PNG/SVG to BinDrive. The renderer already handles images Phase 1; the gap is the tool that produces them.
- Voice input.
- Pinned messages / threads.

## 14. Open questions

1. **Should `/mytoken` be admin-only, or should every user be able to retrieve their `auth_token` from Slack/Telegram?** Default proposal: every user can retrieve their own. It's their token. Admins can revoke via a new `/resettoken <slug>` command.
2. **History on page refresh.** Until Phase 2's persistence lands, refreshing the page *during* an active run resumes the SSE; refreshing *after* the run completes loses the rendered answer. Acceptable for v1?
3. **Should we ship a single bundled `index.html` (no Vite) for Phase 1 to avoid the build step?** Default proposal: no — the React/Tailwind toolchain is already standardised in the monorepo and the build is one command. Avoids hand-rolling a markdown renderer.
4. **Should we also isolate Slack from Telegram?** Today those two share the same `<slug>`-keyed conversation for a linked user. The framework change in §4.2 makes that a one-line switch per channel (`channelScope: 'slack'` / `'telegram'`). Out of scope here, but worth flagging — the answer affects whether `/clear` on Slack also clears Telegram.
5. **Sandbox policy for HTML reports.** §8.7 grants `allow-scripts allow-same-origin` so charts render. The combination technically permits the iframe to escape its own origin in legacy browsers; modern browsers sandbox it correctly. Acceptable, or do we want `allow-scripts` only (which forces a unique origin and breaks same-origin resource loads)?
6. **Should the agent be told the channel accepts assets?** The Phase-1 channel hint (§8.1) says "write standard markdown links/images using the URLs your tools returned". Should it also nudge toward producing more visual answers (charts, reports) on web, since the rendering can handle them? Risk: over-tuning the agent's style per channel.

## 15. File layout (proposed, for the implementation PR)

```
src/
  webapp/
    server.ts                 # extended: builds framework + boots express with chat routes
    chat/
      router.ts               # POST /messages, GET /stream/:id, POST /clear, etc.
      stream-registry.ts      # in-memory Map<messageId, StreamSession>
      run-agent.ts            # extracted from slack/app.ts getAgentResponse, shared
      admin-router.ts         # /api/admin/*
      sse.ts                  # SSE helpers (write-event, framing, Last-Event-ID replay)
      extract-assets.ts       # regex-scan final text → done.assets[] (§8.6)
    views/
      chat.ts                 # (only if we ship SSR shell; otherwise static dist/web/index.html)
web/                          # NEW — Vite project root
  index.html
  src/
    main.tsx
    App.tsx
    pages/{Chat,Login,Admin}*.tsx
    components/
      Message.tsx
      ToolChip.tsx
      Composer.tsx
      assets/
        AssetLink.tsx         # decides embed-vs-link by data-asset-kind (§8.5)
        AssetImage.tsx        # inline img + lightbox
        SandboxedIframe.tsx   # HTML report / PDF embed
        CsvTable.tsx          # fetch + parse CSV → table
        AttachmentStrip.tsx   # done.assets[] summary row
    lib/
      sse.ts
      api.ts
      markdown.ts             # configures react-markdown pipeline
      remark-bindrive-assets.ts  # custom remark plugin (§8.5)
  tailwind.config.ts
  vite.config.ts
docs/
  webui-chat-design.md        # this file
```

`run-agent.ts` is the headline extraction: today `getAgentResponse()` lives inside `interfaces/slack/app.ts`. Pulling it into a shared module lets Slack, Telegram, and WebUI all subscribe to the same event stream with the same watchdog/cap/abort semantics. The Slack interface is refactored to import it; behavior is unchanged.

---

*Source: [github.com/Judeqiu/invage](https://github.com/Judeqiu/invage) · verified against `utarus@79fdca24`.*
