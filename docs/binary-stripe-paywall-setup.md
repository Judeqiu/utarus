# Binary + Stripe paywall setup

Step-by-step instructions to enable the Utarus **Stripe paywall** on the **Binary** agent (local or production).

**Related docs**

| Doc | Role |
| --- | --- |
| [billing.md](./billing.md) | Framework billing reference (env, routes, rollback) |
| [paywall-stripe-design.md](./paywall-stripe-design.md) | Full design / semantics |
| [examples/demo](../examples/demo) | Minimal free → Pro sample agent |

---

## What you get when it works

```text
Seller chats on WebUI / Telegram
        │
        ▼
  checkTurnAllowed (plan caps from free or paid)
        │
        ├─ under cap → agent runs, usage counted in data/usage/<slug>.yaml
        │
        └─ at/over cap → blocked
              WebUI:  Billing page → Stripe Checkout (7-day trial)
              Telegram: /upgrade → magic link → Checkout
                        │
                        ▼
              Stripe webhook → data/billing/<slug>.yaml
                        │
                        ▼
              higher plan caps (Pro)
```

| Storage | Path | Notes |
| --- | --- | --- |
| Per-user subscription | `data/billing/<slug>.yaml` | Missing file = free |
| Webhook idempotency | `data/billing/events/<event_id>.json` | Do not delete casually |
| Plan catalog | `DomainExtension.billing.plans` **or** `data/config/plans.yaml` | Extension wins entirely |
| Usage meters | `data/usage/<slug>.yaml` | Separate from billing |

---

## Prerequisites

### 1. Utarus version with billing

Binary currently pins Utarus without billing (e.g. `github:Judeqiu/utarus#v1.2.0`). **Paywall requires a Utarus build that includes `src/billing/`** (this repo after the billing PRs land, or a published tag/branch that exports billing).

In Binary’s `package.json`:

```json
"dependencies": {
  "utarus": "github:Judeqiu/utarus#<tag-or-branch-with-billing>"
}
```

Then on the Binary host:

```bash
cd /path/to/binary   # e.g. /opt/binary on lextok03, or local clone
npm install
npx tsc              # if you run dist/
```

**Verify** the installed package has billing:

```bash
ls node_modules/utarus/dist/billing/
# expect: billing-file.js, entitlements.js, webhooks.js, …
```

If that directory is missing, stop — upgrading Utarus is required before any Stripe config will do anything.

### 2. Single process for agent + WebUI

Checkout, Billing SPA, and webhooks are mounted on **`framework.startWebApp()`** in the **same process** as `createFramework` (see Binary `src/index.ts` when `WEBAPP_PORT` is set).

| Entry | Billing / Checkout / webhook? |
| --- | --- |
| Agent process + `WEBAPP_PORT` (`npm run dev` / `binary-telegram` + startWebApp) | **Yes** |
| Standalone `npm run webapp` (BinDrive only) | **No** — no chat pool, no billing router |

Do **not** point Stripe webhooks at a BinDrive-only service.

### 3. Accounts and secrets

- Stripe account (start in **test mode**, then switch to live).
- Binary already has: LLM key, `WEBAPP_PORT`, `SESSION_SECRET`, Telegram (optional but common for sellers).
- A **public HTTPS origin** that reaches Binary’s WebUI (required for Checkout success URLs and bot magic links). Locally you can use `http://localhost:<port>` + Stripe CLI.

---

## Step A — Stripe Dashboard

Work in **Test mode** first (toggle in Dashboard).

### A1. Product + Price

1. **Products → Add product**
   - Name: e.g. `Binary Pro`
   - Description: optional
2. **Pricing**
   - Recurring (monthly or yearly — one Price for v1)
   - Currency: pick **one** (v1 catalog is single-currency)
3. Copy the **Price id** (`price_…`). You will put it in the plan catalog.

### A2. API keys

**Developers → API keys**

| Key | Env var | Use |
| --- | --- | --- |
| Secret key `sk_test_…` / `sk_live_…` | `STRIPE_SECRET_KEY` | Server Checkout / Portal / webhook apply |
| Publishable key `pk_test_…` / `pk_live_…` | `STRIPE_PUBLISHABLE_KEY` | WebUI (required when WebUI is mounted) |

### A3. Customer Portal (recommended)

**Settings → Billing → Customer portal**

- Enable cancellation / plan management as you prefer.
- Binary Billing page uses `POST /api/billing/portal` so sellers can manage/cancel without ops.

### A4. Webhook endpoint

**You will finish this after Binary has a public URL** (Step D). You need:

- Endpoint URL: `https://<your-public-host>/api/billing/webhook`
- Events (minimum):
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`
- Signing secret → `STRIPE_WEBHOOK_SECRET` (`whsec_…`)

**Local development:** skip Dashboard endpoint; use Stripe CLI (Step E).

---

## Step B — Wire Binary plan catalog

Pick **one** of the two approaches. Extension plans **replace** the file entirely (no deep-merge).

### Option 1 — Domain extension (recommended for Binary)

Add a plans module and attach it to `binaryExtension`.

**`src/plans.ts`** (new file in Binary):

```ts
import type { PlansCatalogInput } from 'utarus';

const proPriceId = (process.env.STRIPE_PRICE_ID || '').trim();
if (!proPriceId) {
  // Only required when billing is on; createFramework will still fail if
  // stripe_price_id is invalid when UTARUS_BILLING_ENABLED=true.
}

export const BINARY_PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 7, // v1 fixed — must be exactly 7
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: {
        // Tune for real sellers — demo uses tiny numbers so the wall is easy to hit
        llm_total_tokens: 200_000,
        tools: {
          firecrawl: 20,
          // add tool names you actually cap (must match tool `name` strings)
        },
      },
      features: [],
    },
    pro: {
      display_name: 'Pro',
      stripe_price_id: proPriceId || 'price_REPLACE_ME',
      caps: {
        llm_total_tokens: 5_000_000,
        tools: {
          firecrawl: 500,
        },
      },
      features: [
        // optional product flags; gate in domain tools with hasFeature(slug, '…')
      ],
    },
  },
};
```

**`src/extension.ts`** — on the `DomainExtension` object:

```ts
import { BINARY_PLANS } from './plans.js';

export const binaryExtension: DomainExtension = {
  // …existing purpose, tools, skills, webUi…
  billing: {
    plans: BINARY_PLANS,
    copy: {
      upgradeCta: 'Upgrade to Pro',
      // Optional; must include {current}, {cap}, {upgradeUrl} if set:
      // capHitTemplate: 'You hit {current}/{cap}. Upgrade: {upgradeUrl}',
    },
  },
};
```

### Option 2 — File-only catalog

If you prefer ops-editable YAML and **no** `billing` on the extension:

**`data/config/plans.yaml`**

```yaml
version: 1
past_due_policy: retain_until_period_end
trial_period_days: 7
default_paid_plan_id: pro
plans:
  free:
    display_name: Free
    stripe_price_id: null
    caps:
      llm_total_tokens: 200000
      tools:
        firecrawl: 20
    features: []
  pro:
    display_name: Pro
    stripe_price_id: price_XXXXXXXX   # your Stripe Price id
    caps:
      llm_total_tokens: 5000000
      tools:
        firecrawl: 500
    features: []
```

`createFramework` fails fast if billing is on and neither extension plans nor this file validates.

### Caps.yaml rule (mandatory when billing is on)

When `UTARUS_BILLING_ENABLED=true`, **`data/config/caps.yaml` must not define `default:`**. Free-tier numbers live in **plan caps**. Per-slug overrides remain for admin comps:

```yaml
# data/config/caps.yaml — overrides only
overrides: {}
# optional:
# overrides:
#   vip-seller:
#     llm_total_tokens: 10000000
```

If `default` is present, boot throws.

---

## Step C — Binary environment

Add to Binary’s `.env` (local and `/opt/binary/.env` on the server). Keep secrets out of git.

```env
# ── Paywall master switch (must be exactly the string true) ──
UTARUS_BILLING_ENABLED=true

# ── Stripe ──
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
# Used by src/plans.ts if you follow Option 1:
STRIPE_PRICE_ID=price_...

# ── Public origin (no trailing slash) ──
# Checkout success/cancel + Telegram /upgrade magic links.
# Local:
#   UTARUS_PUBLIC_BASE_URL=http://localhost:3000
# Production (must match what sellers open in the browser / Caddy):
#   UTARUS_PUBLIC_BASE_URL=https://binary.example.com

UTARUS_PUBLIC_BASE_URL=https://your-public-host

# ── WebUI must be on (Billing page + webhook route) ──
WEBAPP_PORT=3000
SESSION_SECRET=long-random-string
WEBAPP_ADMIN_CREDENTIALS={"admin":"change-me"}

# Existing Binary vars still required as today:
# DEEPSEEK_API_KEY=...
# UTARUS_DATA_ROOT=./data
# TELEGRAM_BOT_TOKEN=...   # optional but needed for /upgrade in Telegram
# TELEGRAM_ADMIN_IDS=...
# UTARUS_LOADED_BY_HOST=1
```

**Fail-fast:** if billing is on and any of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `UTARUS_PUBLIC_BASE_URL` (and with WebUI: `STRIPE_PUBLISHABLE_KEY`) is missing, **`createFramework` throws and the process exits**. That is intentional.

**Turn paywall off:** set `UTARUS_BILLING_ENABLED` to anything other than `true` (or unset). Billing YAML files remain on disk but are unused; caps fall back to legacy `caps.yaml` (including `default` if present).

---

## Step D — Production networking (Binary on VPS)

Typical Binary layout (see binary-ops): app at `/opt/binary`, Caddy reverse-proxies to `WEBAPP_PORT`.

### D1. Public URL

`UTARUS_PUBLIC_BASE_URL` must be the **HTTPS origin** users and Stripe hit, e.g. `https://binary.yourdomain.com` — **not** the bare IP if TLS terminates on a hostname, and **not** `http://localhost`.

### D2. Caddy

Ensure the host that serves the SPA also proxies **all** `/api/*` (including `/api/billing/*`) to the **agent** process that called `startWebApp`, not a separate BinDrive-only unit.

Example sketch (adjust host/port to your Caddyfile):

```caddyfile
binary.example.com {
	reverse_proxy localhost:3000
}
```

Reload:

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

### D3. Register the live webhook

In Stripe Dashboard (test or live mode matching your keys):

1. **Developers → Webhooks → Add endpoint**
2. URL: `https://binary.example.com/api/billing/webhook`
3. Select the events listed in A4
4. Reveal **Signing secret** → set `STRIPE_WEBHOOK_SECRET` on the server
5. Restart Binary so the new env is loaded:

```bash
# example production
ssh lextok03 "systemctl restart binary-telegram"
# if you also run a separate bindrive unit for static portal only, leave it;
# webhooks must still hit the agent+WebUI process above.
```

### D4. Single writer process

YAML billing apply uses an **in-process** per-slug lock. Run **one** webhook consumer (one agent process). Do not load-balance webhooks across multiple Node instances without an external lock.

---

## Step E — Local development (Stripe CLI)

```bash
# Terminal 1 — Binary with billing env
cd /path/to/binary
# ensure UTARUS_BILLING_ENABLED=true and localhost PUBLIC_BASE_URL
npm run dev

# Terminal 2 — forward Stripe events
stripe listen --forward-to localhost:3000/api/billing/webhook
```

Copy the CLI’s `whsec_…` into Binary `.env` as `STRIPE_WEBHOOK_SECRET`, restart Binary.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

---

## Step F — Smoke test checklist

1. **Boot**
   - Process starts without throw.
   - WebUI opens; nav shows **Billing** when billing is on.
2. **Free user**
   - Log in as a normal (non-admin) seller / user.
   - Chat until free cap is hit **or** inspect `GET /api/billing/status` (session cookie).
   - Expect free plan, usage near cap → 429 / paywall message on next turn.
3. **Upgrade**
   - WebUI **Billing → Upgrade** → Checkout → complete with test card.
   - Return URL: `/billing?checkout=success` (page polls until webhook lands).
4. **Confirm entitlement**
   - File appears: `data/billing/<slug>.yaml` with `status: trialing` or `active`, `plan_id: pro`, Stripe ids set.
   - Event receipt: `data/billing/events/<evt_…>.json`.
   - Further chat uses Pro caps.
5. **Telegram** (if enabled)
   - Linked user: `/upgrade` returns a one-click enter link (not a bare `/billing` URL).
6. **Portal**
   - Billing → Manage subscription opens Customer Portal.
7. **Admin** (Web admin credentials)
   - **Admin → Billing**: load slug, Comp / Revoke / Reconcile.
   - Comp freezes Stripe plan mutations until revoked; it does **not** auto-cancel Stripe.

### Optional grandfather (ops)

From a Utarus checkout that includes the script (or Binary after depending on that Utarus):

```bash
UTARUS_BILLING_ENABLED=true UTARUS_DATA_ROOT=/path/to/binary/data \
  node /path/to/utarus/scripts/grandfather-billing-comps.mjs \
  --plan pro --by ops --slugs alice,bob
```

Note: that script targets plan ids present in **`data/config/plans.yaml`**. If Binary uses **extension-only** plans, prefer **Admin → Comp** or write `data/billing/<slug>.yaml` with `status: comped` via admin API.

---

## Mental model for Binary sellers

| Layer | Who owns it | Binary notes |
| --- | --- | --- |
| Invite / demo access | Utarus onboarding | Paywall is **after** the user exists |
| Free / Pro caps | Plan catalog | Tune tokens + tool caps for AM workloads (Firecrawl, reports, …) |
| Subscription row | Stripe → webhook → `data/billing/` | Missing file = free |
| Usage | `data/usage/` | Monthly meters vs plan caps |
| Admins | Web admin / Telegram admin ids | Cap bypass for admins (interactive) |

Feature flags on plans (`features: [...]`) are optional. Domain tools can call `hasFeature(userSlug, 'flag')` from Utarus when you want Pro-only product behavior.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Boot: missing required env | Incomplete Stripe / public URL | Fill all vars in Step C |
| Boot: `caps.yaml must not define "default"` | Dual free-tier source | Remove `default` from caps.yaml |
| Boot: plans catalog error | Bad `trial_period_days` / missing free plan / bad price id | Must be `trial_period_days: 7`; exactly one free plan (`stripe_price_id: null`) |
| No Billing nav | Billing flag off or old Utarus | `UTARUS_BILLING_ENABLED=true`; upgrade Utarus |
| Checkout OK, still free | Webhook not reaching agent process | Stripe CLI / Dashboard URL; check logs; look under `data/billing/events/` |
| Webhook 404 | Hit BinDrive-only process or wrong host | Proxy `/api/billing/webhook` to agent+startWebApp process |
| Magic link → login wall | Wrong enter URL | Use `/upgrade` or Billing enter flow (`/api/billing/enter?t=…`), not raw token on `/billing` |
| Live mode charges but test keys | Mode mismatch | Live keys + live webhook secret + live `price_…` |
| Multiple Binary instances fight | Two processes both apply webhooks | One writer only |

---

## Rollback

1. Set `UTARUS_BILLING_ENABLED` unset or not `true`.
2. Restart Binary.
3. Optionally restore `default:` in `caps.yaml` if you still rely on legacy caps.
4. Leave `data/billing/` in place (harmless when flag is off) or archive it.

Stripe subscriptions continue in Stripe until cancelled in Dashboard / Customer Portal — turning the flag off only stops Utarus from enforcing plan caps via billing files.

---

## Production go-live checklist

- [ ] Utarus dependency includes `dist/billing`
- [ ] Binary has `billing.plans` or `data/config/plans.yaml`
- [ ] `caps.yaml` has **no** `default`
- [ ] Live Stripe Product + Price; live API keys in server `.env`
- [ ] `UTARUS_PUBLIC_BASE_URL` = public HTTPS origin
- [ ] `WEBAPP_PORT` on the agent process; Caddy proxies SPA + `/api`
- [ ] Webhook endpoint registered; signing secret matches env
- [ ] Smoke test free → Checkout → Pro on a real (or staff) account
- [ ] Optional: grandfather comps for existing VIP sellers
- [ ] Document free vs Pro limits for sellers (support / guidance page)

---

## Quick reference — routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/billing/status` | user session | Entitlement + usage |
| POST | `/api/billing/checkout` | user | Stripe Checkout (7-day trial) |
| POST | `/api/billing/portal` | user | Customer Portal |
| POST | `/api/billing/webhook` | Stripe signature | Apply subscription snapshot |
| GET | `/api/billing/enter?t=&return=` | link token | Telegram/Slack magic-link session |
| * | `/api/admin/billing/*` | admin | Inspect / comp / revoke / reconcile |

Telegram (when bot is up): `/upgrade`, and usage/plan commands if the framework version exposes them.
)
