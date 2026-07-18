/**
 * Billing / paywall type model.
 *
 * Fail-fast shapes for plan catalog, per-user billing state, and runtime
 * entitlements. No silent defaults — callers assert coherence before use.
 */

import type { CapKind } from '../usage/caps.js';

export type BillingStatus =
  | 'none'
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'comped';

/** How the effective entitlement was derived. */
export type EntitlementSource =
  | 'default_free'
  | 'stripe'
  | 'admin_comp'
  | 'period_expired_read';

export type PastDuePolicy = 'retain_until_period_end';

/** v1 fixed trial length for all paid Checkout sessions. */
export const TRIAL_PERIOD_DAYS = 7 as const;

export interface PlanCaps {
  llm_total_tokens: number;
  llm_cost_usd?: number;
  tools?: Record<string, number>;
}

/**
 * A single plan tier. `stripe_price_id: null` means free (exactly one free
 * plan is required in the catalog).
 */
export interface PlanDefinition {
  id: string;
  display_name: string;
  stripe_price_id: string | null;
  caps: PlanCaps;
  features: string[];
}

/**
 * Validated plan catalog for a deployment.
 * `plans` is keyed by plan id; each value includes `id` equal to the key.
 */
export interface PlansCatalog {
  version: 1;
  past_due_policy: PastDuePolicy;
  trial_period_days: typeof TRIAL_PERIOD_DAYS;
  default_paid_plan_id: string;
  plans: Record<string, PlanDefinition>;
}

/**
 * Raw catalog shape accepted from YAML or DomainExtension.billing.plans
 * before plan ids are filled from object keys.
 */
export interface PlansCatalogInput {
  version: 1;
  past_due_policy: PastDuePolicy;
  trial_period_days: typeof TRIAL_PERIOD_DAYS;
  default_paid_plan_id: string;
  plans: Record<
    string,
    {
      display_name: string;
      stripe_price_id: string | null;
      caps: PlanCaps;
      features?: string[];
    }
  >;
}

/**
 * Per-user billing file at data/billing/<slug>.yaml.
 * Absence of file = implicit free (not represented as empty object).
 */
export interface BillingState {
  version: 1;
  user_slug: string;
  plan_id: string;
  status: BillingStatus;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  comped_by?: string | null;
  comped_plan_id?: string | null;
  updated_at: string;
  last_stripe_event_id?: string | null;
  /** Unknown keys preserved on load/save. */
  [key: string]: unknown;
}

/** Runtime view after read-time period expiry. */
export interface Entitlement {
  plan_id: string;
  status: BillingStatus;
  source: EntitlementSource;
  display_name: string;
  features: string[];
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  comped_by?: string | null;
  comped_plan_id?: string | null;
}

/**
 * Domain-supplied billing config. Extension plans win over plans.yaml.
 */
export interface DomainBillingConfig {
  plans?: PlansCatalogInput;
  copy?: {
    /**
     * If set, must include placeholders {current}, {cap}, {upgradeUrl}
     * or boot fails.
     */
    capHitTemplate?: string;
    /** Single Upgrade CTA label for the default paid plan. */
    upgradeCta?: string;
  };
}

export type { CapKind };
