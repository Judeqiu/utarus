/**
 * Admin billing ops: comp, revoke-comp, reconcile.
 *
 * P6: comp does not cancel Stripe; require acknowledge_active_subscription when
 * a billable Stripe subscription is already on file.
 */

import { getStripe } from './stripe-client.js';
import {
  loadBillingState,
  saveBillingState,
  withBillingLock,
} from './billing-file.js';
import { freePlanId, getPlan, loadPlansCatalog } from './plans.js';
import { applySubscriptionToBilling } from './webhooks.js';
import type { BillingState } from './types.js';
import { BillingHttpError } from './checkout.js';
import { assertValidSlug } from '../state/state-file.js';

function freeState(slug: string, base?: BillingState | null): BillingState {
  const catalog = loadPlansCatalog();
  return {
    version: 1,
    user_slug: slug,
    plan_id: freePlanId(catalog),
    status: 'none',
    stripe_customer_id: base?.stripe_customer_id ?? null,
    stripe_subscription_id: null,
    current_period_end: null,
    cancel_at_period_end: false,
    comped_by: null,
    comped_plan_id: null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Grant an admin-comped plan. Does not cancel Stripe (P6).
 */
export async function compUser(params: {
  slug: string;
  planId: string;
  adminUsername: string;
  acknowledgeActiveSubscription?: boolean;
}): Promise<BillingState> {
  assertValidSlug(params.slug);
  const catalog = loadPlansCatalog();
  getPlan(params.planId, catalog);

  return withBillingLock(params.slug, () => {
    const existing = loadBillingState(params.slug);
    if (
      existing?.stripe_subscription_id &&
      params.acknowledgeActiveSubscription !== true
    ) {
      throw new BillingHttpError(
        `User has Stripe subscription ${existing.stripe_subscription_id}. ` +
          `Pass acknowledge_active_subscription: true — Stripe may keep invoicing until canceled separately.`,
        400,
        'ack_required',
      );
    }

    const next: BillingState = {
      version: 1,
      user_slug: params.slug,
      plan_id: params.planId,
      status: 'comped',
      comped_plan_id: params.planId,
      comped_by: params.adminUsername,
      stripe_customer_id: existing?.stripe_customer_id ?? null,
      stripe_subscription_id: existing?.stripe_subscription_id ?? null,
      current_period_end: existing?.current_period_end ?? null,
      cancel_at_period_end: existing?.cancel_at_period_end ?? false,
      updated_at: new Date().toISOString(),
    };
    saveBillingState(next);
    return next;
  });
}

/**
 * Clear comp freeze, then restore from Stripe subscription or free.
 */
export async function revokeComp(slug: string): Promise<BillingState> {
  assertValidSlug(slug);
  return withBillingLock(slug, async () => {
    const existing = loadBillingState(slug);
    if (!existing || existing.status !== 'comped') {
      throw new BillingHttpError(
        `User ${slug} is not admin-comped`,
        400,
        'not_comped',
      );
    }

    // Drop freeze so applySubscription can write
    existing.status = 'none';
    existing.comped_by = null;
    existing.comped_plan_id = null;
    saveBillingState(existing);

    if (existing.stripe_subscription_id) {
      return pullAndApplySubscription(slug, existing);
    }
    const next = freeState(slug, existing);
    saveBillingState(next);
    return next;
  });
}

async function pullAndApplySubscription(
  slug: string,
  existing: BillingState,
): Promise<BillingState> {
  const stripe = getStripe();
  if (existing.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(existing.stripe_subscription_id);
      applySubscriptionToBilling(slug, sub, {
        customerId: existing.stripe_customer_id,
        eventId: `reconcile_${Date.now()}`,
      });
      return loadBillingState(slug) ?? freeState(slug, existing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No such subscription') || msg.includes('resource_missing')) {
        const next = freeState(slug, existing);
        saveBillingState(next);
        return next;
      }
      throw err;
    }
  }

  if (existing.stripe_customer_id) {
    const list = await stripe.subscriptions.list({
      customer: existing.stripe_customer_id,
      status: 'all',
      limit: 1,
    });
    if (list.data[0]) {
      applySubscriptionToBilling(slug, list.data[0], {
        customerId: existing.stripe_customer_id,
        eventId: `reconcile_${Date.now()}`,
      });
      return loadBillingState(slug) ?? freeState(slug, existing);
    }
  }

  const next = freeState(slug, existing);
  saveBillingState(next);
  return next;
}

/**
 * Force-sync billing file from Stripe. Clears comp freeze first so Stripe wins.
 */
export async function reconcileBilling(slug: string): Promise<BillingState> {
  assertValidSlug(slug);
  return withBillingLock(slug, async () => {
    const existing = loadBillingState(slug);
    if (!existing) {
      const next = freeState(slug);
      saveBillingState(next);
      return next;
    }
    // Clear comp so reconcile can apply Stripe truth
    if (existing.status === 'comped') {
      existing.status = 'none';
      existing.comped_by = null;
      existing.comped_plan_id = null;
      saveBillingState(existing);
    }
    return pullAndApplySubscription(slug, existing);
  });
}

export function getBillingAdminView(slug: string): BillingState | null {
  assertValidSlug(slug);
  return loadBillingState(slug);
}
