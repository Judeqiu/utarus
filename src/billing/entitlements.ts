/**
 * Entitlement read API.
 *
 * - Implicit free when no billing file
 * - Read-time period expiry (missed webhooks cannot leave forever-paid)
 * - Effective caps = plan caps + caps.yaml per-slug overrides only
 * - hasFeature(slug, flag) for domain feature gates (API only in v1)
 */

import type { CapKind } from '../usage/caps.js';
import { getCap, getCapOverride } from '../usage/caps.js';
import { loadBillingState } from './billing-file.js';
import { freePlanId, getPlan, loadPlansCatalog } from './plans.js';
import { isBillingEnabled } from './validate.js';
import type {
  BillingState,
  BillingStatus,
  Entitlement,
  EntitlementSource,
  PlansCatalog,
} from './types.js';

function freeEntitlement(
  catalog: PlansCatalog,
  source: EntitlementSource,
): Entitlement {
  const id = freePlanId(catalog);
  const plan = catalog.plans[id];
  return {
    plan_id: id,
    status: 'none',
    source,
    display_name: plan.display_name,
    features: [...plan.features],
  };
}

function periodEnded(raw: BillingState, now: Date): boolean {
  if (raw.current_period_end == null || raw.current_period_end === '') {
    return false;
  }
  const end = Date.parse(raw.current_period_end);
  if (Number.isNaN(end)) {
    throw new Error(
      `Billing state has invalid current_period_end for slug=${raw.user_slug}: ${raw.current_period_end}`,
    );
  }
  return now.getTime() >= end;
}

function paidEntitlement(
  raw: BillingState,
  catalog: PlansCatalog,
  source: EntitlementSource,
  planId: string,
  status: BillingStatus,
): Entitlement {
  const plan = getPlan(planId, catalog);
  return {
    plan_id: planId,
    status,
    source,
    display_name: plan.display_name,
    features: [...plan.features],
    current_period_end: raw.current_period_end ?? null,
    cancel_at_period_end: raw.cancel_at_period_end ?? false,
    stripe_customer_id: raw.stripe_customer_id ?? null,
    stripe_subscription_id: raw.stripe_subscription_id ?? null,
    comped_by: raw.comped_by ?? null,
    comped_plan_id: raw.comped_plan_id ?? null,
  };
}

/**
 * Compute effective entitlement from stored billing state + wall clock.
 * Pure read — does not rewrite the billing file.
 *
 * Rules (v1):
 * 1. status === comped → comp plan; ignore period end
 * 2. period ended + status ∈ {canceled, unpaid, past_due} → free
 * 3. period ended + cancel_at_period_end → free
 * 4. status ∈ {active, trialing} → paid (even if period end slightly stale)
 * 5. status ∈ {canceled, unpaid, past_due} + period not ended → paid until end
 * 6. else → free
 */
export function entitlementFromBillingState(
  raw: BillingState | null,
  catalog: PlansCatalog,
  now: Date = new Date(),
): Entitlement {
  if (!raw) {
    return freeEntitlement(catalog, 'default_free');
  }

  // 1. Comp — not subject to Stripe period end
  if (raw.status === 'comped') {
    const planId = (raw.comped_plan_id || raw.plan_id) as string;
    return paidEntitlement(raw, catalog, 'admin_comp', planId, 'comped');
  }

  const ended = periodEnded(raw, now);
  const graceStatuses: BillingStatus[] = ['canceled', 'unpaid', 'past_due'];

  // 2. Period ended + terminal/grace statuses → free
  if (ended && graceStatuses.includes(raw.status)) {
    return freeEntitlement(catalog, 'period_expired_read');
  }

  // 3. Period ended + cancel_at_period_end → free
  if (ended && raw.cancel_at_period_end === true) {
    return freeEntitlement(catalog, 'period_expired_read');
  }

  // 4. Active / trialing → paid
  if (raw.status === 'active' || raw.status === 'trialing') {
    return paidEntitlement(raw, catalog, 'stripe', raw.plan_id, raw.status);
  }

  // 5. Mid-period grace (canceled / unpaid / past_due, period not ended)
  if (graceStatuses.includes(raw.status) && !ended) {
    return paidEntitlement(raw, catalog, 'stripe', raw.plan_id, raw.status);
  }

  // 6. else free
  return freeEntitlement(catalog, 'default_free');
}

/**
 * Resolve effective entitlement for a user. Requires billing enabled.
 */
export function getEntitlement(
  userSlug: string,
  now: Date = new Date(),
): Entitlement {
  if (!isBillingEnabled()) {
    throw new Error(
      'getEntitlement requires UTARUS_BILLING_ENABLED=true',
    );
  }
  const catalog = loadPlansCatalog();
  const raw = loadBillingState(userSlug);
  return entitlementFromBillingState(raw, catalog, now);
}

function planCapFor(planId: string, kind: CapKind, catalog: PlansCatalog): number | undefined {
  const plan = getPlan(planId, catalog);
  if (kind === 'llm_total_tokens') {
    return plan.caps.llm_total_tokens;
  }
  if (kind === 'llm_cost_usd') {
    return plan.caps.llm_cost_usd;
  }
  if (kind.startsWith('tools.')) {
    const toolName = kind.slice('tools.'.length);
    return plan.caps.tools?.[toolName];
  }
  return undefined;
}

/**
 * Effective cap for a user + kind.
 * - Billing off: same as getCap (default + overrides)
 * - Billing on: overrides.<slug> only, else plan caps, else unlimited (undefined)
 * - Admins: caller short-circuits before this (unlimited)
 */
export function getEffectiveCap(
  userSlug: string,
  kind: CapKind,
  now: Date = new Date(),
): number | undefined {
  if (!userSlug) {
    throw new Error('getEffectiveCap requires userSlug');
  }
  if (!isBillingEnabled()) {
    return getCap(userSlug, kind);
  }

  const override = getCapOverride(userSlug, kind);
  if (override !== undefined) {
    return override;
  }

  const ent = getEntitlement(userSlug, now);
  const catalog = loadPlansCatalog();
  return planCapFor(ent.plan_id, kind, catalog);
}

/**
 * Domain feature gate. Returns false when billing is disabled or flag missing.
 * Empty features: [] on a plan is valid (no flags).
 */
export function hasFeature(userSlug: string, flag: string): boolean {
  if (!flag || typeof flag !== 'string') {
    throw new Error(`hasFeature requires a non-empty flag (got: ${String(flag)})`);
  }
  if (!isBillingEnabled()) {
    return false;
  }
  const ent = getEntitlement(userSlug);
  return ent.features.includes(flag);
}
