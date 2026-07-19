/**
 * Entitlement read API.
 *
 * - Beta users (user.beta): unlimited caps, no expiry, full paid features
 * - Implicit free when no billing file (or free after intro)
 * - App-owned intro trial: 7 days from user.created_at, no card, intro_caps
 * - Stripe Checkout trial / active: full paid plan caps (30-day free with card)
 * - Read-time period expiry (missed webhooks cannot leave forever-paid)
 * - Effective caps = plan/intro caps + caps.yaml per-slug overrides only
 * - hasFeature(slug, flag) for domain feature gates (API only in v1)
 */

import type { CapKind } from '../usage/caps.js';
import { getCap, getCapOverride } from '../usage/caps.js';
import { loadState, stateExists } from '../state/index.js';
import { loadBillingState } from './billing-file.js';
import { freePlanId, getPlan, loadPlansCatalog } from './plans.js';
import { isBillingEnabled } from './validate.js';
import type {
  BillingState,
  BillingStatus,
  Entitlement,
  EntitlementSource,
  PlanCaps,
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
 * Parse user.created_at (YYYY-MM-DD or ISO) to UTC start-of-day ms when date-only.
 */
export function parseUserCreatedAtMs(createdAt: string): number {
  if (!createdAt || typeof createdAt !== 'string') {
    throw new Error(`user.created_at is required for intro trial (got: ${String(createdAt)})`);
  }
  // Date-only YYYY-MM-DD → treat as UTC midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    const ms = Date.parse(`${createdAt}T00:00:00.000Z`);
    if (Number.isNaN(ms)) {
      throw new Error(`user.created_at is not a valid date: ${createdAt}`);
    }
    return ms;
  }
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) {
    throw new Error(`user.created_at is not a valid date: ${createdAt}`);
  }
  return ms;
}

export function introTrialEndsAtIso(createdAt: string, introDays: number): string {
  const start = parseUserCreatedAtMs(createdAt);
  return new Date(start + introDays * 24 * 60 * 60 * 1000).toISOString();
}

export function isWithinIntroTrial(
  createdAt: string,
  introDays: number,
  now: Date = new Date(),
): boolean {
  const endMs = parseUserCreatedAtMs(createdAt) + introDays * 24 * 60 * 60 * 1000;
  return now.getTime() < endMs;
}

function introEntitlement(
  catalog: PlansCatalog,
  createdAt: string,
): Entitlement {
  const paid = getPlan(catalog.default_paid_plan_id, catalog);
  const ends = introTrialEndsAtIso(createdAt, catalog.intro_trial_days);
  return {
    // Point at paid plan id for upgrade UX; caps come from intro_caps via getEffectiveCap.
    plan_id: paid.id,
    status: 'trialing',
    source: 'intro_trial',
    display_name: 'Intro trial',
    features: [...paid.features],
    intro_trial_ends_at: ends,
    current_period_end: ends,
  };
}

/** Grandfathered / ops beta: unlimited, never expires. */
function betaEntitlement(catalog: PlansCatalog): Entitlement {
  const paid = getPlan(catalog.default_paid_plan_id, catalog);
  return {
    plan_id: paid.id,
    status: 'comped',
    source: 'beta',
    display_name: 'Beta',
    features: [...paid.features],
  };
}

/** True when user.beta is explicitly true (strict boolean). */
export function isBetaUser(userSlug: string): boolean {
  if (!stateExists(userSlug)) return false;
  const state = loadState(userSlug);
  return state.user.beta === true;
}

/**
 * Compute effective entitlement from stored billing state + wall clock.
 * Pure read — does not rewrite the billing file.
 * Does **not** apply intro trial (needs user.created_at — see getEntitlement).
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

  // 4. Active / trialing → paid (Stripe path — full Pro caps)
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

function isFreeLike(ent: Entitlement): boolean {
  return ent.source === 'default_free' || ent.source === 'period_expired_read';
}

/**
 * Resolve effective entitlement for a user. Requires billing enabled.
 *
 * Order:
 * 1. user.beta === true → beta (unlimited, no expire) — wins over Stripe/free/intro
 * 2. Stripe / admin_comp from billing file
 * 3. free-like + within intro window → intro_trial
 * 4. free
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

  if (stateExists(userSlug)) {
    const user = loadState(userSlug);
    if (user.user.beta === true) {
      return betaEntitlement(catalog);
    }
  }

  const raw = loadBillingState(userSlug);
  const fromBilling = entitlementFromBillingState(raw, catalog, now);

  if (!isFreeLike(fromBilling)) {
    return fromBilling;
  }

  // Intro trial needs a user file (created_at). Missing user → free (fail closed for caps).
  if (!stateExists(userSlug)) {
    return fromBilling;
  }
  const user = loadState(userSlug);
  const createdAt = user.user.created_at;
  if (isWithinIntroTrial(createdAt, catalog.intro_trial_days, now)) {
    return introEntitlement(catalog, createdAt);
  }
  return fromBilling;
}

function capsForKind(caps: PlanCaps, kind: CapKind): number | undefined {
  if (kind === 'llm_total_tokens') {
    return caps.llm_total_tokens;
  }
  if (kind === 'llm_cost_usd') {
    return caps.llm_cost_usd;
  }
  if (kind.startsWith('tools.')) {
    const toolName = kind.slice('tools.'.length);
    return caps.tools?.[toolName];
  }
  return undefined;
}

function planCapFor(planId: string, kind: CapKind, catalog: PlansCatalog): number | undefined {
  return capsForKind(getPlan(planId, catalog).caps, kind);
}

/**
 * Effective cap for a user + kind.
 * - Billing off: same as getCap (default + overrides)
 * - Billing on + beta: unlimited (undefined) — no overrides
 * - Billing on: overrides.<slug> only, else intro_caps / plan caps
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

  const ent = getEntitlement(userSlug, now);
  if (ent.source === 'beta') {
    return undefined;
  }

  const override = getCapOverride(userSlug, kind);
  if (override !== undefined) {
    return override;
  }

  const catalog = loadPlansCatalog();
  if (ent.source === 'intro_trial') {
    return capsForKind(catalog.intro_caps, kind);
  }
  return planCapFor(ent.plan_id, kind, catalog);
}

/**
 * Domain feature gate. Returns false when billing is disabled or flag missing.
 * Empty features: [] on a plan is valid (no flags).
 * Intro trial uses paid plan features (try Pro product surface with lower caps).
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
