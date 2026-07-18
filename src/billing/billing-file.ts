/**
 * Per-user billing state at data/billing/<slug>.yaml.
 *
 * - Missing file = implicit free (load returns null; do not auto-create).
 * - Saves use atomic write (tmp + rename).
 * - Fail-fast coherence checks; unknown top-level keys preserved.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { parse, stringify } from 'yaml';
import { resolveDataRoot } from '../config.js';
import { assertValidSlug } from '../state/state-file.js';
import type { BillingState, BillingStatus } from './types.js';

const CURRENT_VERSION = 1 as const;

const STATUSES: ReadonlySet<string> = new Set([
  'none',
  'active',
  'trialing',
  'past_due',
  'canceled',
  'unpaid',
  'comped',
]);

/** In-process per-slug mutex for load→modify→save (webhook apply). */
const locks = new Map<string, Promise<unknown>>();

export function billingDir(): string {
  return join(resolveDataRoot(), 'billing');
}

export function billingFilePath(slug: string): string {
  assertValidSlug(slug);
  return join(billingDir(), `${slug}.yaml`);
}

export function assertBillingStateCoherent(
  raw: unknown,
  path: string,
  opts?: { knownPlanIds?: ReadonlySet<string> },
): BillingState {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Billing file is not a mapping: ${path}`);
  }
  const s = raw as Partial<BillingState> & Record<string, unknown>;

  if (s.version !== CURRENT_VERSION) {
    throw new Error(
      `Billing file version must be ${CURRENT_VERSION}: ${path}`,
    );
  }
  if (!s.user_slug || typeof s.user_slug !== 'string') {
    throw new Error(`Billing file missing user_slug: ${path}`);
  }
  assertValidSlug(s.user_slug);

  if (!s.plan_id || typeof s.plan_id !== 'string') {
    throw new Error(`Billing file missing plan_id: ${path}`);
  }
  if (!s.status || typeof s.status !== 'string' || !STATUSES.has(s.status)) {
    throw new Error(
      `Billing file has invalid status "${String(s.status)}": ${path}`,
    );
  }
  if (!s.updated_at || typeof s.updated_at !== 'string') {
    throw new Error(`Billing file missing updated_at: ${path}`);
  }

  if (s.current_period_end != null && typeof s.current_period_end !== 'string') {
    throw new Error(`Billing file current_period_end must be string or null: ${path}`);
  }
  if (
    s.current_period_end != null &&
    Number.isNaN(Date.parse(s.current_period_end))
  ) {
    throw new Error(`Billing file current_period_end is not a valid date: ${path}`);
  }

  if (s.status === 'comped') {
    const compPlan = s.comped_plan_id ?? s.plan_id;
    if (!compPlan || typeof compPlan !== 'string') {
      throw new Error(
        `Billing file status=comped requires comped_plan_id or plan_id: ${path}`,
      );
    }
    if (opts?.knownPlanIds && !opts.knownPlanIds.has(compPlan)) {
      throw new Error(
        `Billing file comped plan "${compPlan}" is not in catalog: ${path}`,
      );
    }
  } else if (opts?.knownPlanIds && !opts.knownPlanIds.has(s.plan_id)) {
    throw new Error(
      `Billing file plan_id "${s.plan_id}" is not in catalog: ${path}`,
    );
  }

  // Webhook path will require subscription id for active/trialing/past_due;
  // file-level load allows incomplete rows so admin/comp writes stay flexible.

  return s as BillingState;
}

/**
 * Load billing state. Returns null if the file does not exist (implicit free).
 * Throws on corrupt files.
 */
export function loadBillingState(slug: string): BillingState | null {
  assertValidSlug(slug);
  const path = billingFilePath(slug);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  const state = assertBillingStateCoherent(parsed, path);
  if (state.user_slug !== slug) {
    throw new Error(
      `Billing file user_slug "${state.user_slug}" does not match filename slug "${slug}": ${path}`,
    );
  }
  return state;
}

/**
 * Atomic save (write tmp → rename). Fail-fast if state is incoherent.
 */
export function saveBillingState(state: BillingState): void {
  if (!state?.user_slug) {
    throw new Error('Cannot save billing state without user_slug');
  }
  assertValidSlug(state.user_slug);
  assertBillingStateCoherent(state, '<in-memory>');

  state.updated_at = new Date().toISOString();
  const path = billingFilePath(state.user_slug);
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringify(state, { sortMapEntries: false });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, yaml, 'utf-8');
  renameSync(tmp, path);
}

/**
 * Serialize load→modify→save for a slug (in-process). Used by webhooks later.
 */
export async function withBillingLock<T>(
  slug: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  assertValidSlug(slug);
  const prev = locks.get(slug) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  locks.set(slug, chained);

  await prev.catch(() => {
    /* previous op failed — still run next */
  });
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(slug) === chained) {
      locks.delete(slug);
    }
  }
}

export function billingStatusIs(value: string): value is BillingStatus {
  return STATUSES.has(value);
}
