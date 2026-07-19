import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import {
  INTRO_TRIAL_DAYS,
  STRIPE_TRIAL_DAYS,
  TRIAL_PERIOD_DAYS,
  isBillingEnabled,
  assertBillingConfig,
  assertPlansCatalog,
  setBillingExtension,
  resetPlansCacheForTests,
  loadPlansCatalog,
  freePlanId,
  loadBillingState,
  saveBillingState,
  entitlementFromBillingState,
  getEntitlement,
  getEffectiveCap,
  hasFeature,
  type BillingState,
  type PlansCatalogInput,
} from '../src/billing/index.js';
import { getCapOverride } from '../src/usage/index.js';

let tmp: string;
let prevEnv: Record<string, string | undefined>;

const VALID_PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 30,
  intro_trial_days: 7,
  intro_caps: {
    llm_total_tokens: 500_000,
    tools: { firecrawl: 50, post_html_report: 10 },
  },
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: {
        // Post-intro: no use until Upgrade
        llm_total_tokens: 0,
        tools: { firecrawl: 0, post_html_report: 0 },
      },
      features: [],
    },
    pro: {
      display_name: 'Pro',
      stripe_price_id: 'price_pro_test',
      caps: {
        llm_total_tokens: 5_000_000,
        tools: { firecrawl: 500, post_html_report: 100 },
      },
      features: ['html_reports'],
    },
  },
};

function writeUser(slug: string, createdAt: string, opts?: { beta?: boolean }): void {
  writeDataFile(`users/${slug}.yaml`, {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      slug,
      created_at: createdAt,
      ...(opts?.beta === true ? { beta: true } : {}),
    },
    profile: {
      display_name: slug,
      contact_email: `${slug}@example.com`,
    },
    log: [],
  });
}

function envSnapshot(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function enableBillingEnv(): void {
  process.env.UTARUS_BILLING_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  process.env.UTARUS_PUBLIC_BASE_URL = 'https://agent.example.com';
}

function writeDataFile(rel: string, data: unknown): void {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, stringify(data), 'utf-8');
}

function billingState(overrides: Partial<BillingState> = {}): BillingState {
  return {
    version: 1,
    user_slug: 'alice',
    plan_id: 'pro',
    status: 'active',
    current_period_end: '2099-01-01T00:00:00.000Z',
    cancel_at_period_end: false,
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  prevEnv = envSnapshot([
    'UTARUS_DATA_ROOT',
    'UTARUS_BILLING_ENABLED',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PUBLISHABLE_KEY',
    'UTARUS_PUBLIC_BASE_URL',
  ]);
  tmp = mkdtempSync(join(tmpdir(), 'utarus-billing-test-'));
  process.env.UTARUS_DATA_ROOT = tmp;
  delete process.env.UTARUS_BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PUBLISHABLE_KEY;
  delete process.env.UTARUS_PUBLIC_BASE_URL;
  resetPlansCacheForTests();
});

afterEach(() => {
  restoreEnv(prevEnv);
  resetPlansCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

describe('isBillingEnabled', () => {
  it('is true only when UTARUS_BILLING_ENABLED is exactly "true"', () => {
    expect(isBillingEnabled()).toBe(false);
    process.env.UTARUS_BILLING_ENABLED = '1';
    expect(isBillingEnabled()).toBe(false);
    process.env.UTARUS_BILLING_ENABLED = 'true';
    expect(isBillingEnabled()).toBe(true);
  });
});

describe('assertPlansCatalog', () => {
  it('accepts a valid catalog and fills plan ids', () => {
    const cat = assertPlansCatalog(VALID_PLANS, 'test');
    expect(cat.trial_period_days).toBe(STRIPE_TRIAL_DAYS);
    expect(cat.trial_period_days).toBe(TRIAL_PERIOD_DAYS);
    expect(cat.intro_trial_days).toBe(INTRO_TRIAL_DAYS);
    expect(cat.intro_caps.llm_total_tokens).toBe(500_000);
    expect(cat.plans.free.id).toBe('free');
    expect(cat.plans.pro.stripe_price_id).toBe('price_pro_test');
    expect(freePlanId(cat)).toBe('free');
  });

  it('rejects wrong trial_period_days (must be Stripe 30)', () => {
    expect(() =>
      assertPlansCatalog({ ...VALID_PLANS, trial_period_days: 7 as 30 }, 'test'),
    ).toThrow(/trial_period_days must be 30/);
  });

  it('rejects wrong intro_trial_days', () => {
    expect(() =>
      assertPlansCatalog({ ...VALID_PLANS, intro_trial_days: 14 as 7 }, 'test'),
    ).toThrow(/intro_trial_days must be 7/);
  });

  it('rejects intro_caps >= paid llm cap', () => {
    expect(() =>
      assertPlansCatalog(
        {
          ...VALID_PLANS,
          intro_caps: { llm_total_tokens: 5_000_000 },
        },
        'test',
      ),
    ).toThrow(/intro_caps.llm_total_tokens/);
  });

  it('rejects zero free plans', () => {
    const plans = {
      ...VALID_PLANS,
      plans: {
        pro: VALID_PLANS.plans.pro,
      },
    };
    expect(() => assertPlansCatalog(plans, 'test')).toThrow(/exactly one free plan/);
  });

  it('rejects default_paid_plan_id pointing at free', () => {
    expect(() =>
      assertPlansCatalog({ ...VALID_PLANS, default_paid_plan_id: 'free' }, 'test'),
    ).toThrow(/must be a paid plan/);
  });

  it('rejects missing llm_total_tokens on a plan', () => {
    const bad = structuredClone(VALID_PLANS);
    // @ts-expect-error intentional
    delete bad.plans.free.caps.llm_total_tokens;
    expect(() => assertPlansCatalog(bad, 'test')).toThrow(/llm_total_tokens/);
  });

  it('rejects duplicate stripe_price_id', () => {
    const bad = structuredClone(VALID_PLANS);
    bad.plans.team = {
      display_name: 'Team',
      stripe_price_id: 'price_pro_test',
      caps: { llm_total_tokens: 1 },
      features: [],
    };
    expect(() => assertPlansCatalog(bad, 'test')).toThrow(/Duplicate stripe_price_id/);
  });
});

describe('loadPlansCatalog resolution', () => {
  it('uses extension plans when set (wins over file)', () => {
    writeDataFile('config/plans.yaml', {
      ...VALID_PLANS,
      plans: {
        free: {
          display_name: 'File Free',
          stripe_price_id: null,
          caps: { llm_total_tokens: 1 },
        },
        pro: {
          display_name: 'File Pro',
          stripe_price_id: 'price_file',
          caps: { llm_total_tokens: 2 },
        },
      },
    });
    setBillingExtension({
      plans: {
        ...VALID_PLANS,
        intro_caps: { llm_total_tokens: 50 },
        plans: {
          free: {
            display_name: 'Ext Free',
            stripe_price_id: null,
            caps: { llm_total_tokens: 0 },
          },
          pro: {
            display_name: 'Ext Pro',
            stripe_price_id: 'price_ext',
            caps: { llm_total_tokens: 200 },
          },
        },
      },
    });
    const cat = loadPlansCatalog();
    expect(cat.plans.free.display_name).toBe('Ext Free');
    expect(cat.plans.free.caps.llm_total_tokens).toBe(0);
    expect(cat.intro_caps.llm_total_tokens).toBe(50);
  });

  it('loads from plans.yaml when extension has no plans', () => {
    writeDataFile('config/plans.yaml', VALID_PLANS);
    setBillingExtension(undefined);
    const cat = loadPlansCatalog();
    expect(cat.default_paid_plan_id).toBe('pro');
    expect(cat.plans.pro.caps.llm_total_tokens).toBe(5_000_000);
  });

  it('fails when neither extension nor file provides plans', () => {
    setBillingExtension(undefined);
    expect(() => loadPlansCatalog()).toThrow(/not found/);
  });
});

describe('billing file load/save', () => {
  it('returns null when file is missing (implicit free)', () => {
    expect(loadBillingState('alice')).toBeNull();
  });

  it('round-trips atomically and preserves unknown keys', () => {
    const state = billingState({
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      // @ts-expect-error preserve domain-ish key
      custom_marker: 'keep-me',
    } as BillingState & { custom_marker: string });
    saveBillingState(state);
    expect(existsSync(join(tmp, 'billing', 'alice.yaml'))).toBe(true);

    const loaded = loadBillingState('alice');
    expect(loaded?.plan_id).toBe('pro');
    expect(loaded?.stripe_customer_id).toBe('cus_1');
    expect((loaded as BillingState & { custom_marker?: string })?.custom_marker).toBe(
      'keep-me',
    );

    // Atomic path should not leave .tmp files
    const leftovers = readdirSync(join(tmp, 'billing')).filter((n) =>
      n.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('rejects slug mismatch between body and filename', () => {
    writeDataFile('billing/alice.yaml', billingState({ user_slug: 'bob' }));
    expect(() => loadBillingState('alice')).toThrow(/does not match filename/);
  });

  it('rejects invalid status', () => {
    writeDataFile('billing/alice.yaml', billingState({ status: 'nope' as 'active' }));
    expect(() => loadBillingState('alice')).toThrow(/invalid status/);
  });
});

describe('entitlementFromBillingState — period expiry matrix', () => {
  const now = new Date('2026-07-18T12:00:00.000Z');
  const future = '2026-08-18T00:00:00.000Z';
  const past = '2026-06-01T00:00:00.000Z';
  const catalog = assertPlansCatalog(VALID_PLANS, 'matrix');

  it.each([
    {
      name: 'past_due + future → paid (grace)',
      status: 'past_due' as const,
      end: future,
      expectPlan: 'pro',
      expectSource: 'stripe',
    },
    {
      name: 'past_due + past → free',
      status: 'past_due' as const,
      end: past,
      expectPlan: 'free',
      expectSource: 'period_expired_read',
    },
    {
      name: 'canceled + future → paid',
      status: 'canceled' as const,
      end: future,
      expectPlan: 'pro',
      expectSource: 'stripe',
    },
    {
      name: 'canceled + past → free',
      status: 'canceled' as const,
      end: past,
      expectPlan: 'free',
      expectSource: 'period_expired_read',
    },
    {
      name: 'unpaid + future → paid',
      status: 'unpaid' as const,
      end: future,
      expectPlan: 'pro',
      expectSource: 'stripe',
    },
    {
      name: 'unpaid + past → free',
      status: 'unpaid' as const,
      end: past,
      expectPlan: 'free',
      expectSource: 'period_expired_read',
    },
    {
      name: 'active + future → paid',
      status: 'active' as const,
      end: future,
      expectPlan: 'pro',
      expectSource: 'stripe',
    },
    {
      name: 'trialing + future → paid',
      status: 'trialing' as const,
      end: future,
      expectPlan: 'pro',
      expectSource: 'stripe',
    },
    {
      name: 'comped + past period end → still comp plan',
      status: 'comped' as const,
      end: past,
      expectPlan: 'pro',
      expectSource: 'admin_comp',
    },
  ])('$name', ({ status, end, expectPlan, expectSource }) => {
    const raw = billingState({
      status,
      plan_id: 'pro',
      comped_plan_id: status === 'comped' ? 'pro' : null,
      current_period_end: end,
    });
    const ent = entitlementFromBillingState(raw, catalog, now);
    expect(ent.plan_id).toBe(expectPlan);
    expect(ent.source).toBe(expectSource);
  });

  it('null billing state → free default_free', () => {
    const ent = entitlementFromBillingState(null, catalog, now);
    expect(ent.plan_id).toBe('free');
    expect(ent.source).toBe('default_free');
    expect(ent.status).toBe('none');
  });

  it('active + cancel_at_period_end + past end → free', () => {
    const raw = billingState({
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: past,
    });
    const ent = entitlementFromBillingState(raw, catalog, now);
    expect(ent.plan_id).toBe('free');
    expect(ent.source).toBe('period_expired_read');
  });

  it('active + cancel_at_period_end false + past end → still paid (renewing)', () => {
    const raw = billingState({
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: past,
    });
    const ent = entitlementFromBillingState(raw, catalog, now);
    expect(ent.plan_id).toBe('pro');
    expect(ent.source).toBe('stripe');
  });
});

describe('getEntitlement / getEffectiveCap / hasFeature', () => {
  beforeEach(() => {
    enableBillingEnv();
    setBillingExtension({ plans: VALID_PLANS });
  });

  it('getEntitlement throws when billing disabled', () => {
    delete process.env.UTARUS_BILLING_ENABLED;
    expect(() => getEntitlement('alice')).toThrow(/UTARUS_BILLING_ENABLED/);
  });

  it('no user file → free (no intro) with zero free caps', () => {
    const ent = getEntitlement('alice');
    expect(ent.plan_id).toBe('free');
    expect(ent.source).toBe('default_free');
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(0);
    expect(hasFeature('alice', 'html_reports')).toBe(false);
  });

  it('intro trial within 7 days of created_at → intro_caps', () => {
    const created = new Date();
    created.setUTCDate(created.getUTCDate() - 1);
    const ymd = created.toISOString().slice(0, 10);
    writeUser('alice', ymd);
    const ent = getEntitlement('alice');
    expect(ent.source).toBe('intro_trial');
    expect(ent.status).toBe('trialing');
    expect(ent.plan_id).toBe('pro');
    expect(ent.display_name).toBe('Intro trial');
    expect(ent.intro_trial_ends_at).toBeTruthy();
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(500_000);
    expect(getEffectiveCap('alice', 'tools.firecrawl')).toBe(50);
    expect(hasFeature('alice', 'html_reports')).toBe(true);
  });

  it('after intro window → free zero caps', () => {
    writeUser('alice', '2020-01-01');
    const ent = getEntitlement('alice');
    expect(ent.source).toBe('default_free');
    expect(ent.plan_id).toBe('free');
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(0);
    expect(hasFeature('alice', 'html_reports')).toBe(false);
  });

  it('user.beta → unlimited caps, no expiry (even if created long ago)', () => {
    writeUser('alice', '2020-01-01', { beta: true });
    const ent = getEntitlement('alice');
    expect(ent.source).toBe('beta');
    expect(ent.display_name).toBe('Beta');
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBeUndefined();
    expect(getEffectiveCap('alice', 'tools.firecrawl')).toBeUndefined();
    expect(hasFeature('alice', 'html_reports')).toBe(true);
  });

  it('Stripe trialing uses full pro caps (not intro_caps)', () => {
    writeUser('alice', '2020-01-01');
    saveBillingState(
      billingState({
        status: 'trialing',
        plan_id: 'pro',
        current_period_end: '2099-01-01T00:00:00.000Z',
      }),
    );
    expect(getEntitlement('alice').source).toBe('stripe');
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(5_000_000);
  });

  it('paid plan caps when active', () => {
    writeUser('alice', '2020-01-01');
    saveBillingState(billingState({ status: 'active', plan_id: 'pro' }));
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(5_000_000);
    expect(hasFeature('alice', 'html_reports')).toBe(true);
  });

  it('caps.yaml overrides win over plan caps', () => {
    saveBillingState(billingState({ status: 'active', plan_id: 'pro' }));
    writeDataFile('config/caps.yaml', {
      overrides: {
        alice: {
          llm_total_tokens: 99,
          tools: { firecrawl: 3 },
        },
      },
    });
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(99);
    expect(getEffectiveCap('alice', 'tools.firecrawl')).toBe(3);
    // Tool not in override falls through to plan
    expect(getEffectiveCap('alice', 'tools.post_html_report')).toBe(100);
  });

  it('getCapOverride ignores default section', () => {
    writeDataFile('config/caps.yaml', {
      default: { llm_total_tokens: 1 },
      overrides: { alice: { llm_total_tokens: 50 } },
    });
    expect(getCapOverride('alice', 'llm_total_tokens')).toBe(50);
    expect(getCapOverride('bob', 'llm_total_tokens')).toBeUndefined();
  });

  it('billing off: getEffectiveCap uses legacy getCap (default + override)', () => {
    delete process.env.UTARUS_BILLING_ENABLED;
    writeDataFile('config/caps.yaml', {
      default: { llm_total_tokens: 1000 },
      overrides: { alice: { llm_total_tokens: 2000 } },
    });
    expect(getEffectiveCap('alice', 'llm_total_tokens')).toBe(2000);
    expect(getEffectiveCap('bob', 'llm_total_tokens')).toBe(1000);
  });

  it('hasFeature returns false when billing disabled', () => {
    delete process.env.UTARUS_BILLING_ENABLED;
    expect(hasFeature('alice', 'html_reports')).toBe(false);
  });

  it('hasFeature fails fast on empty flag', () => {
    expect(() => hasFeature('alice', '')).toThrow(/non-empty flag/);
  });
});

describe('assertBillingConfig', () => {
  it('no-ops when billing disabled', () => {
    expect(() => assertBillingConfig({ billing: undefined })).not.toThrow();
  });

  it('fails when secrets missing', () => {
    process.env.UTARUS_BILLING_ENABLED = 'true';
    expect(() =>
      assertBillingConfig({ billing: { plans: VALID_PLANS } }),
    ).toThrow(/missing required env/);
  });

  it('fails when caps.yaml has default', () => {
    enableBillingEnv();
    writeDataFile('config/caps.yaml', {
      default: { llm_total_tokens: 1 },
    });
    expect(() =>
      assertBillingConfig({ billing: { plans: VALID_PLANS } }),
    ).toThrow(/must not define "default"/);
  });

  it('fails when capHitTemplate missing placeholders', () => {
    enableBillingEnv();
    expect(() =>
      assertBillingConfig({
        billing: {
          plans: VALID_PLANS,
          copy: { capHitTemplate: 'hit {current} of {cap}' },
        },
      }),
    ).toThrow(/\{upgradeUrl\}/);
  });

  it('accepts valid extension plans + overrides-only caps', () => {
    enableBillingEnv();
    writeDataFile('config/caps.yaml', {
      overrides: { alice: { llm_total_tokens: 9 } },
    });
    expect(() =>
      assertBillingConfig({
        billing: {
          plans: VALID_PLANS,
          copy: {
            capHitTemplate: '{current}/{cap} → {upgradeUrl}',
            upgradeCta: 'Upgrade to Pro',
          },
        },
      }),
    ).not.toThrow();
    expect(loadPlansCatalog().plans.pro.display_name).toBe('Pro');
  });

  it('requires publishable key when requirePublishableKey', () => {
    enableBillingEnv();
    expect(() =>
      assertBillingConfig(
        { billing: { plans: VALID_PLANS } },
        { requirePublishableKey: true },
      ),
    ).toThrow(/STRIPE_PUBLISHABLE_KEY/);
  });
});

describe('createFramework billing boot', () => {
  it('throws from createFramework when billing on without secrets', async () => {
    process.env.UTARUS_BILLING_ENABLED = 'true';
    const { createFramework } = await import('../src/framework.js');
    expect(() =>
      createFramework({
        extension: {
          purpose: 'test',
          tools: [],
          skills: [],
          billing: { plans: VALID_PLANS },
        },
      }),
    ).toThrow(/missing required env/);
  });

  it('boots when billing on with secrets + plans', async () => {
    enableBillingEnv();
    const { createFramework } = await import('../src/framework.js');
    const fw = createFramework({
      extension: {
        purpose: 'test',
        tools: [],
        skills: [],
        billing: { plans: VALID_PLANS },
      },
    });
    expect(fw.extension.billing?.plans?.default_paid_plan_id).toBe('pro');
  });
});
