/**
 * Channel-aware paywall copy and upgrade URL builder.
 *
 * - web: relative `/billing` (session cookie already present; no token mint)
 * - telegram/slack/cli: absolute enter URL with link token when public base set
 */

import { buildAuthedUrl } from '../webapp/auth.js';
import { getBillingExtension } from './plans.js';
import { isBillingEnabled } from './validate.js';
import type { PaywallChannel } from './types.js';

const ENTER_PATH = '/api/billing/enter';
const ENTER_RETURN = '/billing';
const ENTER_PATH_WITH_RETURN = `${ENTER_PATH}?return=${encodeURIComponent(ENTER_RETURN)}`;

/**
 * Public site origin for billing deep links (no trailing slash).
 * Prefer UTARUS_PUBLIC_BASE_URL; do not fall back to reports URL.
 */
export function publicBillingBaseUrl(): string | null {
  const raw = (process.env.UTARUS_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}

/**
 * Build upgrade URL for the channel. Returns undefined when billing is off,
 * or when bot channels lack UTARUS_PUBLIC_BASE_URL (caller still blocks).
 */
export function buildUpgradeUrl(
  userSlug: string,
  channel: PaywallChannel,
  opts?: { displayName?: string },
): string | undefined {
  if (!isBillingEnabled()) {
    return undefined;
  }
  if (channel === 'web') {
    return '/billing';
  }

  const base = publicBillingBaseUrl();
  if (!base) {
    return undefined;
  }

  const built = buildAuthedUrl(base, ENTER_PATH_WITH_RETURN, {
    user: {
      type: 'user',
      slug: userSlug,
      displayName: opts?.displayName || userSlug,
    },
    pathPrefix: ENTER_PATH,
    ttlMs: 60 * 60 * 1000,
    maxUses: 5,
  });
  return built.url;
}

export interface FormatPaywallMessageParams {
  current: number;
  cap: number;
  upgradeUrl?: string;
  channel: PaywallChannel;
  /** When set (tool caps), names the tool in the message. */
  toolName?: string;
}

/**
 * User-facing cap-hit message. Uses DomainExtension.billing.copy.capHitTemplate
 * when set; otherwise a built-in template.
 */
export function formatPaywallMessage(params: FormatPaywallMessageParams): string {
  const { current, cap, upgradeUrl, toolName } = params;
  const cur = current.toLocaleString('en-US');
  const capStr = cap.toLocaleString('en-US');

  const template = getBillingExtension()?.copy?.capHitTemplate;
  if (template) {
    // Template validated at boot to include {current}, {cap}, {upgradeUrl}
    return template
      .replaceAll('{current}', cur)
      .replaceAll('{cap}', capStr)
      .replaceAll('{upgradeUrl}', upgradeUrl ?? '');
  }

  if (toolName) {
    const base = `🚫 Monthly cap reached for \`${toolName}\` (${cur}/${capStr}).`;
    if (upgradeUrl) {
      return `${base} Upgrade: ${upgradeUrl}`;
    }
    if (isBillingEnabled()) {
      return `${base} Open Billing in the WebUI to upgrade, or ask an admin.`;
    }
    return `${base} Contact an admin to raise it.`;
  }

  const base =
    `🚫 You've hit your monthly LLM token cap (${cur}/${capStr} tokens).`;
  if (upgradeUrl) {
    const cta = getBillingExtension()?.copy?.upgradeCta || 'Upgrade';
    return `${base} ${cta}: ${upgradeUrl}`;
  }
  if (isBillingEnabled()) {
    return `${base} Open Billing in the WebUI to upgrade, or ask an admin.`;
  }
  return `${base} Contact an admin to raise it.`;
}

export function billingStateErrorMessage(): string {
  return 'Billing/usage state is temporarily unavailable. Please try again or contact support.';
}
