/**
 * Unified turn / tool gate: checkTurnAllowed + checkLlmCap.
 *
 * Billing off: effective caps from caps.yaml; fail-open on load errors (legacy).
 * Billing on: plan + overrides; fail-closed on load errors (billing_state_error).
 */

import { loadUsage, weightedPeriodTokens } from '../usage/usage-file.js';
import { getCapWeight } from '../llm/profiles.js';
import { getEffectiveCap, getEntitlement } from './entitlements.js';
import {
  billingStateErrorMessage,
  buildUpgradeUrl,
  formatPaywallMessage,
} from './messages.js';
import { isBillingEnabled } from './validate.js';
import type { PaywallBlock, PaywallChannel } from './types.js';

export type { PaywallBlock, PaywallChannel };

/**
 * Structured pre-turn LLM gate for HTTP/SSE and channel callers.
 * Returns null when the turn may proceed.
 */
export function checkTurnAllowed(
  userSlug: string,
  isAdmin: boolean,
  opts?: { channel?: PaywallChannel; displayName?: string },
): PaywallBlock | null {
  if (!userSlug || isAdmin) return null;

  const channel: PaywallChannel = opts?.channel ?? 'cli';

  try {
    const cap = getEffectiveCap(userSlug, 'llm_total_tokens');
    if (cap === undefined) return null;

    const usage = loadUsage(userSlug);
    // Unified cap: weighted sum when by-profile data exists (K21).
    const current = weightedPeriodTokens(usage, getCapWeight);
    if (current < cap) return null;

    const upgradeUrl = buildUpgradeUrl(userSlug, channel, {
      displayName: opts?.displayName,
    });
    let planId: string | undefined;
    if (isBillingEnabled()) {
      planId = getEntitlement(userSlug).plan_id;
    }

    return {
      code: 'cap_exceeded',
      message: formatPaywallMessage({ current, cap, upgradeUrl, channel }),
      upgradeUrl,
      planId,
      kind: 'llm_total_tokens',
      current,
      cap,
    };
  } catch (err) {
    if (!isBillingEnabled()) {
      console.warn(
        `[usage/caps] LLM cap check failed for slug=${userSlug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    return {
      code: 'billing_state_error',
      message: billingStateErrorMessage(),
    };
  }
}

/**
 * Backward-compatible channel helper — returns message text or null.
 * Defaults to telegram-style URL embedding when billing is on.
 */
export function checkLlmCap(
  userSlug: string,
  isAdmin: boolean,
  opts?: { channel?: PaywallChannel; displayName?: string },
): string | null {
  const block = checkTurnAllowed(userSlug, isAdmin, {
    channel: opts?.channel ?? 'telegram',
    displayName: opts?.displayName,
  });
  return block ? block.message : null;
}
