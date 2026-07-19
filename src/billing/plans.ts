/**
 * Plan catalog resolution.
 *
 * Priority when billing is enabled:
 *   1. DomainExtension.billing.plans (if set) — wins entirely, no deep-merge
 *   2. data/config/plans.yaml (must exist if extension has no plans)
 *
 * Plans are loaded at boot / first use and may reload when file content changes
 * (content-hash, same pattern as caps.yaml). No TTL cache of entitlements.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { resolveDataRoot } from '../config.js';
import type { DomainBillingConfig } from './types.js';
import {
  INTRO_TRIAL_DAYS,
  STRIPE_TRIAL_DAYS,
  type PlanCaps,
  type PlanDefinition,
  type PlansCatalog,
  type PlansCatalogInput,
} from './types.js';

let extensionBilling: DomainBillingConfig | undefined;
let cachedFileRaw: string | null = null;
let cachedFileCatalog: PlansCatalog | null = null;

/**
 * Register domain billing config (called from createFramework / assertBillingConfig).
 * Pass undefined to clear.
 */
export function setBillingExtension(billing: DomainBillingConfig | undefined): void {
  extensionBilling = billing;
  // Extension plans don't use the file cache; clear file cache so a later
  // file-only reload path does not serve stale data if extension is cleared.
  if (billing?.plans) {
    cachedFileRaw = null;
    cachedFileCatalog = null;
  }
}

export function getBillingExtension(): DomainBillingConfig | undefined {
  return extensionBilling;
}

export function plansFilePath(): string {
  return join(resolveDataRoot(), 'config', 'plans.yaml');
}

/**
 * Fail-fast validate and normalize a plans catalog input.
 */
export function assertPlansCatalog(
  raw: unknown,
  sourceLabel: string,
): PlansCatalog {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Plans catalog is not a mapping: ${sourceLabel}`);
  }
  const input = raw as Partial<PlansCatalogInput> & Record<string, unknown>;

  if (input.version !== 1) {
    throw new Error(`Plans catalog version must be 1: ${sourceLabel}`);
  }
  if (input.past_due_policy !== 'retain_until_period_end') {
    throw new Error(
      `Plans catalog past_due_policy must be "retain_until_period_end": ${sourceLabel}`,
    );
  }
  if (input.trial_period_days !== STRIPE_TRIAL_DAYS) {
    throw new Error(
      `Plans catalog trial_period_days must be ${STRIPE_TRIAL_DAYS} (Stripe Checkout trial with card): ${sourceLabel}`,
    );
  }
  if (input.intro_trial_days !== INTRO_TRIAL_DAYS) {
    throw new Error(
      `Plans catalog intro_trial_days must be ${INTRO_TRIAL_DAYS} (no-card intro from account create): ${sourceLabel}`,
    );
  }
  if (
    !input.default_paid_plan_id ||
    typeof input.default_paid_plan_id !== 'string'
  ) {
    throw new Error(`Plans catalog missing default_paid_plan_id: ${sourceLabel}`);
  }
  if (!input.plans || typeof input.plans !== 'object' || Array.isArray(input.plans)) {
    throw new Error(`Plans catalog missing plans map: ${sourceLabel}`);
  }

  const plans: Record<string, PlanDefinition> = {};
  const freeIds: string[] = [];
  const priceIds = new Set<string>();

  for (const [id, planRaw] of Object.entries(input.plans)) {
    if (!id || typeof id !== 'string') {
      throw new Error(`Plans catalog has invalid plan id: ${sourceLabel}`);
    }
    if (!planRaw || typeof planRaw !== 'object') {
      throw new Error(`Plan "${id}" is not a mapping: ${sourceLabel}`);
    }
    const p = planRaw as Record<string, unknown>;
    if (!p.display_name || typeof p.display_name !== 'string') {
      throw new Error(`Plan "${id}" missing display_name: ${sourceLabel}`);
    }
    if (!('stripe_price_id' in p)) {
      throw new Error(`Plan "${id}" missing stripe_price_id (use null for free): ${sourceLabel}`);
    }
    const priceId = p.stripe_price_id;
    if (priceId !== null && typeof priceId !== 'string') {
      throw new Error(
        `Plan "${id}" stripe_price_id must be string or null: ${sourceLabel}`,
      );
    }
    if (typeof priceId === 'string' && !priceId.trim()) {
      throw new Error(`Plan "${id}" stripe_price_id must be non-empty string or null: ${sourceLabel}`);
    }
    if (priceId === null) {
      freeIds.push(id);
    } else if (typeof priceId === 'string') {
      if (priceIds.has(priceId)) {
        throw new Error(
          `Duplicate stripe_price_id "${priceId}" in plans catalog: ${sourceLabel}`,
        );
      }
      priceIds.add(priceId);
    }

    const caps = assertPlanCaps(p.caps, id, sourceLabel);
    let features: string[] = [];
    if (p.features !== undefined) {
      if (!Array.isArray(p.features) || !p.features.every((f) => typeof f === 'string')) {
        throw new Error(`Plan "${id}" features must be string[]: ${sourceLabel}`);
      }
      features = p.features as string[];
    }

    plans[id] = {
      id,
      display_name: p.display_name,
      stripe_price_id: priceId as string | null,
      caps,
      features,
    };
  }

  if (freeIds.length !== 1) {
    throw new Error(
      `Plans catalog must have exactly one free plan (stripe_price_id: null), found ${freeIds.length}: ${sourceLabel}`,
    );
  }

  const paidId = input.default_paid_plan_id;
  const paid = plans[paidId];
  if (!paid) {
    throw new Error(
      `default_paid_plan_id "${paidId}" not found in plans: ${sourceLabel}`,
    );
  }
  if (paid.stripe_price_id === null) {
    throw new Error(
      `default_paid_plan_id "${paidId}" must be a paid plan (non-null stripe_price_id): ${sourceLabel}`,
    );
  }

  const introCaps = assertPlanCaps(input.intro_caps, 'intro_caps', sourceLabel);
  if (introCaps.llm_total_tokens >= paid.caps.llm_total_tokens) {
    throw new Error(
      `intro_caps.llm_total_tokens (${introCaps.llm_total_tokens}) must be lower than paid plan "${paidId}" caps (${paid.caps.llm_total_tokens}): ${sourceLabel}`,
    );
  }

  return {
    version: 1,
    past_due_policy: 'retain_until_period_end',
    trial_period_days: STRIPE_TRIAL_DAYS,
    intro_trial_days: INTRO_TRIAL_DAYS,
    intro_caps: introCaps,
    default_paid_plan_id: paidId,
    plans,
  };
}

function assertPlanCaps(raw: unknown, planId: string, sourceLabel: string): PlanCaps {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Plan "${planId}" missing caps: ${sourceLabel}`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.llm_total_tokens !== 'number' || !Number.isFinite(c.llm_total_tokens)) {
    throw new Error(
      `Plan "${planId}" caps.llm_total_tokens must be a number: ${sourceLabel}`,
    );
  }
  if (c.llm_total_tokens < 0) {
    throw new Error(
      `Plan "${planId}" caps.llm_total_tokens must be >= 0: ${sourceLabel}`,
    );
  }
  const caps: PlanCaps = { llm_total_tokens: c.llm_total_tokens };
  if (c.llm_cost_usd !== undefined) {
    if (typeof c.llm_cost_usd !== 'number' || !Number.isFinite(c.llm_cost_usd)) {
      throw new Error(
        `Plan "${planId}" caps.llm_cost_usd must be a number when set: ${sourceLabel}`,
      );
    }
    caps.llm_cost_usd = c.llm_cost_usd;
  }
  if (c.tools !== undefined) {
    if (!c.tools || typeof c.tools !== 'object' || Array.isArray(c.tools)) {
      throw new Error(`Plan "${planId}" caps.tools must be a map: ${sourceLabel}`);
    }
    const tools: Record<string, number> = {};
    for (const [toolName, n] of Object.entries(c.tools as Record<string, unknown>)) {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error(
          `Plan "${planId}" caps.tools.${toolName} must be a number: ${sourceLabel}`,
        );
      }
      tools[toolName] = n;
    }
    caps.tools = tools;
  }
  return caps;
}

function loadPlansFromFile(): PlansCatalog {
  const path = plansFilePath();
  if (!existsSync(path)) {
    throw new Error(
      `Plans catalog file not found (and DomainExtension.billing.plans not set): ${path}`,
    );
  }
  const raw = readFileSync(path, 'utf-8');
  if (raw === cachedFileRaw && cachedFileCatalog) {
    return cachedFileCatalog;
  }
  const parsed = parse(raw);
  const catalog = assertPlansCatalog(parsed, path);
  cachedFileRaw = raw;
  cachedFileCatalog = catalog;
  return catalog;
}

/**
 * Resolve the active plan catalog. Extension plans win over file entirely.
 * Throws if neither is available or validation fails.
 */
export function loadPlansCatalog(): PlansCatalog {
  if (extensionBilling?.plans) {
    return assertPlansCatalog(
      extensionBilling.plans,
      'DomainExtension.billing.plans',
    );
  }
  return loadPlansFromFile();
}

/** Free plan id (exactly one free plan in catalog). */
export function freePlanId(catalog: PlansCatalog = loadPlansCatalog()): string {
  const free = Object.values(catalog.plans).find((p) => p.stripe_price_id === null);
  if (!free) {
    throw new Error('Plans catalog has no free plan');
  }
  return free.id;
}

export function getPlan(
  planId: string,
  catalog: PlansCatalog = loadPlansCatalog(),
): PlanDefinition {
  const plan = catalog.plans[planId];
  if (!plan) {
    throw new Error(`Unknown plan_id "${planId}"`);
  }
  return plan;
}

/** Clear caches (tests). */
export function resetPlansCacheForTests(): void {
  extensionBilling = undefined;
  cachedFileRaw = null;
  cachedFileCatalog = null;
}
