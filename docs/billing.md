# Billing & paywall (Stripe)

Design source: [paywall-stripe-design.md](./paywall-stripe-design.md).

## Overview

When `UTARUS_BILLING_ENABLED=true`, Utarus resolves **effective caps** from a plan catalog (free + one paid plan) and per-user billing state written by **Stripe webhooks** (or admin comps). Pre-turn and tool gates block over-cap users with channel-aware upgrade links.

Flag **off** (default): legacy `caps.yaml` only; no Stripe routes.

## Enablement checklist

1. Create Stripe Product + Price (single currency). Note `price_…` id.
2. Write plan catalog either:
   - `DomainExtension.billing.plans` in the domain agent, **or**
   - `data/config/plans.yaml` (see schema below).
3. Set env:

```env
UTARUS_BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PUBLISHABLE_KEY=pk_...   # required when WebUI is mounted
UTARUS_PUBLIC_BASE_URL=https://your-agent.example.com
```

4. Register Stripe webhook endpoint: `POST https://your-agent.example.com/api/billing/webhook`  
   Events: `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`.
5. Remove `default:` from `data/config/caps.yaml` (overrides-only). Move free-tier numbers into `plans.free.caps`.
6. Optional grandfather:

```bash
UTARUS_BILLING_ENABLED=true UTARUS_DATA_ROOT=./data \
  node scripts/grandfather-billing-comps.mjs --plan pro --by ops --slugs alice,bob
```

7. Restart the process (`createFramework` fails fast if config is incomplete).
8. Smoke-test: free user hits cap → WebUI Billing / Telegram `/upgrade` → Checkout → webhook → higher caps.

## Rollback

Set `UTARUS_BILLING_ENABLED` unset or not `true`. Caps revert to `caps.yaml` default+overrides. Billing files remain on disk but are unused.

## plans.yaml schema (v1)

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
    stripe_price_id: price_xxx
    caps:
      llm_total_tokens: 5000000
      tools:
        firecrawl: 500
    features:
      - html_reports
```

## Domain extension

```ts
billing: {
  plans: { /* same shape as plans.yaml */ },
  copy: {
    upgradeCta: 'Upgrade to Pro',
    capHitTemplate: 'Hit {current}/{cap}. Upgrade: {upgradeUrl}',
  },
}
```

Extension plans **win entirely** over the file (no deep-merge).

## Key routes

| Path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/billing/enter?t=&return=/billing` | link token | Channel magic-link session exchange |
| `GET /api/billing/status` | user | Entitlement + usage |
| `POST /api/billing/checkout` | user | Stripe Checkout (7-day trial) |
| `POST /api/billing/portal` | user | Customer Portal |
| `POST /api/billing/webhook` | Stripe sig | Idempotent apply |
| `GET/POST /api/admin/billing/*` | admin | Inspect / comp / revoke / reconcile |

## Ops notes

- Single webhook consumer process recommended (YAML apply + per-slug lock is in-process).
- Comp freezes Stripe plan mutations until revoked; does **not** auto-cancel Stripe (P6).
- Mid-period `past_due` retains paid caps until `current_period_end` (read-time expiry).
