# Utarus — A Generic Agent Framework

Utarus is a small TypeScript framework for building LLM agents that have **per-user state**, **admin-controlled onboarding**, and **tool-enforced rules**. It is the generic distillation of a production agent codebase — everything domain-specific has been stripped, leaving a clean skeleton you can fork into any vertical.

Built on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core). Same skeleton as [Marie](https://judeqiu.github.io/marie/) and [Binary](https://github.com/Judeqiu/binary) — different domain.

> **Documentation site:** see `docs/index.html` or the published GitHub Pages link in the repo description.

---

## What you get out of the box

- **CLI + Telegram + Slack + WebUI chat** interfaces that share a per-user agent pool (24h TTL eviction, 100-agent cap). WebUI: Claude-style multi-chat (server-persisted), SSE streaming, GFM, AI chat titles; currency `$` is not KaTeX.
- **BinDrive** file portal + signed view URLs, shared with chat.
- **Per-user YAML state** at `data/users/<slug>.yaml`. Chat history at `data/chats/<slug>/`.
- **Instant invite onboarding** (`INV-XXXXXXXX`) — admins issue codes; recipients paste the code and get a profile immediately. See [docs/onboarding-integration.md](docs/onboarding-integration.md).
- **Domain agent integration** — `DomainExtension` + `framework.startWebApp()`. Start with [docs/webui-integration.md](docs/webui-integration.md) and [docs/integration-guide.md](docs/integration-guide.md). Sample domain: [Invage](https://github.com/Judeqiu/invage).
- **Demo mode** (`/demomode on|off`) — admin-only open access; auto-create profiles for anyone who chats. Same doc as above.
- **Admin onboard codes** (`ADM-XXXXXXXX`) — admins can grant admin rights to other Telegram/Slack users at runtime.
- **Skill framework** — markdown knowledge docs the agent loads on demand via `use_skill`.
- **Usage tracking + caps** — every agent turn records LLM tokens/cost and tool calls per user (monthly + lifetime) at `data/usage/<slug>.yaml`; optional per-user caps via `data/config/caps.yaml` are enforced on all chat interfaces.
- **WebUI domain slash commands** — type `/` for a Slack-style menu; register `webCommands` on `DomainExtension`; `/name args` is handled without the LLM.
- **TypeBox-schematized tools** — every tool parameter is validated by the runtime before your code runs.
- **Dynamic admin list** — file-backed, no restart needed when new admins are granted.
- **User reporting** — users say “report …” in chat; text is appended to global `data/reporting.yaml`. Admins review via `list_reports`, WebUI Admin → Reports, or the file itself.
- **Telegram UX (built into the interface — every domain agent inherits it):**
  - Ack reaction (`👀`) on inbound messages
  - `typing…` chat action while the agent works (immediate + refresh every 4s)
  - Forum/topic groups: passes `message_thread_id` so typing shows under the title
  - Markdown → Telegram HTML replies (`**bold**`, lists, links, code, tables→bullets)
  - Safe chunking + plain-text fallback if Telegram rejects markup

## What you have to add

- **Your domain tools.** The framework ships user-management primitives (init, get, list, link telegram, update profile) and invite/admin tools. Anything past that — phase machines, metrics, scrapers, integrations — goes in `src/tools/`.
- **Your skills.** Drop a markdown file in `src/skills/knowledge/` and register it in `src/skills/registry.ts`.
- **Your system-prompt purpose.** Set `UTARUS_AGENT_NAME` and `UTARUS_AGENT_PURPOSE` in `.env`.

---

## Prerequisites

- **Node.js 20+** and npm
- An **LLM API key** — DeepSeek is the default provider. Get one at https://platform.deepseek.com → API Keys. Kimi or any OpenAI-compatible endpoint works too — see [LLM providers](#llm-providers).
- A **Telegram bot token** — optional, only if you want the Telegram interface. Talk to [@BotFather](https://t.me/BotFather), run `/newbot`, copy the token.
- A **Slack app** — optional, only if you want the Slack interface. Create one at https://api.slack.com/apps, enable Socket Mode, and add Bot Token Scopes: `chat:write`, `commands`, `im:write`.

## Install

```bash
git clone <your-fork-url>/utarus.git
cd utarus
npm install
cp .env.example .env
```

Edit `.env` and fill in the values:

```env
# Required — the agent will not start without these
DEEPSEEK_API_KEY=sk-...
# (or swap providers: UTARUS_LLM_PROVIDER=kimi + KIMI_API_KEY=... — see LLM providers)
UTARUS_AGENT_NAME=Acme Support Bot
UTARUS_AGENT_PURPOSE=You are the support bot for Acme Corp. Help users file tickets, check order status, and answer FAQ. Decline anything off-scope.

# Required for Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_IDS=123456789

# Required for Slack
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_ADMIN_IDS=

# Optional — defaults to ./data
UTARUS_DATA_ROOT=./data
```

The `.env` file is gitignored. **Never commit it.**

## LLM providers

DeepSeek is the default. Switch providers via env — no code changes, no fork:

| `UTARUS_LLM_PROVIDER` | Required env | Default model / base URL |
|---|---|---|
| `deepseek` (default) | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` @ `https://api.deepseek.com` |
| `kimi` | `KIMI_API_KEY` | `k3` @ `https://api.kimi.com/coding/v1` |
| `generic` | `UTARUS_LLM_MODEL` + `UTARUS_LLM_BASE_URL` + `UTARUS_LLM_API_KEY` | none — all three required |

`UTARUS_LLM_MODEL` / `UTARUS_LLM_BASE_URL` override the defaults of the well-known providers; `UTARUS_LLM_API_KEY_ENV` renames the api-key env var. Missing values fail fast at boot with the exact variable named. Domain code can read the resolved model/key via `getAgentModel()` / `getAgentApiKey()` / `getAgentLLM()`, exported from the package root.

## Run

```bash
npm run dev          # tsx — CLI (+ bots if tokens set)
npm run build        # tsc + WebUI SPA (web/dist)
```

### WebUI chat (domain agents)

**Full guide:** [docs/webui-integration.md](docs/webui-integration.md).

Set `WEBAPP_PORT` and call from the **same process as the agent pool**:

```ts
const framework = createFramework({ extension: myExtension });

if (process.env.WEBAPP_PORT) {
  framework.startWebApp({
    port: parseInt(process.env.WEBAPP_PORT, 10),
    // Optional domain-only routes (e.g. landing-page register):
    // extraRouters: [{ path: '/api/onboard', router: myLandingRouter }],
  });
}
```

SPA is shipped in the package (`web/dist`). Branding = `UTARUS_AGENT_NAME`. Conversations persist under `data/chats/<slug>/`. Domain `enrichMessage` must handle `userSlug` for web (do not store enrich text as the user message).

On startup you'll see:

```
Acme Support Bot starting...
Initializing LLM (provider=deepseek)...
LLM ready: provider=deepseek model=deepseek-v4-pro baseUrl=https://api.deepseek.com
TELEGRAM_BOT_TOKEN not set — Telegram interface disabled.
Slack tokens not set — Slack interface disabled.
Acme Support Bot running. Type /help for commands.

acme-support-bot>
```

If `TELEGRAM_BOT_TOKEN` is set, the Telegram bot starts in parallel with the CLI. If Slack tokens are set, the Slack bot starts as well. All interfaces share the same per-user agent pool.

---

## CLI command reference

| Command | What it does |
|---|---|
| `/help` | Show command list |
| `/list` | List all users |
| `/get <slug>` | Print session announcement for one user |
| `/clear` | Clear the current agent's conversation context |
| `/exit` | Quit |

Slash commands bypass the LLM for speed. Anything else is sent to the agent as a prompt.

## Telegram commands

| Command | What it does |
|---|---|
| `/start` `/help` | Show help |
| `/list` | List all users (admin only) |
| `/get <slug>` | Show user record (admin only) |
| `/clear` | Clear your conversation context |
| `/usage` | Show your LLM + tool usage (monthly + lifetime) |
| `/invite [comment]` | Issue invite code (admin only) |
| `/invites [all\|unused\|used]` | List invite codes (admin only) |
| `/admincode [comment]` | Issue admin onboard code (admin only) |
| `/admincodes [all\|unused\|used]` | List admin onboard codes (admin only) |
| `/revoke <code>` | Revoke unused admin code (admin only) |

Each Telegram user gets an isolated conversation context (keyed by `tg_<userId>`).

### Telegram UX (shared by all domain agents)

These behaviors live in Utarus (`src/interfaces/telegram.ts` + `telegram-format.ts`), not in Binary/Marie/etc. Any agent that calls `framework.startTelegram()` gets them automatically:

| Capability | Behavior |
|---|---|
| Ack reaction | `setMessageReaction` with `👀` when a message is accepted |
| Typing status | `sendChatAction(typing)` immediately, then every 4s until the reply is sent |
| Forum topics | Forwards `message_thread_id` so the header shows typing (not just “N members”) |
| Formatted replies | Agent Markdown is converted to Telegram HTML (`parse_mode: HTML`) |
| Tables | GFM pipe tables are flattened to `• Key: value · …` bullets |
| Chunking | Long replies split under Telegram’s 4096 limit without mid-tag cuts |
| Fallback | If HTML is rejected, the same content is re-sent as plain text |

Helpers are also exported for custom outbound messages:

```ts
import {
  markdownToTelegramHtml,
  splitTelegramHtml,
  convertMarkdownTables,
  escapeHtml,
} from 'utarus';

const html = markdownToTelegramHtml(agentText);
for (const chunk of splitTelegramHtml(html)) {
  await ctx.reply(chunk, { parse_mode: 'HTML' });
}
```

Domain prompts may still guide *what* the model writes (prefer bullets over wide tables), but **rendering** is a framework concern.

## Slack commands

| Command | What it does |
|---|---|
| `/help` | Show help |
| `/list` | List all users (admin only) |
| `/get <slug>` | Show user record (admin only) |
| `/clear` | Clear your conversation context |
| `/usage` | Show your LLM + tool usage (monthly + lifetime) |
| `/invite [comment]` | Issue invite code (admin only) |
| `/invites [all\|unused\|used]` | List invite codes (admin only) |
| `/admincode [comment]` | Issue admin onboard code (admin only) |
| `/admincodes [all\|unused\|used]` | List admin onboard codes (admin only) |
| `/revoke <code>` | Revoke unused admin code (admin only) |

Each Slack user gets an isolated conversation context (keyed by `slack_<userId>`).

---

## Architecture

Five layers, top to bottom:

```
┌─────────────────────────────────────────────────────────┐
│ Interface — CLI (readline) + Telegram (telegraf) + Slack│
│   Per-user agent key: cli_session | tg_<userId> |       │
│   slack_<userId> | slack_channel_<channelId>            │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│ Agent — src/agent.ts                                    │
│   One pi-agent-core Agent per user (24h TTL, cap 100)   │
│   System prompt composed from UTARUS_AGENT_NAME/PURPOSE │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│ Skills — src/skills/                                    │
│   Markdown knowledge docs loaded on demand via use_skill│
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│ Tools — src/tools/                                      │
│   TypeBox-schematized. Hard rules live here as code.    │
│   The LLM cannot bypass what the tool refuses.          │
└─────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────────────────────────────────────┐
│ Persistence — src/state/                                │
│   YAML per user at data/users/<slug>.yaml               │
│   + invites.yaml, admin_codes.yaml, admin_ids.yaml     │
└─────────────────────────────────────────────────────────┘
```

The full reference is on the documentation site.

---

## Extending the framework

### Add a tool

1. Create `src/tools/my-tool.ts`:

```typescript
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export function createMyTool(): AgentTool {
  return {
    name: 'my_tool',
    label: 'My Tool',
    description: 'What this tool does, in one paragraph.',
    parameters: Type.Object({
      foo: Type.String({ description: 'What foo means.' }),
    }),
    async execute(_id, raw) {
      const { foo } = raw as { foo: string };
      return {
        content: [{ type: 'text', text: `Did the thing with ${foo}.` }],
        details: { foo },
      };
    },
  };
}
```

2. Register it in `src/agent.ts`:

```typescript
function frameworkTools(): AgentTool[] {
  const skillTool = createSkillTool();
  const userTools = createUserStateTools();
  const inviteTools = createInviteTools();
  const myTool = createMyTool();   // <-- add
  return [skillTool, ...userTools, ...inviteTools, myTool];
}
```

That's it. The tool's TypeBox schema is the validation contract — the LLM cannot call it with bad parameters.

### Add a skill

1. Write `src/skills/knowledge/my-skill.md`.
2. Register it in `src/skills/registry.ts`:

```typescript
export const SKILLS: readonly Skill[] = [
  // ...
  {
    id: 'my-skill',
    name: 'My Skill',
    description: 'Load when ... <be specific — the LLM picks the skill from this description alone>',
    kind: 'knowledge',
    keywords: ['my', 'skill', 'keywords'],
  },
];
```

The agent will start offering the skill via `use_skill` automatically.

### Extend the user state

The framework reserves `user.{id,slug,created_at,telegram_user_ids,slack_user_ids,auth_token}`, `profile.{display_name,contact_email}`, and `log[]`. Add anything else under `profile` or as a new top-level key — the load/save machinery only enforces the load-bearing shape:

```yaml
user:
  id: ...
  slug: acme-trading
  created_at: 2026-06-27
  telegram_user_ids: [123456]
  slack_user_ids: [U01ABCDEF]
  auth_token: ...
profile:
  display_name: Acme Trading
  contact_email: ops@acme.sg
  # ↓ your domain fields
  tier: pro
  plan_expires: 2026-12-31
  custom_data:
    anything: goes
log:
  - ts: 2026-06-27
    action: created
```

Write a domain-specific `update_my_fields` tool to mutate these — don't shoehorn them into `update_profile`.

---

## Where state lives

```
data/
├── users/
│   └── <slug>.yaml       # one YAML per user
├── invites.yaml          # invite codes
├── admin_codes.yaml      # admin onboard codes
├── admin_ids.yaml        # dynamically-granted admin Telegram IDs
├── usage/
│   └── <slug>.yaml       # per-user LLM + tool usage (monthly period + lifetime)
└── config/
    └── caps.yaml         # optional per-user usage caps
```

The `data/` directory is gitignored. Files are created on first use.

### Usage caps

`data/config/caps.yaml` is optional — a missing file or key means "no cap". Per-slug `overrides` merge over `default`:

```yaml
default:
  llm_total_tokens: 500000      # monthly LLM token budget per user
  tools:
    firecrawl: 50               # monthly call budget for one tool
overrides:
  some-user-slug:
    llm_total_tokens: 1000000
```

The LLM token cap is checked before every agent turn on WebUI, Slack, and Telegram; tool caps are enforced inside the tool wrapper. Admins always bypass caps. Users can check their own counters anytime with the `/usage` command on WebUI, Telegram, and Slack. Programmatic access: `loadUsage(slug)`, `formatUsageReport(state)`, `recordLlm` / `recordToolCall` (all exported from the package root).

---

## Troubleshooting

**`Missing required environment variables: DEEPSEEK_API_KEY, UTARUS_AGENT_NAME, UTARUS_AGENT_PURPOSE`**
→ `.env` not loaded, or values empty. `cp .env.example .env` and fill in all three.

**`Telegram bot doesn't respond`**
→ Check `TELEGRAM_BOT_TOKEN` is set and valid. The CLI prints `[Telegram] Failed to start: ...` on launch if the token is rejected. The bot must be started via `/start` in Telegram before it accepts messages.

**`Slack bot doesn't respond`**
→ Check `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` are set and valid. The CLI prints `[Slack] Failed to start: ...` on launch if the tokens are rejected. Ensure Socket Mode is enabled in your Slack app settings.

**`You need an invite code to use this bot`**
→ Non-admin Telegram/Slack users must redeem an `INV-XXXXXXXX` code before they can chat. Admins issue codes via `/invite`.

---

## Development

```bash
npm run dev          # tsx watch — hot reload on save
npm run build        # tsc to dist/
npm start            # run compiled build (still needs .env)
npm test             # vitest, single run
npm run test:watch   # vitest watch mode
```

Tests cover the slug validator, `blankState`, and the fail-fast guards.

---

## Software dependencies

Runtime:
- [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) — agent runtime, tool loop, event subscribe
- [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) — OpenAI-compatible model adapters (DeepSeek, Kimi, …)
- [`telegraf`](https://www.npmjs.com/package/telegraf) — Telegram bot client
- [`typebox`](https://www.npmjs.com/package/typebox) — JSON-schema-compatible parameter validation
- [`yaml`](https://www.npmjs.com/package/yaml) — parse and stringify state files
- [`dotenv`](https://www.npmjs.com/package/dotenv) — `.env` loader

Dev:
- [`typescript`](https://www.npmjs.com/package/typescript) — strict mode
- [`tsx`](https://www.npmjs.com/package/tsx) — TS runner for dev
- [`vitest`](https://www.npmjs.com/package/vitest) — test runner

External services:
- **DeepSeek API** — the default LLM (Kimi / generic OpenAI-compatible endpoints also supported — see [LLM providers](#llm-providers))
- **Telegram Bot API** — optional (omit for CLI-only)

---

## License

ISC
