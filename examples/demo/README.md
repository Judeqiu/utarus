# Demo — Utarus paywall sample agent

A minimal **domain agent** that runs on the Utarus framework branch with **Stripe billing** wired through `DomainExtension.billing`.

Use this to learn the free → Pro path end-to-end without forking Binary/Marie.

| | |
| --- | --- |
| **Agent name** | Demo |
| **Free cap** | 5 000 LLM tokens / month (easy to hit) |
| **Pro** | 500 000 tokens + feature `pro_tools` |
| **Trial** | 7 days on every Checkout |
| **WebUI** | `http://localhost:3010` (default) |

Design / framework docs: [`docs/paywall-stripe-design.md`](../../docs/paywall-stripe-design.md), [`docs/billing.md`](../../docs/billing.md), [`docs/webui-chat-widgets.md`](../../docs/webui-chat-widgets.md) (side-panel widgets / floor plan).

### Side-panel widget demo

This agent registers kind **`floor-plan-3d`** (static IIFE under `static/widgets/floor-plan-3d/`).

1. `npm run dev` → http://localhost:3010 → login **demo** / **demo1234**
2. Ask: *Show me a 3D floor plan for unit 12B*
3. Expect: tool `show_widget` → white widget card → side panel; **Save view** writes durable state and a new chat card

### Inline Mermaid diagrams (platform)

No domain tools required. On WebUI the agent can emit free ` ```mermaid ` fences; the SPA renders them inline (Expand for zoom).

1. Same login as above
2. Ask: *Draw a flowchart of free vs Pro plan access for this demo agent*
3. Expect: a diagram card in the assistant message (not a side-panel widget)

### Knowledge base (framework-owned)

No domain setup. Tools are always present after Utarus ships KB.

1. Same login (**demo** / **demo1234**)
2. Ask: *Remember that I prefer bullet-point answers*
3. Expect: `create_kb` with `scope: private` → entry under `data/kb/users/demo.yaml`
4. New chat or later: *What do you know about my preferences?* → `search_kb` / `list_kb`
5. Admin session: can also create **shared** entries in `data/kb/shared.yaml`

Design: [`docs/knowledge-base-design.md`](../../docs/knowledge-base-design.md).

---

## Prerequisites

1. This Utarus repo on the **billing branch**, built once:

```bash
cd /path/to/utarus
npm install          # builds dist/ via prepare
npm --prefix web run build   # SPA for WebUI
```

2. A Stripe **test mode** account with:
   - One Product + recurring Price → copy `price_…`
   - API keys: `sk_test_…`, `pk_test_…`
3. An LLM key (e.g. DeepSeek).

Optional: [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward webhooks to localhost.

---

## Setup (5 minutes)

```bash
cd examples/demo
cp .env.example .env
# Edit .env — at least:
#   DEEPSEEK_API_KEY
#   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PUBLISHABLE_KEY
#   STRIPE_PRICE_ID
#   UTARUS_PUBLIC_BASE_URL=http://localhost:3010
#   UTARUS_BILLING_ENABLED=true

npm install
npm run dev
```

You should see:

```text
[Demo] WebUI + billing on http://localhost:3010
[Demo] billing: ON
[Demo] login as normal user: demo / demo1234
```

If billing is ON but secrets/plans are incomplete, **the process exits** (fail-fast). That is intentional.

### Sign-in (no invite needed for the seeded user)

| Role | Username | Password |
| --- | --- | --- |
| **Normal user** (paywall demo) | `demo` | `demo1234` |
| **Admin** (invites / billing ops) | `admin` | `demo-admin-pass` |

Use the **password** tab on http://localhost:3010/login.  
Admin uses `WEBAPP_ADMIN_CREDENTIALS` (SPA now accepts env admins).  
To re-seed the normal user: `DEMO_RESET_USER=1 npm run dev`.

### Webhook for local Stripe

In another terminal:

```bash
stripe listen --forward-to localhost:3010/api/billing/webhook
```

Copy the printed `whsec_…` into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart `npm run dev`.

Dashboard webhook (production-like):  
`POST https://your-host/api/billing/webhook`  
Events: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.

---

## How the paywall works (mental model)

```text
User chats  →  checkTurnAllowed (tokens) + tool caps
                │
                ├─ under cap → LLM / tools run, usage counted
                │
                └─ at/over cap → blocked
                      WebUI:  HTTP 429 + upgrade_url=/billing
                      Bots:   message + magic link → /api/billing/enter → /billing
                              │
                              ▼
                         Checkout (Pro, 7-day trial)
                              │
                         Stripe webhook
                              │
                         data/billing/<slug>.yaml  (source of truth)
                              │
                         higher plan caps
```

- **Plans** live in `src/plans.ts` (via `DomainExtension.billing.plans`). Free caps are deliberately low.
- **Billing file** per user: `data/billing/<slug>.yaml`. Missing file = free.
- **Admins** (WebUI admin credentials) bypass caps entirely.
- **Invite gate** is separate: users still need an invite (or demo mode) to create an account.

---

## Walkthrough: hit the wall and upgrade

### 1. Sign in as the free user

1. Open `http://localhost:3010/login`
2. Password tab: **`demo` / `demo1234`** (seeded on boot)

(Optional) Admin `admin` / `demo-admin-pass` for invites and Admin → Billing.

### 2. See free plan status

In chat, type:

```text
/plan
```

Or on Telegram/Slack (if configured): `/plan` and `/usage`.

### 3. Burn free tokens (hit the paywall)

Chat a few medium-length messages, or ask the model to call the `hello` tool repeatedly. Free plan allows **5 000** tokens and **5** `hello` tool calls.

When blocked:

- **WebUI:** error banner + open **Billing** in the nav (or go to `/billing`)
- **Telegram/Slack:** cap message; `/upgrade` mints a one-click enter link

### 4. Upgrade (Checkout)

1. Open **Billing**
2. **Upgrade to Pro** → Stripe Checkout (test card `4242 4242 4242 4242`)
3. 7-day trial starts; success URL returns to `/billing?checkout=success`
4. Page polls until webhook writes paid entitlement

Confirm with `/plan` — you should see Pro / `trialing` or `active` and a higher token cap.

### 5. Manage / cancel

On Billing, **Manage subscription** opens Stripe Customer Portal.

### 6. Admin ops (optional)

Still as Web admin:

- **Admin → Billing** — load a slug, **Comp** to `pro` without Checkout, **Revoke comp**, **Reconcile** from Stripe
- Comp does **not** cancel Stripe (you must cancel in Portal if they were paying)

CLI grandfather (ops script from repo root):

```bash
UTARUS_BILLING_ENABLED=true UTARUS_DATA_ROOT=examples/demo/data \
  node scripts/grandfather-billing-comps.mjs --plan pro --by ops --slugs your-user-slug
```

(Note: that script reads `data/config/plans.yaml`; this demo uses **extension plans**, so prefer Admin Comp or write a billing YAML by hand for grandfathers.)

---

## Feature gate demo

Pro plan includes feature `pro_tools`. Ask the agent:

```text
Call the hello tool with fancy=true
```

- Free: tool returns a “Pro feature” message  
- Pro: fancy greeting  

Framework API used: `hasFeature(userSlug, 'pro_tools')` in `src/tools/hello.ts`.

---

## Env cheat sheet

| Variable | Role |
| --- | --- |
| `UTARUS_BILLING_ENABLED=true` | Turn paywall on |
| `STRIPE_SECRET_KEY` | Server Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Verify webhooks |
| `STRIPE_PUBLISHABLE_KEY` | WebUI (required when WebUI mounts) |
| `STRIPE_PRICE_ID` | Maps to `plans.pro.stripe_price_id` |
| `UTARUS_PUBLIC_BASE_URL` | Checkout URLs + bot magic links |
| `WEBAPP_PORT` | Local WebUI port (default 3010) |
| `WEBAPP_ADMIN_CREDENTIALS` | JSON `{"user":"pass"}` |

Billing **off**: omit or set `UTARUS_BILLING_ENABLED` to anything other than `true`. Legacy `caps.yaml` applies; no Billing nav / Checkout.

---

## Project layout

```text
examples/demo/
  src/
    index.ts        # boot WebUI (+ optional Telegram/Slack)
    extension.ts    # DomainExtension + billing + /plan
    plans.ts        # free / pro catalog
    tools/hello.ts  # sample tool + hasFeature
  data/             # UTARUS_DATA_ROOT (seeded on first run)
  .env.example
  README.md         # this file
```

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Boot: missing required env | Fill Stripe + `UTARUS_PUBLIC_BASE_URL` when billing on |
| Checkout succeeds but still free | Stripe CLI not forwarding; check `data/billing/events/` and server logs |
| `caps.yaml must not define default` | Demo seeds overrides-only; remove any `default:` section you added |
| Magic link lands on login | Use `/upgrade` (enter route), not a bare `/billing?t=` URL |
| Admin still capped | Sign in with **admin** credentials (type admin), not a normal user |

---

## Next steps

- Point `STRIPE_PRICE_ID` at a live Price and deploy with a real `UTARUS_PUBLIC_BASE_URL`
- Fork this folder into its own repo and depend on a published `utarus` version once billing ships to `main`
- Raise free caps in `src/plans.ts` for a real product
