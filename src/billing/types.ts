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
  | 'intro_trial'
  | 'stripe'
  | 'admin_comp'
  | 'period_expired_read';

export type PastDuePolicy = 'retain_until_period_end';

/**
 * App-owned intro trial (no card): days from account create.
 * Lower caps than Pro; see `intro_caps` on the plan catalog.
 */
export const INTRO_TRIAL_DAYS = 7 as const;

/**
 * Stripe Checkout subscription trial (card required): days of free Pro
 * after upgrade, then first charge. Same caps as paid Pro.
 */
export const STRIPE_TRIAL_DAYS = 30 as const;

/**
 * @deprecated Use STRIPE_TRIAL_DAYS. Kept as alias for Checkout / API exports.
 */
export const TRIAL_PERIOD_DAYS = STRIPE_TRIAL_DAYS;

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
  /** Stripe Checkout trial length (card required). */
  trial_period_days: typeof STRIPE_TRIAL_DAYS;
  /** No-card intro window from user.created_at. */
  intro_trial_days: typeof INTRO_TRIAL_DAYS;
  /** Caps during intro_trial (must be lower than paid plan caps for llm_total_tokens). */
  intro_caps: PlanCaps;
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
  /** Must be STRIPE_TRIAL_DAYS (30). */
  trial_period_days: typeof STRIPE_TRIAL_DAYS;
  /** Must be INTRO_TRIAL_DAYS (7). */
  intro_trial_days: typeof INTRO_TRIAL_DAYS;
  intro_caps: PlanCaps;
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
  /** Set when source === intro_trial (ISO-8601 end of no-card window). */
  intro_trial_ends_at?: string | null;
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

/** Channel used to shape upgrade URLs and paywall copy. */
export type PaywallChannel = 'web' | 'telegram' | 'slack' | 'cli';

/**
 * Structured paywall / billing gate result for HTTP, SSE, and tools.
 * `cap_exceeded` → HTTP 429; `billing_state_error` → HTTP 503 (no upgrade CTA).
 */
export interface PaywallBlock {
  code: 'cap_exceeded' | 'billing_state_error';
  /** User-facing message (may embed absolute upgrade URL for bot channels). */
  message: string;
  /** Channel-aware; omit on billing_state_error. */
  upgradeUrl?: string;
  planId?: string;
  kind?: CapKind;
  current?: number;
  cap?: number;
}
