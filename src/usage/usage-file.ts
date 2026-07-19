/**
 * Per-user usage tracking — simple monthly counters for LLM tokens and tool calls.
 *
 * Files live at <DATA_ROOT>/usage/<slug>.yaml. Each file:
 *   - Tracks one rolling monthly period (`period` = "YYYY-MM")
 *   - Auto-resets counters when the calendar month changes
 *   - Tracks lifetime totals alongside period counters
 *
 * Design rules:
 *   - No fallbacks. If something fails, throw.
 *   - No caching. Always read fresh from disk.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { resolveDataRoot } from '../config.js';
import { assertValidSlug } from '../state/state-file.js';

const CURRENT_VERSION = 2;

export interface LlmCounters {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageState {
  version: number;
  user_slug: string;
  period: string;            // YYYY-MM
  created_at: string;        // ISO
  updated_at: string;        // ISO
  period_llm: LlmCounters;
  period_tools: Record<string, number>;
  lifetime_llm: LlmCounters;
  lifetime_tools: Record<string, number>;
  /** Per-profile breakdown (raw, unweighted). Optional on v1 files. */
  period_llm_by_profile?: Record<string, LlmCounters>;
  lifetime_llm_by_profile?: Record<string, LlmCounters>;
}

function emptyLlm(): LlmCounters {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function usageFilePath(slug: string): string {
  assertValidSlug(slug);
  return join(resolveDataRoot(), 'usage', `${slug}.yaml`);
}

function assertCoherent(raw: unknown, path: string): UsageState {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Usage file is not a mapping: ${path}`);
  }
  const s = raw as Partial<UsageState> & Record<string, unknown>;
  if (!s.user_slug) throw new Error(`Usage file missing user_slug: ${path}`);
  if (!s.period || !/^\d{4}-\d{2}$/.test(s.period)) {
    throw new Error(`Usage file has invalid period: ${path}`);
  }
  if (!s.period_llm || !s.lifetime_llm) {
    throw new Error(`Usage file missing llm counters: ${path}`);
  }
  if (typeof s.period_tools !== 'object' || s.period_tools === null) {
    throw new Error(`Usage file missing period_tools map: ${path}`);
  }
  if (typeof s.lifetime_tools !== 'object' || s.lifetime_tools === null) {
    throw new Error(`Usage file missing lifetime_tools map: ${path}`);
  }
  if (s.period_llm_by_profile !== undefined) {
    if (typeof s.period_llm_by_profile !== 'object' || s.period_llm_by_profile === null) {
      throw new Error(`Usage file has invalid period_llm_by_profile: ${path}`);
    }
  }
  if (s.lifetime_llm_by_profile !== undefined) {
    if (typeof s.lifetime_llm_by_profile !== 'object' || s.lifetime_llm_by_profile === null) {
      throw new Error(`Usage file has invalid lifetime_llm_by_profile: ${path}`);
    }
  }
  // Unknown top-level keys are preserved as-is (e.g. a domain agent's
  // video-generation counters living in the same file). The framework only
  // owns the keys it reads — never strip what you don't own.
  return s as UsageState;
}

function freshState(slug: string): UsageState {
  const now = new Date().toISOString();
  return {
    version: CURRENT_VERSION,
    user_slug: slug,
    period: currentPeriod(),
    created_at: now,
    updated_at: now,
    period_llm: emptyLlm(),
    period_tools: {},
    lifetime_llm: emptyLlm(),
    lifetime_tools: {},
  };
}

/**
 * Load usage state for a user. If the file does not exist, creates a fresh one.
 * If the stored period does not match the current month, resets period counters
 * (lifetime counters persist).
 */
export function loadUsage(slug: string): UsageState {
  assertValidSlug(slug);
  const path = usageFilePath(slug);

  if (!existsSync(path)) {
    const fresh = freshState(slug);
    saveUsage(fresh);
    return fresh;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  const state = assertCoherent(parsed, path);

  const now = currentPeriod();
  if (state.period !== now) {
    state.period = now;
    state.period_llm = emptyLlm();
    state.period_tools = {};
    state.period_llm_by_profile = {};
    state.updated_at = new Date().toISOString();
    saveUsage(state);
  }

  return state;
}

export function saveUsage(state: UsageState): void {
  if (!state?.user_slug) {
    throw new Error('Cannot save usage state without user_slug');
  }
  assertCoherent(state, '<in-memory>');
  state.updated_at = new Date().toISOString();
  const path = usageFilePath(state.user_slug);
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringify(state, { sortMapEntries: false });
  writeFileSync(path, yaml, 'utf-8');
}

export interface LlmUsageDelta {
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  total_tokens?: number;
  cost_usd?: number;
}

function applyLlmDelta(target: LlmCounters, delta: LlmUsageDelta): void {
  target.calls += 1;
  if (typeof delta.input_tokens === 'number') target.input_tokens += delta.input_tokens;
  if (typeof delta.output_tokens === 'number') target.output_tokens += delta.output_tokens;
  if (typeof delta.cache_read === 'number') target.cache_read += delta.cache_read;
  if (typeof delta.cache_write === 'number') target.cache_write += delta.cache_write;
  if (typeof delta.total_tokens === 'number') target.total_tokens += delta.total_tokens;
  if (typeof delta.cost_usd === 'number') target.cost_usd += delta.cost_usd;
}

export function recordLlm(
  slug: string,
  delta: LlmUsageDelta,
  opts?: { profileName?: string },
): void {
  const state = loadUsage(slug);
  applyLlmDelta(state.period_llm, delta);
  applyLlmDelta(state.lifetime_llm, delta);
  if (opts?.profileName) {
    if (!state.period_llm_by_profile) state.period_llm_by_profile = {};
    if (!state.lifetime_llm_by_profile) state.lifetime_llm_by_profile = {};
    const p = opts.profileName;
    if (!state.period_llm_by_profile[p]) state.period_llm_by_profile[p] = emptyLlm();
    if (!state.lifetime_llm_by_profile[p]) state.lifetime_llm_by_profile[p] = emptyLlm();
    applyLlmDelta(state.period_llm_by_profile[p], delta);
    applyLlmDelta(state.lifetime_llm_by_profile[p], delta);
  }
  if (state.version < CURRENT_VERSION) state.version = CURRENT_VERSION;
  saveUsage(state);
}

/**
 * Weighted period token total for unified caps.
 * When no by-profile data, returns aggregate period_llm.total_tokens (weight 1).
 * Weights from UTARUS_LLM_CAP_WEIGHTS via getCapWeight.
 */
export function weightedPeriodTokens(
  state: UsageState,
  getWeight: (profileName: string) => number,
): number {
  const by = state.period_llm_by_profile;
  if (!by || Object.keys(by).length === 0) {
    return state.period_llm.total_tokens;
  }
  let sum = 0;
  for (const [profile, counters] of Object.entries(by)) {
    sum += counters.total_tokens * getWeight(profile);
  }
  return sum;
}

export function weightedPeriodCostUsd(
  state: UsageState,
  getWeight: (profileName: string) => number,
): number {
  const by = state.period_llm_by_profile;
  if (!by || Object.keys(by).length === 0) {
    return state.period_llm.cost_usd;
  }
  let sum = 0;
  for (const [profile, counters] of Object.entries(by)) {
    sum += counters.cost_usd * getWeight(profile);
  }
  return sum;
}

export function recordToolCall(slug: string, toolName: string): void {
  if (!toolName || typeof toolName !== 'string') {
    throw new Error(`recordToolCall requires a toolName (got: ${toolName})`);
  }
  const state = loadUsage(slug);
  state.period_tools[toolName] = (state.period_tools[toolName] ?? 0) + 1;
  state.lifetime_tools[toolName] = (state.lifetime_tools[toolName] ?? 0) + 1;
  saveUsage(state);
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function periodEndDate(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return '';
  // Local-time formatting — toISOString() would shift the date back a day
  // in timezones ahead of UTC.
  const firstOfNext = new Date(y, m, 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${firstOfNext.getFullYear()}-${pad(firstOfNext.getMonth() + 1)}-${pad(firstOfNext.getDate())}`;
}

function renderLlmTable(period: LlmCounters, lifetime: LlmCounters): string {
  const rows: Array<[string, string, string]> = [
    ['Calls', fmtNum(period.calls), fmtNum(lifetime.calls)],
    ['Input tokens', fmtNum(period.input_tokens), fmtNum(lifetime.input_tokens)],
    ['Output tokens', fmtNum(period.output_tokens), fmtNum(lifetime.output_tokens)],
    ['Cache read', fmtNum(period.cache_read), fmtNum(lifetime.cache_read)],
    ['Cache write', fmtNum(period.cache_write), fmtNum(lifetime.cache_write)],
    ['Total tokens', fmtNum(period.total_tokens), fmtNum(lifetime.total_tokens)],
    ['Est. cost', fmtUsd(period.cost_usd), fmtUsd(lifetime.cost_usd)],
  ];
  return [
    '**LLM**',
    '',
    '| Metric | This month | Lifetime |',
    '| --- | ---: | ---: |',
    ...rows.map(([m, p, l]) => `| ${m} | ${p} | ${l} |`),
  ].join('\n');
}

function renderToolsTable(period: Record<string, number>, lifetime: Record<string, number>): string {
  const names = [...new Set([...Object.keys(period), ...Object.keys(lifetime)])];
  if (names.length === 0) return '**Tools**\n\n_No tool calls yet._';
  names.sort((a, b) => (period[b] ?? 0) - (period[a] ?? 0) || (lifetime[b] ?? 0) - (lifetime[a] ?? 0));
  return [
    '**Tools**',
    '',
    '| Tool | This month | Lifetime |',
    '| --- | ---: | ---: |',
    ...names.map(n => `| \`${n}\` | ${fmtNum(period[n] ?? 0)} | ${fmtNum(lifetime[n] ?? 0)} |`),
  ].join('\n');
}

/**
 * Render the per-user usage report as GitHub-flavored markdown — one table
 * per section with This-month vs Lifetime columns. Renders natively on
 * WebUI (react-markdown + remark-gfm); Telegram/Slack convert tables to
 * bullets / monospace blocks in their channel formatters.
 */
function renderProfileBreakdown(state: UsageState): string {
  const period = state.period_llm_by_profile ?? {};
  const lifetime = state.lifetime_llm_by_profile ?? {};
  const names = [...new Set([...Object.keys(period), ...Object.keys(lifetime)])];
  if (names.length === 0) return '';
  names.sort(
    (a, b) =>
      (period[b]?.total_tokens ?? 0) - (period[a]?.total_tokens ?? 0) ||
      (lifetime[b]?.total_tokens ?? 0) - (lifetime[a]?.total_tokens ?? 0),
  );
  return [
    '**LLM by profile** (raw tokens; cap weights apply only at gate check)',
    '',
    '| Profile | Month tokens | Lifetime tokens | Month cost |',
    '| --- | ---: | ---: | ---: |',
    ...names.map(n => {
      const p = period[n] ?? emptyLlm();
      const l = lifetime[n] ?? emptyLlm();
      return `| \`${n}\` | ${fmtNum(p.total_tokens)} | ${fmtNum(l.total_tokens)} | ${fmtUsd(p.cost_usd)} |`;
    }),
  ].join('\n');
}

export function formatUsageReport(state: UsageState): string {
  const reset = periodEndDate(state.period);
  const profileSection = renderProfileBreakdown(state);
  return [
    `📊 **Your Usage** — period ${state.period}`,
    '',
    renderLlmTable(state.period_llm, state.lifetime_llm),
    '',
    ...(profileSection ? [profileSection, ''] : []),
    renderToolsTable(state.period_tools, state.lifetime_tools),
    '',
    reset ? `_Counters reset on ${reset}_` : '',
  ].join('\n');
}
