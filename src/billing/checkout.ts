/**
 * Stripe Checkout + Customer Portal session creation.
 * userSlug always from authenticated session — never from client body for identity.
 */

import { loadState } from '../state/index.js';
import { getEntitlement } from './entitlements.js';
import { loadBillingState, saveBillingState } from './billing-file.js';
import { freePlanId, getPlan, loadPlansCatalog } from './plans.js';
import { getStripe } from './stripe-client.js';
import { TRIAL_PERIOD_DAYS } from './types.js';
import { publicBillingBaseUrl } from './messages.js';
import { isBillingEnabled } from './validate.js';

export class BillingHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BillingHttpError';
  }
}

function requirePublicBase(): string {
  const base = publicBillingBaseUrl();
  if (!base) {
    throw new BillingHttpError(
      'UTARUS_PUBLIC_BASE_URL is required for Checkout',
      500,
      'config_error',
    );
  }
  return base;
}

/**
 * True when user should manage via Portal instead of starting Checkout.
 */
export function isCheckoutBlocked(userSlug: string): {
  blocked: boolean;
  reason?: string;
} {
  const ent = getEntitlement(userSlug);
  if (ent.status === 'comped') {
    return {
      blocked: true,
      reason:
        'Admin-comped plan active; contact support or wait for revocation before Checkout.',
    };
  }
  if (
    (ent.status === 'active' ||
      ent.status === 'trialing' ||
      ent.status === 'past_due') &&
    ent.stripe_subscription_id
  ) {
    return {
      blocked: true,
      reason:
        'You already have an active subscription. Use the Customer Portal to manage it.',
    };
  }
  return { blocked: false };
}

/**
 * Create Checkout Session for the default paid plan (7-day trial, no tax).
 * Optional body plan_id must equal default_paid_plan_id when provided.
 */
export async function createCheckoutSessionUrl(
  userSlug: string,
  bodyPlanId?: string,
): Promise<string> {
  if (!isBillingEnabled()) {
    throw new BillingHttpError('Billing is not enabled', 404, 'billing_disabled');
  }

  const catalog = loadPlansCatalog();
  const paidId = catalog.default_paid_plan_id;
  if (bodyPlanId !== undefined && bodyPlanId !== paidId) {
    throw new BillingHttpError(
      `Only plan_id "${paidId}" is available for Checkout in v1`,
      400,
      'invalid_plan',
    );
  }

  const block = isCheckoutBlocked(userSlug);
  if (block.blocked) {
    throw new BillingHttpError(block.reason!, 409, 'checkout_blocked');
  }

  const paid = getPlan(paidId, catalog);
  if (!paid.stripe_price_id) {
    throw new BillingHttpError(
      `Paid plan "${paidId}" has no stripe_price_id`,
      500,
      'config_error',
    );
  }

  const user = loadState(userSlug);
  const email = user.profile.contact_email;
  if (!email?.trim()) {
    throw new BillingHttpError(
      'User profile is missing contact_email required for Checkout',
      400,
      'missing_email',
    );
  }

  const base = requirePublicBase();
  const existing = loadBillingState(userSlug);
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: existing?.stripe_customer_id || undefined,
    customer_email: existing?.stripe_customer_id ? undefined : email,
    client_reference_id: userSlug,
    line_items: [{ price: paid.stripe_price_id, quantity: 1 }],
    success_url: `${base}/billing?checkout=success`,
    cancel_url: `${base}/billing?checkout=cancel`,
    metadata: { utarus_user_slug: userSlug, plan_id: paidId },
    subscription_data: {
      trial_period_days: TRIAL_PERIOD_DAYS,
      metadata: { utarus_user_slug: userSlug, plan_id: paidId },
    },
  });

  if (!session.url) {
    throw new BillingHttpError(
      'Stripe Checkout Session missing url',
      502,
      'stripe_error',
    );
  }

  // Persist customer id early when Stripe created one on the session object
  if (session.customer && typeof session.customer === 'string') {
    const cur = loadBillingState(userSlug);
    if (!cur) {
      saveBillingState({
        version: 1,
        user_slug: userSlug,
        plan_id: freePlanId(catalog),
        status: 'none',
        stripe_customer_id: session.customer,
        updated_at: new Date().toISOString(),
      });
    } else if (!cur.stripe_customer_id) {
      cur.stripe_customer_id = session.customer;
      saveBillingState(cur);
    }
  }

  return session.url;
}

export async function createPortalSessionUrl(userSlug: string): Promise<string> {
  if (!isBillingEnabled()) {
    throw new BillingHttpError('Billing is not enabled', 404, 'billing_disabled');
  }

  const existing = loadBillingState(userSlug);
  if (!existing?.stripe_customer_id) {
    throw new BillingHttpError(
      'No Stripe customer on file. Complete Checkout first.',
      400,
      'no_customer',
    );
  }

  const base = requirePublicBase();
  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: existing.stripe_customer_id,
    return_url: `${base}/billing`,
  });
  if (!session.url) {
    throw new BillingHttpError(
      'Stripe Portal Session missing url',
      502,
      'stripe_error',
    );
  }
  return session.url;
}
