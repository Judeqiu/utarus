/**
 * Billing feature flag + boot validation.
 *
 * When UTARUS_BILLING_ENABLED=true, createFramework must call
 * assertBillingConfig so domain hosts (not only standalone index.ts) fail fast.
 *
 * Stripe secrets are validated here even before the Stripe SDK lands (PR 3)
 * so half-configured billing cannot boot.
 */

import { existsSync, readFileSync } from 'fs';
import { parse } from 'yaml';
import type { DomainExtension } from '../extension.js';
import { capsFilePath } from '../usage/caps.js';
import {
  assertPlansCatalog,
  loadPlansCatalog,
  setBillingExtension,
} from './plans.js';
import type { DomainBillingConfig } from './types.js';

export function isBillingEnabled(): boolean {
  return process.env.UTARUS_BILLING_ENABLED === 'true';
}

const CAP_HIT_PLACEHOLDERS = ['{current}', '{cap}', '{upgradeUrl}'] as const;

function assertCopyTemplates(copy: DomainBillingConfig['copy'] | undefined): void {
  if (!copy) return;
  if (copy.capHitTemplate !== undefined) {
    if (typeof copy.capHitTemplate !== 'string' || !copy.capHitTemplate.trim()) {
      throw new Error(
        'DomainExtension.billing.copy.capHitTemplate must be a non-empty string when set',
      );
    }
    for (const ph of CAP_HIT_PLACEHOLDERS) {
      if (!copy.capHitTemplate.includes(ph)) {
        throw new Error(
          `DomainExtension.billing.copy.capHitTemplate missing required placeholder ${ph}`,
        );
      }
    }
  }
  if (copy.upgradeCta !== undefined) {
    if (typeof copy.upgradeCta !== 'string' || !copy.upgradeCta.trim()) {
      throw new Error(
        'DomainExtension.billing.copy.upgradeCta must be a non-empty string when set',
      );
    }
  }
}

/**
 * When billing is on, caps.yaml must not define `default` (dual source of truth).
 * Per-slug overrides remain allowed as admin comps.
 */
export function assertCapsYamlCompatibleWithBilling(): void {
  const path = capsFilePath();
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Caps file is not a mapping: ${path}`);
  }
  const cfg = parsed as { default?: unknown };
  if (cfg.default !== undefined && cfg.default !== null) {
    throw new Error(
      `When UTARUS_BILLING_ENABLED=true, caps.yaml must not define "default" ` +
        `(plan caps are the free-tier source of truth). Remove default from ${path} ` +
        `and keep only overrides.<slug> for admin comps.`,
    );
  }
}

/**
 * Fail-fast validation when billing is enabled.
 * Call from createFramework (and optionally buildWebApp for publishable key).
 *
 * @param opts.requirePublishableKey — true when WebUI billing UI mounts
 */
export function assertBillingConfig(
  extension: Pick<DomainExtension, 'billing'> | DomainExtension,
  opts?: { requirePublishableKey?: boolean },
): void {
  if (!isBillingEnabled()) {
    return;
  }

  const missing: string[] = [];
  if (!process.env.STRIPE_SECRET_KEY?.trim()) missing.push('STRIPE_SECRET_KEY');
  if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!process.env.UTARUS_PUBLIC_BASE_URL?.trim()) missing.push('UTARUS_PUBLIC_BASE_URL');
  if (opts?.requirePublishableKey && !process.env.STRIPE_PUBLISHABLE_KEY?.trim()) {
    missing.push('STRIPE_PUBLISHABLE_KEY');
  }
  if (missing.length > 0) {
    throw new Error(
      `UTARUS_BILLING_ENABLED=true but missing required env: ${missing.join(', ')}`,
    );
  }

  setBillingExtension(extension.billing);
  assertCopyTemplates(extension.billing?.copy);

  // Plans: extension wins; otherwise file must exist and validate.
  if (extension.billing?.plans) {
    assertPlansCatalog(extension.billing.plans, 'DomainExtension.billing.plans');
  } else {
    loadPlansCatalog();
  }

  assertCapsYamlCompatibleWithBilling();
}
