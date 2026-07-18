/**
 * Demo DomainExtension — minimal purpose + billing plans + /plan command.
 */

import type { DomainExtension } from 'utarus';
import {
  getEntitlement,
  getEffectiveCap,
  isBillingEnabled,
  loadUsage,
  formatUsageReport,
} from 'utarus';
import { DEMO_PLANS } from './plans.js';
import { createHelloTool } from './tools/hello.js';

function planStatusText(userSlug: string, isAdmin: boolean): string {
  if (isAdmin) {
    return 'You are an **admin** — caps and paywall are bypassed.';
  }
  if (!isBillingEnabled()) {
    return (
      'Billing is **off** (`UTARUS_BILLING_ENABLED` is not `true`). ' +
      'Caps come from `data/config/caps.yaml` only.\n\n' +
      formatUsageReport(loadUsage(userSlug))
    );
  }
  const ent = getEntitlement(userSlug);
  const tokenCap = getEffectiveCap(userSlug, 'llm_total_tokens');
  const usage = loadUsage(userSlug);
  const lines = [
    `**Plan:** ${ent.display_name} (\`${ent.plan_id}\`)`,
    `**Status:** ${ent.status} (source: ${ent.source})`,
    `**Features:** ${ent.features.length ? ent.features.map((f) => `\`${f}\``).join(', ') : '_none_'}`,
    `**Tokens this month:** ${usage.period_llm.total_tokens.toLocaleString('en-US')}` +
      (tokenCap != null ? ` / ${tokenCap.toLocaleString('en-US')}` : ' (unlimited)'),
    '',
    'Upgrade: open **Billing** in the WebUI, or use `/upgrade` on Telegram/Slack.',
    '',
    formatUsageReport(usage),
  ];
  return lines.join('\n');
}

export const demoExtension: DomainExtension = {
  purpose: `You are **Demo**, a sample Utarus agent that demonstrates the Stripe paywall.

Your job:
- Be a friendly general assistant.
- When users hit usage limits, explain Free vs Pro clearly and point them to Billing / upgrade.
- Prefer the \`hello\` tool when they want a demo tool call.
- Do not invent billing state — use what the system tells you.

Scope: demo and paywall walkthrough only. Decline unrelated production-domain work.`,

  tools: (userSlug: string, _isAdmin: boolean) => [createHelloTool(userSlug)],

  skills: [],

  webCommands: [
    {
      name: 'plan',
      description: 'Show your plan, caps, and usage (no LLM)',
      adminOnly: false,
      handler: ({ userSlug, isAdmin }) => planStatusText(userSlug, isAdmin),
    },
  ],

  telegramCommands: [
    {
      name: 'plan',
      description: 'Show your plan, caps, and usage',
      adminOnly: false,
      handler: ({ telegramUserId, isAdmin }) => {
        // Resolve slug via framework tools is not available here; telegram layer
        // passes isAdmin — we need slug from user state. Use a thin re-export:
        // callers of telegramCommands don't pass userSlug; look up is done in handler
        // via resolve from telegram id is not imported. Simpler: require linked user
        // and use a dynamic import of state helpers.
        return import('utarus').then(async (u) => {
          const { resolveUserByTelegramUser } = u;
          const user = resolveUserByTelegramUser(telegramUserId);
          if (!user) {
            return 'Link your account first (invite code), then try /plan again.';
          }
          return planStatusText(user.user.slug, isAdmin);
        });
      },
    },
  ],

  slackCommands: [
    {
      name: 'plan',
      description: 'Show your plan, caps, and usage',
      adminOnly: false,
      handler: async ({ slackUserId, isAdmin }) => {
        const { resolveUserBySlackUser } = await import('utarus');
        const user = resolveUserBySlackUser(slackUserId);
        if (!user) {
          return 'Link your account first (invite code), then try /plan again.';
        }
        return planStatusText(user.user.slug, isAdmin);
      },
    },
  ],

  webUi: {
    agentKey: 'demo',
    productName: 'Demo',
    defaultPath: '/',
  },

  billing: {
    plans: DEMO_PLANS,
    copy: {
      upgradeCta: 'Upgrade to Pro',
      capHitTemplate:
        "🚫 You've hit your monthly cap ({current}/{cap}). {upgradeUrl}",
    },
  },
};
