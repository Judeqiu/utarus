/**
 * Demo mode — framework-owned flag (all agents).
 *
 * When enabled, unlinked users may chat without an invite; the access gate
 * auto-creates a profile from their channel display name (same shape as
 * instant invite redeem). Only admins may toggle.
 *
 * Persisted at data/demo_mode.yaml.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { resolveDataRoot } from '../config.js';

export interface DemoModeState {
  enabled: boolean;
  updated_at?: string;
  /** Who last changed it — telegram id and/or slack id */
  updated_by_telegram?: number;
  updated_by_slack?: string;
}

function demoModePath(): string {
  return join(resolveDataRoot(), 'demo_mode.yaml');
}

export function isDemoModeEnabled(): boolean {
  const path = demoModePath();
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw) as DemoModeState | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`demo_mode.yaml is not a mapping: ${path}`);
  }
  return parsed.enabled === true;
}

export function getDemoModeState(): DemoModeState {
  const path = demoModePath();
  if (!existsSync(path)) return { enabled: false };
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw) as DemoModeState | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`demo_mode.yaml is not a mapping: ${path}`);
  }
  return {
    enabled: parsed.enabled === true,
    updated_at: parsed.updated_at,
    updated_by_telegram: parsed.updated_by_telegram,
    updated_by_slack: parsed.updated_by_slack,
  };
}

export function setDemoMode(params: {
  enabled: boolean;
  updatedByTelegram?: number;
  updatedBySlack?: string;
}): DemoModeState {
  const state: DemoModeState = {
    enabled: params.enabled,
    updated_at: new Date().toISOString(),
  };
  if (params.updatedByTelegram != null) state.updated_by_telegram = params.updatedByTelegram;
  if (params.updatedBySlack) state.updated_by_slack = params.updatedBySlack;

  const path = demoModePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(state, { sortMapEntries: false }), 'utf-8');
  return state;
}

/** Parse admin command args: on | off | status | (empty = status). */
export function parseDemoModeArgs(args: string): 'on' | 'off' | 'status' {
  const a = (args ?? '').trim().toLowerCase();
  if (!a || a === 'status' || a === 'get' || a === '?') return 'status';
  if (a === 'on' || a === 'enable' || a === 'true' || a === '1') return 'on';
  if (a === 'off' || a === 'disable' || a === 'false' || a === '0') return 'off';
  throw new Error(`Usage: /demomode on|off|status (got "${args.trim()}")`);
}

export function formatDemoModeStatus(state: DemoModeState): string {
  const who =
    state.updated_by_slack
      ? `Slack ${state.updated_by_slack}`
      : state.updated_by_telegram != null
        ? `Telegram ${state.updated_by_telegram}`
        : 'unknown';
  if (!state.enabled) {
    return state.updated_at
      ? `Demo mode is **off**. Last change: ${state.updated_at} by ${who}.`
      : 'Demo mode is **off**. Invite codes are required for new users.';
  }
  return (
    `Demo mode is **on**. Anyone can chat; missing profiles are created automatically ` +
    `(channel display name). Last change: ${state.updated_at ?? 'unknown'} by ${who}.`
  );
}
