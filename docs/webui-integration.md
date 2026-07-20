# WebUI Integration Guide

How a **domain agent** enables the Utarus browser chat (Claude-style multi-chat, BinDrive, login, admin).

**Audience:** engineers wiring Binary, Marie, Invage, or a new vertical.  
**Status:** shipped in Utarus ≥ **0.3.0** (SPA + chat APIs live in the framework package).  
**Related:** [integration-guide.md](integration-guide.md) · [onboarding-integration.md](onboarding-integration.md) · [webui-chat-design.md](webui-chat-design.md) (architecture detail) · [webui-chat-widgets.md](webui-chat-widgets.md) (side-panel widgets)

---

## 1. What the framework owns vs the domain

| Layer | Owner | Notes |
|---|---|---|
| React SPA (`web/`) | **Utarus** | Chat UI, sidebar, login, admin console |
| `POST /api/chat/*` SSE chat | **Utarus** | Messages, stream, clear, abort, conversations |
| `GET/POST /api/admin/*` | **Utarus** | Invites, demo mode, user list |
| `POST /api/onboard/login` · `/redeem` · `/demo` · password | **Utarus** | Web auth + invite redeem |
| BinDrive `/api/files/*` | **Utarus** | Per-user file portal |
| Agent pool + cache keys | **Utarus** | `web:<slug>:<conversationId>` |
| Conversation files | **Utarus** | `data/chats/<slug>/…` |
| `enrichMessage` content | **Domain** | Prepended for the *agent only* — never shown in the user bubble |
| Slash commands (`/clear`, `/help`) | **Utarus SPA** | Client-side |
| `/usage` | **Utarus** | Server intercept on `POST /messages`; no LLM |
| Domain `webCommands` (`/name …`) | **Domain** | Server intercept on `POST /messages`; no LLM |
| Landing `POST /api/onboard/register` (QR → BIND) | **Domain (optional)** | Mount via `extraRouters` |
| Domain tools / skills / purpose | **Domain** | Unchanged by WebUI |

**Rule:** Do not copy the SPA or chat routers into your domain repo. Depend on a pinned Utarus commit that includes `web/dist` and call `framework.startWebApp()`.

---

## 2. Minimal domain boot

```ts
// domain agent: src/index.ts
import { config as dotenvConfig } from 'dotenv';
dotenvConfig();
process.env.UTARUS_LOADED_BY_HOST = '1';  // prevent utarus from loading its own .env

import { createFramework } from 'utarus';
import { myExtension } from './extension.js';

const framework = createFramework({ extension: myExtension });

// WebUI — must run in the SAME process as the agent pool
if (process.env.WEBAPP_PORT) {
  const port = parseInt(process.env.WEBAPP_PORT, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`WEBAPP_PORT must be a positive integer, got "${process.env.WEBAPP_PORT}"`);
  }
  framework.startWebApp({
    port,
    // Optional: domain-only routes (same path may stack with framework onboard)
    // extraRouters: [{ path: '/api/onboard', router: myLandingRegisterRouter }],
  });
}

// Other channels as needed
if (process.env.TELEGRAM_BOT_TOKEN) void framework.startTelegram();
if (process.env.SLACK_BOT_TOKEN) void framework.startSlack();
```

### Env (host `.env`)

```env
UTARUS_LOADED_BY_HOST=1
UTARUS_AGENT_NAME=My Agent
UTARUS_AGENT_PURPOSE=…
DEEPSEEK_API_KEY=…
UTARUS_DATA_ROOT=/absolute/path/to/data   # prefer absolute path

WEBAPP_PORT=3002
SESSION_SECRET=change-me
WEBAPP_ADMIN_CREDENTIALS={"admin":"change-me"}

# Public origin used when tools mint signed BinDrive links
UTARUS_REPORTS_URL=https://chat.example.com
```

### Process layout (production tip)

| Process | Role | Port |
|---|---|---|
| Agent unit (`BOT_ONLY=true` + `WEBAPP_PORT`) | Telegram/Slack **and** full WebUI chat | e.g. **3002** |
| Optional drive unit | BinDrive + domain landing only (no chat pool) | e.g. **3001** with `WEBAPP_PORT=3001` forced in the unit file |

Chat **requires** the agent process: SSE runs against the in-memory agent pool. Do not put chat on a drive-only process.

Caddy example:

```caddy
chat.example.com {
  reverse_proxy localhost:3002
}
```

---

## 3. Conversation data model (server)

Persisted under `UTARUS_DATA_ROOT`:

```
data/chats/<slug>/
  index.json                 # ConversationSummary[] (newest first)
  <conversationId>.json      # Conversation + messages[]
```

### Types (conceptual)

```ts
interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;    // ISO
  updated_at: string;
  message_count: number;
  preview: string;
}

interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;          // user-visible only (never enrichMessage dump)
  created_at: string;
  stopReason?: string;
  error?: string;
}

interface Conversation {
  id: string;
  slug: string;
  title: string;
  title_source?: 'auto' | 'ai' | 'user';
  created_at: string;
  updated_at: string;
  messages: StoredChatMessage[];
}
```

### Agent cache keys

| Scope | Cache key |
|---|---|
| Slack / Telegram (linked) | `<slug>` |
| Web (legacy single) | `web:<slug>` |
| Web multi-chat | `web:<slug>:<conversationId>` |

Switching chats loads different agent transcripts. Profile / portfolio / tools still key off `slug`.

### Titles

1. First user message → temporary **auto** title (truncated).  
2. After first successful assistant reply → **AI** title (3–7 words via DeepSeek `completeSimple`).  
3. User rename → **user** (never overwritten by AI).  

Browser tab: `{title} · {UTARUS_AGENT_NAME}` (or `{name} · Chat` when empty).

---

## 4. HTTP API surface (framework)

All routes except login/redeem/demo require `bindrive_session` (or Bearer auth).

### Auth / onboard

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/onboard/demo` | `{ enabled, agentName, version }` — no auth |
| `POST` | `/api/onboard/login` | `{ auth_token }` **or** `{ identifier, password }` → session cookie |
| `POST` | `/api/onboard/redeem` | `{ display_name, code? }` invite/demo onboard |
| `POST` | `/api/onboard/profile/password` | Change password (auth) |

### Conversations

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/chat/conversations` | List |
| `POST` | `/api/chat/conversations` | Create `{ title? }` |
| `GET` | `/api/chat/conversations/:id` | Full messages (+ hydrate agent) |
| `PATCH` | `/api/chat/conversations/:id` | Rename `{ title }` |
| `DELETE` | `/api/chat/conversations/:id` | Delete chat + agent cache |

### Messaging

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/chat/messages` | `{ text, conversationId?, queue? }` → `{ kind, messageId, conversationId }` |
| `GET` | `/api/chat/stream/:messageId` | SSE: `ack` · `delta` · `tool_*` · `done` · `title` · `end` |
| `POST` | `/api/chat/clear` | `{ conversationId }` clear messages in one chat |
| `POST` | `/api/chat/abort` | `{ conversationId? }` |
| `GET` | `/api/chat/agent` | Status + `version` |
| `GET` | `/api/chat/commands` | Framework + domain slash-command catalog for `/help` |

If `conversationId` is omitted on the first message, the server creates a conversation.

### Domain slash commands (`webCommands`)

Same idea as Telegram/Slack domain commands: register on the extension, users type `/name args` in the composer, the framework replies without the LLM.

```ts
// domain extension
webCommands: [
  {
    name: 'status',
    description: 'Show domain status for this user',
    adminOnly: false,
    handler: async ({ userSlug }) => {
      const state = resolveUserBySlug(userSlug);
      if (!state) return 'No profile linked.';
      return `Slug: ${state.user.slug}`;
    },
  },
],
```

| Piece | Behavior |
|---|---|
| Trigger | Type **`/`** in the composer — Slack-style menu lists framework + domain commands; filter as you type; ↑/↓ + Enter or click to pick |
| Match | Sent message must be `/name` or `/name args` only (whole message) |
| Reply | `POST /messages` → `{ kind: 'reply', text }` (SPA shows it as an assistant bubble) |
| Admin | `adminOnly: true` → non-admins get `⛔ Admin only.` |
| Reserved | `clear`, `help` — SPA-owned; do not register |
| Help UI | `/help` loads `GET /api/chat/commands` (hides admin-only entries for non-admins) |

See [integration-guide.md §5.4](integration-guide.md).

### Critical: display text vs agent prompt

```
User types:  "Study undervalued tech companies"
     │
     ├─► Stored in conversation JSON / shown in blue bubble
     │      = original text only
     │
     └─► Sent to agent
            = WEB channel hint
            + domain enrichMessage(...)
            + original text
```

**Never** put enrichMessage output into `appendMessage` for the user role. Utarus already stores the raw user text; domains must not reintroduce context into stored turns.

---

## 5. Domain `enrichMessage` for web

Web has **no** Telegram/Slack user id. The gate passes `userSlug` from the session. Your enrich hook **must** resolve by slug or the agent will re-onboard.

```ts
// domain extension — required web branch
async enrichMessage(ctx: EnrichMessageContext): Promise<string> {
  let state = null;
  if (ctx.telegramUserId != null) {
    state = resolveUserByTelegramUser(ctx.telegramUserId);
  } else if (ctx.slackUserId) {
    state = resolveUserBySlackUser(ctx.slackUserId);
  } else if (ctx.userSlug) {
    state = resolveUserBySlug(ctx.userSlug);   // ← WebUI
  }

  if (!state) return ctx.text;

  // Prefix is for the model only. Return `${prefix}\n\n${ctx.text}`.
  return `${domainContextPrefix(state)}\n\n${ctx.text}`;
}
```

Checklist:

- [ ] Handle `userSlug` for web  
- [ ] Prefix + blank line + **original** `ctx.text` (do not drop user text)  
- [ ] Tools still accept channel ids **or** slug so web-created sessions work  

---

## 6. Optional domain routes (`extraRouters`)

```ts
framework.startWebApp({
  port,
  extraRouters: [
    // Landing page QR → BIND token (Invage pattern)
    { path: '/api/onboard', router: landingRegisterRouter },
  ],
});
```

Framework already mounts `/api/onboard` for login/redeem/demo. Express stacks routers on the same path — your `POST /register` coexists with framework `POST /login`.

Standalone BinDrive without chat (optional second process):

```ts
import { createBinDriveApp } from 'utarus';
const app = createBinDriveApp();
app.use('/api/onboard', landingRegisterRouter);
app.listen(3001);
```

---

## 7. Markdown / math (domain replies)

| Do | Don't |
|---|---|
| Use GFM tables, lists, fenced code | Rely on Slack/Telegram table flattening for web |
| Currency as `$1.2M` or `**$1.2M**` | Wrap prose in `$…$` (KaTeX will eat spaces) |
| Real equations as `$$…$$` | Nested broken `**` markup |

SPA config: `remark-math` with `singleDollarTextMath: false`.

---

## 8. Auth surfaces (shared)

| Method | Body | Notes |
|---|---|---|
| Password | `{ identifier, password }` | slug **or** contact_email |
| Token | `{ auth_token }` | legacy / deep links |
| Redeem | `{ display_name, code }` | `INV-…`; demo mode allows `code: null` |

Session cookie: `bindrive_session` (httpOnly). Admin REST uses `WEBAPP_ADMIN_CREDENTIALS` sessions.

Never serialize `auth_token` or `password_hash` to the browser.

---

## 9. Side-panel widgets (optional domain UI)

Interactive panel apps (3D floor plans, calculators, galleries) are a **platform** capability. Domains register kinds on `DomainWebUiExtension.widgets`, ship classic **IIFE** bundles under `staticDir`, and teach the model to call `show_widget` / `update_widget` / `read_widget_state`.

Durable instance state is **user-owned** BinDrive storage (`data/drive/<slug>/_utarus/widgets/…`). User “Save” in the panel also emits a chat card.

Full integration guide: **[webui-chat-widgets.md](webui-chat-widgets.md)**  
Design: [webui-chat-widgets-design.md](webui-chat-widgets-design.md)  
Demo: `examples/demo` (`floor-plan-3d`)

Maps (inline Google Embed) remain separate — see [webui-chat-maps-design.md](webui-chat-maps-design.md).

---

## 10. Pinning Utarus

```json
{
  "dependencies": {
    "utarus": "github:YOUR_ORG/utarus#<commit-with-web-dist>"
  }
}
```

The package ships `web/dist` (SPA) and `src/webapp/chat/*`. After `npm install`, confirm:

```bash
ls node_modules/utarus/web/dist/index.html
ls node_modules/utarus/dist/webapp/chat/
```

If `web/dist` is missing, the SPA is broken (API-only mode). Use a commit that includes built assets (see Utarus `package.json` `files` + committed `web/dist`).

---

## 10. Smoke checklist for a new domain

1. `WEBAPP_PORT` set; process logs `[…/Web] listening on http://localhost:…`  
2. `GET /health` → `{ status: "ok", version: "…" }`  
3. `GET /api/onboard/demo` → `{ agentName, version, enabled }`  
4. Login with token or password → cookie set  
5. `POST /api/chat/messages` with text → `kind: "run"` + `conversationId`  
6. SSE stream completes; `GET /api/chat/conversations/:id` shows **clean** user text only  
7. Refresh browser → sidebar + messages restored  
8. First reply → sidebar/tab title becomes an AI summary  
9. Domain tools work with web sessions (slug resolution)  
10. No re-onboarding on web after login  

---

## 11. Invage reference (one domain)

| Piece | Location |
|---|---|
| Boot WebUI | `invage/src/index.ts` → `framework.startWebApp({ extraRouters })` |
| Extension + web enrich | `invage/src/extension.ts` |
| Landing register only | `invage/src/onboard/api.ts` mounted as `extraRouters` |
| Thin webapp re-export | `invage/src/webapp/server.ts` (optional standalone drive) |
| E2E against prod | `invage/tests/webui-e2e.mjs` |

Invage does **not** ship a SPA or chat router — those come from Utarus.

---

## 12. Public exports (TypeScript)

```ts
import {
  createFramework,
  buildWebApp,
  startWebApp,
  createBinDriveApp,
  // auth
  authenticateUser,
  resolveByToken,
  createSession,
  hashPassword,
  // state
  loadState,
  saveState,
  resolveUserBySlug,
  // conversations (optional direct use / tests)
  listConversations,
  createConversation,
  getConversation,
  UTARUS_VERSION,
} from 'utarus';
```

Prefer `framework.startWebApp()` over hand-mounting routers unless you need a custom Express host.
