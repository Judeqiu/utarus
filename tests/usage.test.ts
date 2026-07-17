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
  wrapToolWithCap,
} from '../src/usage/index.js';

let tmp: string;
let prevDataRoot: string | undefined;

beforeEach(() => {
  prevDataRoot = process.env.UTARUS_DATA_ROOT;
  tmp = mkdtempSync(join(tmpdir(), 'utarus-usage-test-'));
  process.env.UTARUS_DATA_ROOT = tmp;
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.UTARUS_DATA_ROOT;
  else process.env.UTARUS_DATA_ROOT = prevDataRoot;
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

  it('loads legacy files with video counters and drops them on next save', () => {
    writeDataFile('usage/alice.yaml', usageFile({
      period_video: { calls: 2, tokens: 1000, cost_cny: 3.5 },
      lifetime_video: { calls: 4, tokens: 2000, cost_cny: 7.0 },
    }));

    const state = loadUsage('alice');
    expect('period_video' in state).toBe(false);
    expect('lifetime_video' in state).toBe(false);
    expect(state.period_llm.calls).toBe(0);

    recordToolCall('alice', 'firecrawl'); // forces a save
    const raw = readFileSync(join(tmp, 'usage', 'alice.yaml'), 'utf-8');
    expect(raw).not.toContain('period_video');
    expect(raw).not.toContain('lifetime_video');
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
  });

  it('never blocks admins', () => {
    writeDataFile('config/caps.yaml', { default: { llm_total_tokens: 1 } });
    recordLlm('alice', { total_tokens: 100 });
    expect(checkLlmCap('alice', true)).toBeNull();
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
  it('renders LLM and tool sections without video counters', () => {
    recordLlm('alice', { input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.01 });
    recordToolCall('alice', 'firecrawl');

    const report = formatUsageReport(loadUsage('alice'));
    expect(report).toContain('**This month (LLM)**');
    expect(report).toContain('**Lifetime (LLM)**');
    expect(report).toContain('**This month (Tools)**');
    expect(report).toContain('**Lifetime (Tools)**');
    expect(report).toContain('firecrawl');
    expect(report).not.toContain('Video');
  });
});
