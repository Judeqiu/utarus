import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import type Stripe from 'stripe';
import {
  applyStripeEvent,
  applySubscriptionToBilling,
  eventAlreadyProcessed,
  markEventProcessed,
  loadBillingState,
  getEntitlement,
  setBillingExtension,
  resetPlansCacheForTests,
  setStripeClientForTests,
  type PlansCatalogInput,
} from '../src/billing/index.js';

let tmp: string;
let prevEnv: Record<string, string | undefined>;

const PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 7,
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: { llm_total_tokens: 1000 },
      features: [],
    },
    pro: {
      display_name: 'Pro',
      stripe_price_id: 'price_pro_test',
      caps: { llm_total_tokens: 50_000 },
      features: ['html_reports'],
    },
  },
};

function fakeSub(overrides: Partial<Stripe.Subscription> & { id?: string } = {}): Stripe.Subscription {
  const periodEnd = Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000);
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    metadata: { utarus_user_slug: 'alice' },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_1',
          object: 'subscription_item',
          current_period_end: periodEnd,
          current_period_start: periodEnd - 30 * 86400,
          price: { id: 'price_pro_test', object: 'price' },
        } as Stripe.SubscriptionItem,
      ],
      has_more: false,
      url: '',
    },
    ...overrides,
  } as Stripe.Subscription;
}

beforeEach(() => {
  prevEnv = {
    UTARUS_DATA_ROOT: process.env.UTARUS_DATA_ROOT,
    UTARUS_BILLING_ENABLED: process.env.UTARUS_BILLING_ENABLED,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    UTARUS_PUBLIC_BASE_URL: process.env.UTARUS_PUBLIC_BASE_URL,
  };
  tmp = mkdtempSync(join(tmpdir(), 'utarus-billing-wh-'));
  process.env.UTARUS_DATA_ROOT = tmp;
  process.env.UTARUS_BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  process.env.UTARUS_PUBLIC_BASE_URL = 'https://agent.example.com';
  resetPlansCacheForTests();
  setBillingExtension({ plans: PLANS });
  setStripeClientForTests(null);
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPlansCacheForTests();
  setStripeClientForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

describe('event store', () => {
  it('marks and detects processed events', () => {
    expect(eventAlreadyProcessed('evt_1')).toBe(false);
    markEventProcessed('evt_1', 'customer.subscription.updated', 'alice');
    expect(eventAlreadyProcessed('evt_1')).toBe(true);
    expect(existsSync(join(tmp, 'billing', 'events', 'evt_1.json'))).toBe(true);
  });
});

describe('applySubscriptionToBilling', () => {
  it('writes paid entitlement from subscription snapshot', () => {
    applySubscriptionToBilling('alice', fakeSub(), { eventId: 'evt_a' });
    const state = loadBillingState('alice');
    expect(state?.plan_id).toBe('pro');
    expect(state?.status).toBe('active');
    expect(state?.stripe_subscription_id).toBe('sub_1');
    expect(state?.stripe_customer_id).toBe('cus_1');
    expect(getEntitlement('alice').plan_id).toBe('pro');
  });

  it('maps trialing to paid caps', () => {
    applySubscriptionToBilling('alice', fakeSub({ status: 'trialing' }));
    expect(getEntitlement('alice').status).toBe('trialing');
    expect(getEntitlement('alice').plan_id).toBe('pro');
  });

  it('freezes plan mutations when comped (P1)', () => {
    mkdirSync(join(tmp, 'billing'), { recursive: true });
    writeFileSync(
      join(tmp, 'billing', 'alice.yaml'),
      stringify({
        version: 1,
        user_slug: 'alice',
        plan_id: 'pro',
        status: 'comped',
        comped_plan_id: 'pro',
        comped_by: 'admin',
        updated_at: '2026-07-01T00:00:00.000Z',
      }),
      'utf-8',
    );
    applySubscriptionToBilling(
      'alice',
      fakeSub({
        status: 'canceled',
        id: 'sub_other',
        customer: 'cus_new',
      }),
      { eventId: 'evt_comp' },
    );
    const state = loadBillingState('alice');
    expect(state?.status).toBe('comped');
    expect(state?.plan_id).toBe('pro');
    // customer id may update while comped
    expect(state?.stripe_customer_id).toBe('cus_new');
  });

  it('clears to free on fully canceled subscription', () => {
    applySubscriptionToBilling('alice', fakeSub({ status: 'active' }));
    applySubscriptionToBilling(
      'alice',
      fakeSub({ status: 'canceled', cancel_at_period_end: false }),
    );
    const state = loadBillingState('alice');
    expect(state?.plan_id).toBe('free');
    expect(state?.stripe_subscription_id).toBeNull();
  });
});

describe('applyStripeEvent', () => {
  it('applies subscription.updated from fixture event', async () => {
    const event = {
      id: 'evt_sub_upd',
      type: 'customer.subscription.updated',
      data: { object: fakeSub({ status: 'past_due' }) },
    } as Stripe.Event;

    const slug = await applyStripeEvent(event);
    expect(slug).toBe('alice');
    expect(loadBillingState('alice')?.status).toBe('past_due');
  });

  it('subscription.deleted clears paid state', async () => {
    applySubscriptionToBilling('alice', fakeSub());
    const event = {
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: { object: fakeSub({ status: 'canceled' }) },
    } as Stripe.Event;
    await applyStripeEvent(event);
    expect(loadBillingState('alice')?.plan_id).toBe('free');
  });

  it('throws when slug cannot be resolved (5xx path)', async () => {
    const event = {
      id: 'evt_bad',
      type: 'customer.subscription.updated',
      data: {
        object: fakeSub({
          metadata: {},
          customer: 'cus_unknown',
        }),
      },
    } as Stripe.Event;
    await expect(applyStripeEvent(event)).rejects.toThrow(/Cannot resolve/);
  });
});
