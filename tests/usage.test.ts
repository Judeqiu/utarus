import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { stringify } from 'yaml';
import {
  loadUsage,
  recordLlm,
  recordToolCall,
  formatUsageReport,
  getCap,
  checkLlmCap,
  checkTurnAllowed,
  wrapToolWithCap,
} from '../src/usage/index.js';
import {
  setBillingExtension,
  resetPlansCacheForTests,
  saveBillingState,
  type PlansCatalogInput,
} from '../src/billing/index.js';

let tmp: string;
let prevEnv: Record<string, string | undefined>;

const BILLING_ENV_KEYS = [
  'UTARUS_DATA_ROOT',
  'UTARUS_BILLING_ENABLED',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'UTARUS_PUBLIC_BASE_URL',
] as const;

const SAMPLE_PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 7,
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: { llm_total_tokens: 1000, tools: { firecrawl: 1 } },
      features: [],
    },
    pro: {
      display_name: 'Pro',
      stripe_price_id: 'price_pro',
      caps: { llm_total_tokens: 100_000, tools: { firecrawl: 50 } },
      features: [],
    },
  },
};

beforeEach(() => {
  prevEnv = {};
  for (const k of BILLING_ENV_KEYS) prevEnv[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), 'utarus-usage-test-'));
  process.env.UTARUS_DATA_ROOT = tmp;
  delete process.env.UTARUS_BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.UTARUS_PUBLIC_BASE_URL;
  resetPlansCacheForTests();
});

afterEach(() => {
  for (const k of BILLING_ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  resetPlansCacheForTests();
  rmSync(tmp, { recursive: true, force: true });
});

function writeDataFile(rel: string, data: unknown): void {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, stringify(data), 'utf-8');
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function llmCounters(overrides: Partial<Record<string, number>> = {}) {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    total_tokens: 0,
    cost_usd: 0,
    ...overrides,
  };
}

function usageFile(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    user_slug: 'alice',
    period: currentPeriod(),
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    period_llm: llmCounters(),
    period_tools: {},
    lifetime_llm: llmCounters(),
    lifetime_tools: {},
    ...overrides,
  };
}

describe('loadUsage', () => {
  it('creates a fresh file with zeroed counters for the current period', () => {
    const state = loadUsage('alice');
    expect(state.user_slug).toBe('alice');
    expect(state.period).toBe(currentPeriod());
    expect(state.period_llm.calls).toBe(0);
    expect(state.period_llm.total_tokens).toBe(0);
    expect(state.lifetime_llm.calls).toBe(0);
    expect(state.period_tools).toEqual({});
    expect(existsSync(join(tmp, 'usage', 'alice.yaml'))).toBe(true);
  });

  it('resets period counters on month rollover but keeps lifetime', () => {
    writeDataFile('usage/alice.yaml', usageFile({
      period: '2020-01',
      period_llm: llmCounters({ calls: 5, total_tokens: 150 }),
      period_tools: { firecrawl: 3 },
      lifetime_llm: llmCounters({ calls: 10, total_tokens: 300 }),
      lifetime_tools: { firecrawl: 7 },
    }));

    const state = loadUsage('alice');
    expect(state.period).toBe(currentPeriod());
    expect(state.period_llm.calls).toBe(0);
    expect(state.period_llm.total_tokens).toBe(0);
    expect(state.period_tools).toEqual({});
    expect(state.lifetime_llm.calls).toBe(10);
    expect(state.lifetime_llm.total_tokens).toBe(300);
    expect(state.lifetime_tools['firecrawl']).toBe(7);
  });

  it('preserves domain-owned keys (e.g. video counters) on load and save', () => {
    writeDataFile('usage/alice.yaml', usageFile({
      period_video: { calls: 2, tokens: 1000, cost_cny: 3.5 },
      lifetime_video: { calls: 4, tokens: 2000, cost_cny: 7.0 },
    }));

    const state = loadUsage('alice');
    expect((state as Record<string, unknown>).period_video).toEqual({ calls: 2, tokens: 1000, cost_cny: 3.5 });
    expect(state.period_llm.calls).toBe(0);

    recordToolCall('alice', 'firecrawl'); // forces a save
    const raw = readFileSync(join(tmp, 'usage', 'alice.yaml'), 'utf-8');
    expect(raw).toContain('period_video');
    expect(raw).toContain('lifetime_video');
    expect(raw).toContain('cost_cny');
  });

  it('rejects invalid slugs', () => {
    expect(() => loadUsage('UPPER')).toThrow(/lowercase kebab-case/);
  });
});

describe('recordLlm', () => {
  it('accumulates tokens and cost into period and lifetime counters', () => {
    recordLlm('alice', { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.01 });
    recordLlm('alice', { input_tokens: 200, output_tokens: 100, total_tokens: 300, cost_usd: 0.02 });

    const state = loadUsage('alice');
    for (const counters of [state.period_llm, state.lifetime_llm]) {
      expect(counters.calls).toBe(2);
      expect(counters.input_tokens).toBe(300);
      expect(counters.output_tokens).toBe(150);
      expect(counters.total_tokens).toBe(450);
      expect(counters.cost_usd).toBeCloseTo(0.03);
    }
  });
});

describe('recordToolCall', () => {
  it('counts calls per tool in period and lifetime maps', () => {
    recordToolCall('alice', 'firecrawl');
    recordToolCall('alice', 'firecrawl');
    recordToolCall('alice', 'post_html_report');

    const state = loadUsage('alice');
    expect(state.period_tools['firecrawl']).toBe(2);
    expect(state.period_tools['post_html_report']).toBe(1);
    expect(state.lifetime_tools['firecrawl']).toBe(2);
  });

  it('throws on an empty tool name', () => {
    expect(() => recordToolCall('alice', '')).toThrow(/requires a toolName/);
  });
});

describe('getCap', () => {
  it('returns undefined when the caps file is missing', () => {
    expect(getCap('alice', 'llm_total_tokens')).toBeUndefined();
  });

  it('merges per-slug overrides over defaults', () => {
    writeDataFile('config/caps.yaml', {
      default: { llm_total_tokens: 500000, tools: { firecrawl: 50 } },
      overrides: { alice: { llm_total_tokens: 1000000 } },
    });

    expect(getCap('bob', 'llm_total_tokens')).toBe(500000);
    expect(getCap('alice', 'llm_total_tokens')).toBe(1000000);
    // Keys not overridden fall back to default.
    expect(getCap('alice', 'tools.firecrawl')).toBe(50);
    expect(getCap('bob', 'tools.firecrawl')).toBe(50);
    expect(getCap('bob', 'tools.unknown_tool')).toBeUndefined();
  });
});

describe('checkLlmCap', () => {
  it('returns null when no cap is configured', () => {
    expect(checkLlmCap('alice', false)).toBeNull();
  });

  it('returns null while under the cap and a message once at/over it', () => {
    writeDataFile('config/caps.yaml', { default: { llm_total_tokens: 1000 } });

    recordLlm('alice', { total_tokens: 500 });
    expect(checkLlmCap('alice', false)).toBeNull();

    recordLlm('alice', { total_tokens: 500 });
    expect(checkLlmCap('alice', false)).toMatch(/monthly LLM token cap/);
    expect(checkLlmCap('alice', false)).toMatch(/Contact an admin/);
  });

  it('never blocks admins', () => {
    writeDataFile('config/caps.yaml', { default: { llm_total_tokens: 1 } });
    recordLlm('alice', { total_tokens: 100 });
    expect(checkLlmCap('alice', true)).toBeNull();
  });
});

describe('checkTurnAllowed (billing on)', () => {
  beforeEach(() => {
    process.env.UTARUS_BILLING_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.UTARUS_PUBLIC_BASE_URL = 'https://agent.example.com';
    setBillingExtension({ plans: SAMPLE_PLANS });
  });

  it('returns structured cap_exceeded with web relative upgrade_url', () => {
    recordLlm('alice', { total_tokens: 1000 });
    const block = checkTurnAllowed('alice', false, { channel: 'web' });
    expect(block).not.toBeNull();
    expect(block!.code).toBe('cap_exceeded');
    expect(block!.upgradeUrl).toBe('/billing');
    expect(block!.current).toBe(1000);
    expect(block!.cap).toBe(1000);
    expect(block!.planId).toBe('free');
  });

  it('mints enter URL for telegram when public base is set', () => {
    recordLlm('alice', { total_tokens: 1000 });
    const block = checkTurnAllowed('alice', false, { channel: 'telegram' });
    expect(block?.upgradeUrl).toMatch(
      /^https:\/\/agent\.example\.com\/api\/billing\/enter\?return=%2Fbilling&t=/,
    );
    expect(block?.message).toContain(block!.upgradeUrl!);
  });

  it('uses paid plan caps when active', () => {
    saveBillingState({
      version: 1,
      user_slug: 'alice',
      plan_id: 'pro',
      status: 'active',
      current_period_end: '2099-01-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    });
    recordLlm('alice', { total_tokens: 1000 });
    expect(checkTurnAllowed('alice', false, { channel: 'web' })).toBeNull();
  });

  it('fails closed with billing_state_error on corrupt billing file', () => {
    writeDataFile('billing/alice.yaml', { version: 1, broken: true });
    const block = checkTurnAllowed('alice', false, { channel: 'web' });
    expect(block?.code).toBe('billing_state_error');
    expect(block?.upgradeUrl).toBeUndefined();
  });
});

describe('wrapToolWithCap', () => {
  function fakeTool(calls: { n: number }) {
    return {
      name: 'firecrawl',
      label: 'Firecrawl',
      description: 'fake',
      parameters: {},
      execute: async () => {
        calls.n += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
  }

  it('passes through when no cap is configured', async () => {
    const calls = { n: 0 };
    const wrapped = wrapToolWithCap(fakeTool(calls) as any, 'alice');
    const result = await wrapped.execute('id', {} as never);
    expect(calls.n).toBe(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('returns a cap message without executing once the cap is hit', async () => {
    writeDataFile('config/caps.yaml', { default: { tools: { firecrawl: 1 } } });
    recordToolCall('alice', 'firecrawl');

    const calls = { n: 0 };
    const wrapped = wrapToolWithCap(fakeTool(calls) as any, 'alice');
    const result = await wrapped.execute('id', {} as never);
    expect(calls.n).toBe(0);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toMatch(/Monthly cap reached/);
  });
});

describe('formatUsageReport', () => {
  it('renders LLM and tool tables with month vs lifetime columns', () => {
    recordLlm('alice', { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.01 });
    recordToolCall('alice', 'firecrawl');

    const report = formatUsageReport(loadUsage('alice'));
    expect(report).toContain('**LLM**');
    expect(report).toContain('**Tools**');
    expect(report).toContain('| Metric | This month | Lifetime |');
    expect(report).toContain('| Total tokens | 150 | 150 |');
    expect(report).toContain('| Tool | This month | Lifetime |');
    expect(report).toContain('| `firecrawl` | 1 | 1 |');
    expect(report).not.toContain('Video');
  });

  it('renders a friendly empty state when no tools were called', () => {
    const report = formatUsageReport(loadUsage('alice'));
    expect(report).toContain('_No tool calls yet._');
  });
});
