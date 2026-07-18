/**
 * Stripe webhook verification + deterministic apply + event-id store.
 *
 * Comp freezes plan/status mutations (P1); customer id linkage may still update (P2).
 * Unresolvable slug → throw (handler returns 5xx for Stripe retry).
 */

import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import {
  billingDir,
  loadBillingState,
  saveBillingState,
  withBillingLock,
} from './billing-file.js';
import type { BillingState, BillingStatus } from './types.js';
import { freePlanId, getPlan, loadPlansCatalog } from './plans.js';
import {
  eventAlreadyProcessed,
  markEventProcessed,
} from './events.js';
import { getStripe, getStripeWebhookSecret } from './stripe-client.js';

function mapStripeSubscriptionStatus(status: string): BillingStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
      return 'past_due';
    case 'unpaid':
      return 'unpaid';
    case 'canceled':
      return 'canceled';
    default:
      return 'none';
  }
}

/**
 * Stripe API 2025+ moved current_period_end onto subscription items.
 * Prefer max item period end; fall back to any top-level field if present.
 */
function periodEndIso(sub: Stripe.Subscription): string | null {
  const itemEnds = (sub.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((n): n is number => typeof n === 'number');
  if (itemEnds.length > 0) {
    return new Date(Math.max(...itemEnds) * 1000).toISOString();
  }
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === 'number') {
    return new Date(top * 1000).toISOString();
  }
  return null;
}

function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const parent = invoice.parent;
  if (parent?.type === 'subscription_details' && parent.subscription_details) {
    const sub = parent.subscription_details.subscription;
    if (typeof sub === 'string') return sub;
    if (sub && typeof sub === 'object' && 'id' in sub) return sub.id;
  }
  // Older API shape
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null })
    .subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy === 'object' && 'id' in legacy) return legacy.id;
  return null;
}

function priceIdFromSubscription(sub: Stripe.Subscription): string | null {
  const item = sub.items?.data?.[0];
  const price = item?.price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id;
}

function planIdFromPrice(priceId: string | null): string {
  const catalog = loadPlansCatalog();
  if (!priceId) {
    throw new Error('Subscription has no price id; cannot map plan');
  }
  for (const plan of Object.values(catalog.plans)) {
    if (plan.stripe_price_id === priceId) return plan.id;
  }
  throw new Error(`No plan maps to stripe price ${priceId}`);
}

/**
 * Resolve user slug from Stripe objects. Throws if unresolvable.
 */
export function resolveSlugFromStripe(params: {
  metadataSlug?: string | null;
  clientReferenceId?: string | null;
  customerId?: string | null;
  customerMetadataSlug?: string | null;
}): string {
  const candidates = [
    params.metadataSlug,
    params.clientReferenceId,
    params.customerMetadataSlug,
  ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

  if (candidates.length > 0) {
    const slug = candidates[0]!.trim();
    // If customer bound to another slug, fail
    if (params.customerId) {
      const bound = findSlugByCustomerId(params.customerId);
      if (bound && bound !== slug) {
        throw new Error(
          `Stripe customer ${params.customerId} already bound to slug "${bound}", event claims "${slug}"`,
        );
      }
    }
    return slug;
  }

  if (params.customerId) {
    const bound = findSlugByCustomerId(params.customerId);
    if (bound) return bound;
  }

  throw new Error('Cannot resolve utarus user slug from Stripe event');
}

export function findSlugByCustomerId(customerId: string): string | null {
  const dir = billingDir();
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue;
    const path = join(dir, name);
    try {
      const raw = parse(readFileSync(path, 'utf-8')) as { stripe_customer_id?: string; user_slug?: string };
      if (raw?.stripe_customer_id === customerId && raw.user_slug) {
        return raw.user_slug;
      }
    } catch {
      // skip corrupt; apply path will fail elsewhere if needed
    }
  }
  return null;
}

function emptyFreeState(slug: string, customerId?: string | null): BillingState {
  const catalog = loadPlansCatalog();
  return {
    version: 1,
    user_slug: slug,
    plan_id: freePlanId(catalog),
    status: 'none',
    stripe_customer_id: customerId ?? null,
    stripe_subscription_id: null,
    current_period_end: null,
    cancel_at_period_end: false,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Apply full subscription snapshot (deterministic). Respects comp freeze.
 */
export function applySubscriptionToBilling(
  slug: string,
  sub: Stripe.Subscription,
  opts?: { customerId?: string | null; eventId?: string },
): void {
  const existing = loadBillingState(slug);
  const customerId =
    opts?.customerId ||
    (typeof sub.customer === 'string' ? sub.customer : sub.customer?.id) ||
    existing?.stripe_customer_id ||
    null;

  if (existing?.status === 'comped') {
    console.log(
      `[billing/webhook] skipped plan mutate (comped) slug=${slug} event=${opts?.eventId ?? ''}`,
    );
    if (customerId && existing.stripe_customer_id !== customerId) {
      existing.stripe_customer_id = customerId;
      if (opts?.eventId) existing.last_stripe_event_id = opts.eventId;
      saveBillingState(existing);
    }
    return;
  }

  if (sub.status === 'canceled' && !sub.cancel_at_period_end) {
    // Fully deleted / canceled — free
    const next = emptyFreeState(slug, customerId);
    next.status = 'canceled';
    next.current_period_end = periodEndIso(sub);
    next.stripe_subscription_id = null;
    if (opts?.eventId) next.last_stripe_event_id = opts.eventId;
    saveBillingState(next);
    return;
  }

  const priceId = priceIdFromSubscription(sub);
  const planId = planIdFromPrice(priceId);
  getPlan(planId); // fail-fast unknown

  const next: BillingState = {
    version: 1,
    user_slug: slug,
    plan_id: planId,
    status: mapStripeSubscriptionStatus(sub.status),
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    current_period_end: periodEndIso(sub),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    updated_at: new Date().toISOString(),
    last_stripe_event_id: opts?.eventId ?? existing?.last_stripe_event_id ?? null,
  };
  saveBillingState(next);
}

export async function applyStripeEvent(event: Stripe.Event): Promise<string | undefined> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId =
        typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id ?? null;
      const slug = resolveSlugFromStripe({
        metadataSlug: session.metadata?.utarus_user_slug,
        clientReferenceId: session.client_reference_id,
        customerId,
      });
      return withBillingLock(slug, async () => {
        const existing = loadBillingState(slug);
        if (existing?.status === 'comped') {
          console.log(
            `[billing/webhook] skipped plan mutate (comped) slug=${slug} event=${event.id}`,
          );
          if (customerId && existing.stripe_customer_id !== customerId) {
            existing.stripe_customer_id = customerId;
            existing.last_stripe_event_id = event.id;
            saveBillingState(existing);
          }
          return slug;
        }
        if (customerId) {
          const cur = existing ?? emptyFreeState(slug, customerId);
          cur.stripe_customer_id = customerId;
          cur.last_stripe_event_id = event.id;
          saveBillingState(cur);
        }
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (subId) {
          const sub = await getStripe().subscriptions.retrieve(subId);
          applySubscriptionToBilling(slug, sub, {
            customerId,
            eventId: event.id,
          });
        }
        return slug;
      });
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
      const slug = resolveSlugFromStripe({
        metadataSlug: sub.metadata?.utarus_user_slug,
        customerId,
      });
      return withBillingLock(slug, () => {
        applySubscriptionToBilling(slug, sub, { customerId, eventId: event.id });
        return slug;
      });
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
      const slug = resolveSlugFromStripe({
        metadataSlug: sub.metadata?.utarus_user_slug,
        customerId,
      });
      return withBillingLock(slug, () => {
        const existing = loadBillingState(slug);
        if (existing?.status === 'comped') {
          console.log(
            `[billing/webhook] skipped plan mutate (comped) slug=${slug} event=${event.id}`,
          );
          return slug;
        }
        const next = emptyFreeState(slug, customerId ?? existing?.stripe_customer_id);
        next.status = 'canceled';
        next.current_period_end = periodEndIso(sub);
        next.last_stripe_event_id = event.id;
        saveBillingState(next);
        return slug;
      });
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer?.id ?? null;
      const subId = subscriptionIdFromInvoice(invoice);
      if (!subId) return undefined;
      const slug = resolveSlugFromStripe({
        metadataSlug: invoice.metadata?.utarus_user_slug,
        customerId,
      });
      return withBillingLock(slug, async () => {
        const existing = loadBillingState(slug);
        if (existing?.status === 'comped') {
          console.log(
            `[billing/webhook] skipped plan mutate (comped) slug=${slug} event=${event.id}`,
          );
          return slug;
        }
        const sub = await getStripe().subscriptions.retrieve(subId);
        applySubscriptionToBilling(slug, sub, { customerId, eventId: event.id });
        return slug;
      });
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === 'string'
          ? invoice.customer
          : invoice.customer?.id ?? null;
      const slug = resolveSlugFromStripe({
        metadataSlug: invoice.metadata?.utarus_user_slug,
        customerId,
      });
      return withBillingLock(slug, () => {
        const existing = loadBillingState(slug);
        if (!existing) {
          throw new Error(`payment_failed for unknown user slug=${slug}`);
        }
        if (existing.status === 'comped') {
          console.log(
            `[billing/webhook] skipped plan mutate (comped) slug=${slug} event=${event.id}`,
          );
          return slug;
        }
        existing.status = 'past_due';
        existing.last_stripe_event_id = event.id;
        saveBillingState(existing);
        return slug;
      });
    }

    default:
      // Unknown type: verified, no apply
      return undefined;
  }
}

/**
 * Express handler for POST /api/billing/webhook (raw body required).
 */
export async function billingWebhookHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const sig = req.headers['stripe-signature'];
  if (!sig || typeof sig !== 'string') {
    res.status(400).send('Missing stripe-signature');
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    console.error(
      '[billing/webhook] body is not a Buffer — middleware order wrong (need express.raw before json)',
    );
    res.status(500).send('Webhook misconfigured');
    return;
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      sig,
      getStripeWebhookSecret(),
    );
  } catch (err) {
    console.warn(
      `[billing/webhook] signature verify failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.status(400).send('Invalid signature');
    return;
  }

  if (eventAlreadyProcessed(event.id)) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    const slug = await applyStripeEvent(event);
    markEventProcessed(event.id, event.type, slug);
    res.json({ received: true });
  } catch (err) {
    console.error(
      `[billing/webhook] apply failed type=${event.type} id=${event.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // 5xx so Stripe retries
    res.status(500).json({
      error: 'apply_failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
