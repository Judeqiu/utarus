# Onboarding & Demo Mode — Integration Guide

This document is for **domain agent authors** (Invage, Binary, Marie, and any new Utarus-based agent). It explains how access, invite redeem, and demo mode work in the framework—and what you must **not** re-implement in your domain.

**Audience:** engineers wiring a `DomainExtension` into `createFramework()`.  
**Code owners:** `src/onboarding/*`, Slack/Telegram interfaces, `data/demo_mode.yaml`, `data/invites.yaml`, `data/users/`.

---

## 1. Design goals

| Goal | Behavior |
|------|----------|
| **Framework-owned access** | Every agent gets the same gate on Slack and Telegram. Domains do not reinvent invite Q&A. |
| **Instant join** | User pastes `INV-XXXXXXXX` → profile created in the same turn from channel display name. No name/email interview. |
| **Demo mode** | Admin turns open access on; anyone can chat; missing profiles auto-created like invite redeem. |
| **Human voice** | Warm, clear, professional. No profile/setup menus. Query clarifications only when the *task* is incomplete. |

---

## 2. Architecture overview

```text
Inbound message (Slack DM / @mention / Telegram text)
        │
        ▼
┌───────────────────────────────────────┐
│  resolveInboundMessage()              │  ← framework (src/onboarding/access-gate.ts)
│  1. Resolve linked user by channel id │
│  2. If unlinked & non-admin:          │
│       INV-  → redeemInviteInstantly   │
│       ADM-  → admin tool prompt       │
│       demo? → ensureChannelUser       │
│       else  → deny (need invite)      │
│  3. Domain enrichMessage (optional)   │
│  4. Agent run with enriched text      │
└───────────────────────────────────────┘
```

**Key rule for domains:** implement **domain context** in `enrichMessage` (portfolio, seller, campaign). Do **not** handle invite codes, demo mode, or “you need an invite” replies yourself. The framework already did that before your hook runs for unlinked non-admins (except admin-code agent path).

---

## 3. User-visible flows

### 3.1 Invite path (default production)

1. Admin runs `/invitecode` (Slack) or `/invite` (Telegram) → gets `INV-XXXXXXXX`.
2. Recipient pastes the code in a DM (optionally with a real question in the same message).
3. Framework:
   - Validates unused code in `data/invites.yaml`
   - Resolves display name (Slack `users.info` or Telegram first/last name)
   - Creates `data/users/<slug>.yaml`, links `slack_user_ids` / `telegram_user_ids`
   - Marks invite used
4. Same turn continues as a **linked** user. Domain `enrichMessage` can inject domain state.
5. If the message was only the code, the agent is steered to confirm they are set up and ask how to help—without signup questions.

### 3.2 Demo mode path

1. Admin runs `/demomode on` (Slack or Telegram). State stored in `data/demo_mode.yaml`.
2. Any unlinked non-admin sends a normal message (no invite).
3. Framework calls `ensureChannelUser` with channel display name (`source: 'demo'`).
4. User is linked and the agent answers the original message.
5. Admin runs `/demomode off` to require invites again.

Existing linked users are unchanged either way.

### 3.3 Admin onboard codes

- User pastes `ADM-XXXXXXXX`.
- Framework does **not** auto-create a normal user; it injects an agent instruction to call `redeem_admin_onboard_code` with the channel user id from context.
- No display-name/email Q&A.

### 3.4 Deny

If unlinked, not admin, no `INV-`/`ADM-`, and demo mode is **off**:

> You need an invite code to use this bot. Ask an admin for a code that looks like INV-XXXXXXXX.  
> (When demo mode is on, anyone can join without a code.)

---

## 4. Commands (admin)

| Command | Channel | Description |
|---------|---------|-------------|
| `/demomode on` | Slack, Telegram | Enable open access + auto profiles |
| `/demomode off` | Slack, Telegram | Disable; invites required again |
| `/demomode status` | Slack, Telegram | Show current flag + last change |
| `/invitecode [comment]` | Slack | Issue `INV-…` (Slack reserves `/invite`) |
| `/invite [comment]` | Telegram | Issue `INV-…` |
| `/invites [all\|unused\|used]` | Both | List invites |
| `/admincode`, `/admincodes`, `/revoke` | Both | Admin onboard codes |

**Who is admin:** `SLACK_ADMIN_IDS` / `TELEGRAM_ADMIN_IDS` in env, plus dynamic Telegram admin ids from redeemed `ADM-` codes (`data/admin_ids.yaml`).

**Slack:** register `/demomode` on the Slack app (manifest slash command). Socket Mode delivers it; URL can be a placeholder.

---

## 5. Data files

Under `UTARUS_DATA_ROOT` (default `./data`):

| File | Purpose |
|------|---------|
| `invites.yaml` | Invite codes; `used_by` / `used_by_slack` / `used_at` / `slug` when redeemed |
| `demo_mode.yaml` | `{ enabled, updated_at, updated_by_slack?, updated_by_telegram? }` |
| `users/<slug>.yaml` | Per-user state; framework fields + domain fields |
| `admin_codes.yaml` | Admin onboard codes |
| `admin_ids.yaml` | Extra Telegram admin ids |

### Profile created by invite / demo

- `profile.display_name` — Slack display/real name or Telegram name (or `Telegram <id>` if name missing)
- `profile.contact_email` — **not collected**; placeholder `{slug}@invite.local` or `{slug}@demo.local`
- `user.slack_user_ids` / `user.telegram_user_ids` — channel link
- `log[]` — `invite_redeemed` (mode `instant`) or `demo_auto_created` (mode `demo`)

Slug: kebab-case from display name; if non-Latin-only, `user-<channel-id>`; collisions get a short suffix.

---

## 6. Domain integration checklist

### Do

1. Depend on a Utarus commit that includes `src/onboarding/` (instant invite + demo mode + shared gate).
2. Implement `DomainExtension.enrichMessage` **only** for domain context when the user is already linked (or admin pass-through).

   Example (Invage-style):

   ```ts
   async enrichMessage(ctx) {
     const investor = resolveByChannel(ctx);
     if (investor) {
       return `[Investor context: …]\n\n${ctx.text}`;
     }
     // Unlinked access already handled by Utarus for non-admins.
     return ctx.text;
   }
   ```

3. Use channel ids from message context on tools (`slack_user_id` / `telegram_user_id`)—never ask the user.
4. Document admin commands in your app’s Slack manifest (`/demomode`, `/invitecode`, …) and any domain slash commands (`telegramCommands` / `slackCommands` / `webCommands`).
5. Prefer framework voice: friendly, professional; no profile interviews; at most one query clarification.

### Do not

1. Re-implement invite matching, multi-turn “what is your display name / email?”, or hard `REPLY: need invite` for unlinked users in the domain.
2. Assume `enrichMessage` replaces the entire access gate. The interfaces call **`resolveInboundMessage` first** (framework), then domain enrich for linked context.
3. Treat `@invite.local` / `@demo.local` as real mailbox addresses without an explicit product decision to collect email later.

### Optional public API

Import from `utarus` when you need programmatic control (tests, admin tools, custom interfaces):

```ts
import {
  resolveInboundMessage,
  redeemInviteInstantly,
  ensureChannelUser,
  fetchSlackDisplayName,
  isDemoModeEnabled,
  getDemoModeState,
  setDemoMode,
  parseDemoModeArgs,
  formatDemoModeStatus,
} from 'utarus';
```

| Export | Use |
|--------|-----|
| `resolveInboundMessage` | Full gate + enrich (Slack/Telegram already use this) |
| `redeemInviteInstantly` | Validate INV + create user + mark used |
| `ensureChannelUser` | Create/link profile without invite (demo uses this) |
| `isDemoModeEnabled` / `setDemoMode` | Read/toggle demo flag |
| `fetchSlackDisplayName` | Resolve Slack profile name via bot token |

---

## 7. Source map

| Concern | Path |
|---------|------|
| Access gate (Slack + Telegram shared) | `src/onboarding/access-gate.ts` |
| Instant invite + `ensureChannelUser` | `src/onboarding/instant-invite.ts` |
| Demo mode persistence | `src/onboarding/demo-mode.ts` |
| Slack wiring | `src/interfaces/slack/app.ts` → `resolveInboundMessage` |
| Telegram wiring | `src/interfaces/telegram.ts` → `resolveInboundMessage` |
| Invite tools (LLM / legacy manual redeem) | `src/tools/invite.ts` |
| System prompt access rules | `src/framework.ts` (`buildSystemPrompt`) |
| Agent-facing skill text | `src/skills/knowledge/getting-started.md` |
| Tests | `tests/instant-invite.test.ts` |

---

## 8. Sequence diagrams

### Invite redeem (happy path)

```text
User                Slack/Telegram           resolveInboundMessage           Disk
 |                        |                           |                        |
 |---- INV-ABC + ask ---->|                           |                        |
 |                        |--- resolveInboundMessage ->|                        |
 |                        |                           |-- validate invite ----->|
 |                        |                           |-- create user yaml ---->|
 |                        |                           |-- mark invite used ---->|
 |                        |                           |-- enrichMessage(domain)->|
 |                        |<-- agent text -------------|                        |
 |                        |--- LLM agent ------------->|                        |
 |<--- answer ------------|                           |                        |
```

### Demo mode (no invite)

```text
Admin               Framework                 User
 |-- /demomode on -->| write demo_mode.yaml     |
 |                    |                         |
 |                    |<---- "analyze AAPL" ----|
 |                    | ensureChannelUser       |
 |                    | agent answers with tools|
```

---

## 9. Operational notes

- **Turning demo on in production** opens the bot to anyone who can DM it. Use for demos, workshops, or short trials; turn **off** afterward.
- **Invite codes remain valid** while demo is on; users can still redeem `INV-…` normally.
- **Already-used invites** fail with a clear error (includes Slack-only redeem via `used_by_slack` / `used_at`).
- **Agent session key:** after first create, interfaces re-resolve the user and switch from `slack-<id>` / `tg-<id>` to the real `user.slug` so context stays with the profile.
- **Env:** `SLACK_BOT_TOKEN` required for Slack display-name lookup when `channelDisplayName` is not passed. Telegram uses `ctx.from` names when available.

---

## 10. Versioning

Domain agents should pin Utarus to a commit that includes this onboarding stack, for example:

```json
"utarus": "github:Judeqiu/utarus#<commit-with-onboarding>"
```

After upgrading:

1. `npm install`
2. Register `/demomode` on the Slack app if missing
3. Restart the agent process
4. Smoke-test: `/demomode status`, paste a fresh invite as a test user, toggle demo and message as unlinked

---

## 11. Related docs

- Framework overview: [README.md](../README.md)
- Getting-started skill (loaded by the agent): `src/skills/knowledge/getting-started.md`
- Admin skill: `src/skills/knowledge/admin.md`
