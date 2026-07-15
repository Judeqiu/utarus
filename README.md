# Utarus — A Generic Agent Framework

Utarus is a small TypeScript framework for building LLM agents that have **per-user state**, **admin-controlled onboarding**, and **tool-enforced rules**. It is the generic distillation of a production agent codebase — everything domain-specific has been stripped, leaving a clean skeleton you can fork into any vertical.

Built on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core). Same skeleton as [Marie](https://judeqiu.github.io/marie/) and [Binary](https://github.com/Judeqiu/binary) — different domain.

> **Documentation site:** see `docs/index.html` or the published GitHub Pages link in the repo description.

---

## What you get out of the box

- **CLI + Telegram + Slack interfaces** that share a per-user agent pool (24h TTL eviction, 100-agent cap).
- **Per-user YAML state** at `data/users/<slug>.yaml`. The state file is the source of truth.
- **Instant invite onboarding** (`INV-XXXXXXXX`) — admins issue codes; recipients paste the code and get a profile immediately (channel display name, no name/email Q&A). See [docs/onboarding-integration.md](docs/onboarding-integration.md).
- **Domain agent integration** — a `DomainExtension` contract for plugging in a vertical (portfolio analyst, CRM, sales coach, …). See [docs/integration-guide.md](docs/integration-guide.md) for the full data model, channel identity model, and a walkthrough using [Invage](https://github.com/Judeqiu/invage) as the sample agent.
- **Demo mode** (`/demomode on|off`) — admin-only open access; auto-create profiles for anyone who chats. Same doc as above.
- **Admin onboard codes** (`ADM-XXXXXXXX`) — admins can grant admin rights to other Telegram/Slack users at runtime.
- **Skill framework** — markdown knowledge docs the agent loads on demand via `use_skill`.
- **TypeBox-schematized tools** — every tool parameter is validated by the runtime before your code runs.
- **Dynamic admin list** — file-backed, no restart needed when new admins are granted.
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
- A **DeepSeek API key** (the LLM). Get one at https://platform.deepseek.com → API Keys
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

## Run

```bash
npm run dev          # tsx watch — hot reload on save
```

On startup you'll see:

```
Acme Support Bot starting...
Initializing DeepSeek model...
DeepSeek model: deepseek-v4-pro
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
└── admin_ids.yaml        # dynamically-granted admin Telegram IDs
```

The `data/` directory is gitignored. Files are created on first use.

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
- [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) — DeepSeek model adapter
- [`telegraf`](https://www.npmjs.com/package/telegraf) — Telegram bot client
- [`typebox`](https://www.npmjs.com/package/typebox) — JSON-schema-compatible parameter validation
- [`yaml`](https://www.npmjs.com/package/yaml) — parse and stringify state files
- [`dotenv`](https://www.npmjs.com/package/dotenv) — `.env` loader

Dev:
- [`typescript`](https://www.npmjs.com/package/typescript) — strict mode
- [`tsx`](https://www.npmjs.com/package/tsx) — TS runner for dev
- [`vitest`](https://www.npmjs.com/package/vitest) — test runner

External services:
- **DeepSeek API** — required (the LLM)
- **Telegram Bot API** — optional (omit for CLI-only)

---

## License

ISC
