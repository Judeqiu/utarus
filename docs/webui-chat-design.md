---
layout: default
title: WebUI Chat — Architecture
---

# WebUI Chat — Architecture

**Status: shipped** (Utarus ≥ 0.3.x). This document is the architecture reference.

**For domain agent authors:** start with **[webui-integration.md](webui-integration.md)** — boot sequence, env, data model, enrich rules, and smoke checklist.

---

## Goals (met)

1. Browser channel alongside Telegram/Slack, **isolated conversation** (`web:<slug>:<conversationId>`).
2. Token streaming (SSE), tool chips, errors surface.
3. First-class GFM (tables, code); currency `$` does not trigger KaTeX (`singleDollarTextMath: false`).
4. Same Framework / agent pool / invite gate / BinDrive auth.
5. One process for chat + agents (`framework.startWebApp`).
6. **Persisted multi-chat** (Claude-style list + titles).

---

## Layout in the monorepo

| Path | Role |
|---|---|
| `src/webapp/server.ts` | `buildWebApp` / `startWebApp` / BinDrive shell |
| `src/webapp/chat/router.ts` | REST + SSE |
| `src/webapp/chat/conversation-store.ts` | `data/chats/<slug>/` |
| `src/webapp/chat/title-chat.ts` | AI title via `completeSimple` |
| `src/webapp/chat/onboard.ts` | login / redeem / demo / password |
| `src/webapp/chat/admin-router.ts` | invites, demo mode, users |
| `web/` | Vite React SPA |

Domains depend on the package; they do **not** vendor this tree.

---

## Data model

### User YAML (shared, not chat history)

`data/users/<slug>.yaml` — profile, domain state (`portfolio`, …), `auth_token`, `password_hash`. Unchanged by multi-chat.

### Conversations (web only)

```
data/chats/<slug>/
  index.json
  <conversationId>.json
```

See [webui-integration.md §3](webui-integration.md).

### Agent cache keys

| Channel | Key |
|---|---|
| Slack/Telegram linked | `<slug>` |
| Web conversation | `web:<slug>:<conversationId>` |

---

## Message path (web)

```
Browser Composer
    │  text (user-visible)
    │  client intercept: /clear, /help
    ▼
POST /api/chat/messages  { text, conversationId? }
    │
    ├─ Domain webCommands match (/name args)?
    │     yes → { kind: 'reply', text }  (no LLM)
    │
    ├─ resolveInboundMessage + domain enrichMessage  → agentPrompt
    ├─ appendMessage(…, text)                        → disk (clean)
    └─ agent.prompt(channelHint + agentPrompt)
           │
           ▼
       SSE /stream/:messageId
           ack → delta* → tool_* → done → title? → end
           │
           └─ appendMessage(assistant)
           └─ maybe AI title (title_source=ai)
```

Domain agents register extra commands via `DomainExtension.webCommands`. Catalog: `GET /api/chat/commands` (see [webui-integration.md](webui-integration.md), [integration-guide.md §5.4](integration-guide.md)).

**Invariant:** user bubbles and `StoredChatMessage` for role `user` never contain enrichMessage dumps. Legacy rows are stripped in `getConversationForClient`.

---

## API summary

See [webui-integration.md §4](webui-integration.md).

SSE event types: `ack`, `tool_start`, `tool_end`, `delta`, `heartbeat`, `done`, `error`, `cap`, **`title`**, `end`.

---

## SPA behaviour

- Sidebar: list / new / delete / select.
- Active conversation id in `localStorage` (`utarus_active_conversation`).
- Tab title: `{chatTitle} · {agentName}` after AI title; else `{agentName} · Chat`.
- Composer stays focused after send (not `disabled` during stream).
- Login: password, auth token, invite redeem; demo mode optional.

---

## Domain hooks

| Hook | Web requirement |
|---|---|
| `enrichMessage` | Must resolve **`userSlug`** (no tg/slack id on web) |
| `tools` | Accept slug and/or channel ids so web sessions work |
| `extraRouters` | Optional landing register only |

---

## Math / markdown

- GFM via `remark-gfm`.
- Math: `$$…$$` only (`singleDollarTextMath: false`) so `$1.675T` stays currency.
- Domain system prompts should say the same for the web channel hint.

---

## Historical note

Early design called multi-chat “Phase 2” and assumed the SPA might live in each domain. Both are obsolete: multi-chat and the SPA ship **inside Utarus**; domains only call `startWebApp` and optionally mount landing routes.
