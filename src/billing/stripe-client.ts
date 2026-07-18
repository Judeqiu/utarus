/**
 * Stripe SDK wrapper — fail-fast when billing is enabled and keys are missing.
 */

import Stripe from 'stripe';
import { isBillingEnabled } from './validate.js';

let stripeSingleton: Stripe | null = null;

/** Override for tests. Pass null to clear. */
export function setStripeClientForTests(client: Stripe | null): void {
  stripeSingleton = client;
}

export function getStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is required when billing is enabled');
  }
  return key;
}

export function getStripeWebhookSecret(): string {
  const key = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!key) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required when billing is enabled');
  }
  return key;
}

export function getStripePublishableKey(): string | undefined {
  const key = process.env.STRIPE_PUBLISHABLE_KEY?.trim();
  return key || undefined;
}

/**
 * Shared Stripe client. Throws if billing is off or secret key missing.
 */
export function getStripe(): Stripe {
  if (!isBillingEnabled()) {
    throw new Error('getStripe requires UTARUS_BILLING_ENABLED=true');
  }
  if (stripeSingleton) return stripeSingleton;
  stripeSingleton = new Stripe(getStripeSecretKey());
  return stripeSingleton;
}
