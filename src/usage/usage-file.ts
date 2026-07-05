/**
 * Per-user usage tracking — simple monthly counters for LLM tokens and tool calls.
 *
 * Files live at <DATA_ROOT>/usage/<slug>.yaml. Each file:
 *   - Tracks one rolling monthly period (`period` = "YYYY-MM")
 *   - Auto-resets counters when the calendar month changes
 *   - Tracks lifetime totals alongside period counters
 *
 * Design rules (per project CLAUDE.md):
 *   - No fallbacks. If something fails, throw.
 *   - No caching. Always read fresh from disk.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { config } from '../config.js';
import { assertValidSlug } from '../state/state-file.js';

const DATA_ROOT = config.dataRoot;
const USAGE_DIR = join(DATA_ROOT, 'usage');

const CURRENT_VERSION = 1;

export interface LlmCounters {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  cost_usd: number;
}

export interface VideoCounters {
  calls: number;
  tokens: number;        // Ark usage.completion_tokens (Volcengine's metering unit)
  cost_cny: number;      // computed from pricing.yaml + tokens (Ark bills in CNY)
}

export interface UsageState {
  version: number;
  user_slug: string;
  period: string;            // YYYY-MM
  created_at: string;        // ISO
  updated_at: string;        // ISO
  period_llm: LlmCounters;
  period_video: VideoCounters;
  period_tools: Record<string, number>;
  lifetime_llm: LlmCounters;
  lifetime_video: VideoCounters;
  lifetime_tools: Record<string, number>;
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

function emptyVideo(): VideoCounters {
  return { calls: 0, tokens: 0, cost_cny: 0 };
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function usageFilePath(slug: string): string {
  assertValidSlug(slug);
  return join(USAGE_DIR, `${slug}.yaml`);
}

function coerceVideoCounters(raw: unknown, where: string): VideoCounters {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Usage file has invalid video counters (not a mapping) at ${where}`);
  }
  const v = raw as Partial<VideoCounters> & { cost_usd?: unknown };
  if (typeof v.calls !== 'number' || Number.isNaN(v.calls)) {
    throw new Error(`Usage file has invalid video.calls at ${where}: ${JSON.stringify(raw)}`);
  }
  if (typeof v.tokens !== 'number' || Number.isNaN(v.tokens)) {
    throw new Error(`Usage file has invalid video.tokens at ${where}: ${JSON.stringify(raw)}`);
  }
  if (typeof v.cost_cny === 'number' && !Number.isNaN(v.cost_cny)) {
    return { calls: v.calls, tokens: v.tokens, cost_cny: v.cost_cny };
  }
  // cost_cny is missing or NaN. Two known causes:
  //   1. File written before commit 559f5ad (which renamed cost_usd → cost_cny).
  //      Old shape had cost_usd; the value was a fabricated USD placeholder.
  //   2. File corrupted by the resulting undefined + number = NaN arithmetic.
  // Either way the historical cost is unreliable — fail fast with instructions.
  throw new Error(
    `Usage file has invalid video.cost_cny at ${where} (got: ${JSON.stringify(v.cost_cny ?? null)}). ` +
    `This usually means the file was written before the cost_usd→cost_cny rename in commit 559f5ad. ` +
    `Delete the file to reset video usage counters; calls and tokens will be lost but future tracking will be correct.`
  );
}

function assertCoherent(raw: unknown, path: string): UsageState {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Usage file is not a mapping: ${path}`);
  }
  const s = raw as Partial<UsageState>;
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
  if (!s.period_video && !s.lifetime_video) {
    // Pre-video-tracking file (commit 4b5d179): both sections absent.
    s.period_video = emptyVideo();
    s.lifetime_video = emptyVideo();
  } else {
    s.period_video = coerceVideoCounters(s.period_video, `${path}:period_video`);
    s.lifetime_video = coerceVideoCounters(s.lifetime_video, `${path}:lifetime_video`);
  }
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
    period_video: emptyVideo(),
    period_tools: {},
    lifetime_llm: emptyLlm(),
    lifetime_video: emptyVideo(),
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
    state.period_video = emptyVideo();
    state.period_tools = {};
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

export function recordLlm(slug: string, delta: LlmUsageDelta): void {
  const state = loadUsage(slug);
  applyLlmDelta(state.period_llm, delta);
  applyLlmDelta(state.lifetime_llm, delta);
  saveUsage(state);
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

export interface VideoUsageDelta {
  tokens: number;
  cost_cny: number;
}

export function recordVideoUsage(slug: string, delta: VideoUsageDelta): void {
  if (typeof delta.tokens !== 'number' || Number.isNaN(delta.tokens) || delta.tokens < 0) {
    throw new Error(`recordVideoUsage requires non-negative tokens (got: ${delta.tokens})`);
  }
  if (typeof delta.cost_cny !== 'number' || Number.isNaN(delta.cost_cny) || delta.cost_cny < 0) {
    throw new Error(`recordVideoUsage requires non-negative cost_cny (got: ${delta.cost_cny})`);
  }
  const state = loadUsage(slug);
  for (const target of [state.period_video, state.lifetime_video]) {
    target.calls += 1;
    target.tokens += delta.tokens;
    target.cost_cny += delta.cost_cny;
  }
  saveUsage(state);
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtCny(n: number): string {
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(2)}`;
}

function periodEndDate(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return '';
  const firstOfNext = new Date(y, m, 1);
  return firstOfNext.toISOString().slice(0, 10);
}

function renderLlmSection(title: string, llm: LlmCounters): string {
  return [
    `*${title}*`,
    `• LLM calls: ${fmtNum(llm.calls)}`,
    `• Input tokens: ${fmtNum(llm.input_tokens)}`,
    `• Output tokens: ${fmtNum(llm.output_tokens)}`,
    `• Cache read: ${fmtNum(llm.cache_read)} | cache write: ${fmtNum(llm.cache_write)}`,
    `• Total tokens: ${fmtNum(llm.total_tokens)}`,
    `• Est. cost: ${fmtUsd(llm.cost_usd)}`,
  ].join('\n');
}

function renderToolsSection(title: string, tools: Record<string, number>): string {
  const entries = Object.entries(tools);
  if (entries.length === 0) return `*${title}*\n• _none yet_`;
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([name, count]) => `• \`${name}\`: ${fmtNum(count)}`);
  return `*${title}*\n${lines.join('\n')}`;
}

function renderVideoSection(title: string, v: VideoCounters): string {
  return [
    `*${title}*`,
    `• Videos: ${fmtNum(v.calls)}`,
    `• Tokens: ${fmtNum(v.tokens)}`,
    `• Est. cost: ${fmtCny(v.cost_cny)}`,
  ].join('\n');
}

export function formatUsageReport(state: UsageState): string {
  const reset = periodEndDate(state.period);
  const header = `📊 *Your Usage* — period ${state.period}`;
  const periodLlm = renderLlmSection('This month (LLM)', state.period_llm);
  const periodVideo = renderVideoSection('This month (Video)', state.period_video);
  const periodTools = renderToolsSection('This month (Tools)', state.period_tools);
  const lifeLlm = renderLlmSection('Lifetime (LLM)', state.lifetime_llm);
  const lifeVideo = renderVideoSection('Lifetime (Video)', state.lifetime_video);
  const lifeTools = renderToolsSection('Lifetime (Tools)', state.lifetime_tools);
  const footer = reset ? `_Counters reset on ${reset}_` : '';
  return [
    header, '',
    periodLlm, '',
    periodVideo, '',
    periodTools, '',
    lifeLlm, '',
    lifeVideo, '',
    lifeTools, '',
    footer,
  ].join('\n');
}
