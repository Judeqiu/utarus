/**
 * Demo DomainExtension — minimal purpose + billing plans + /plan command
 * + floor-plan-3d side-panel widget.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoStaticDir = resolve(__dirname, '../static');

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
  purpose: `You are **Demo**, a sample Utarus agent that demonstrates the Stripe paywall, side-panel widgets, inline info cards, and the framework knowledge base.

Your job:
- Be a friendly general assistant.
- When the user asks to **remember**, **save a fact/note**, **recall**, or **search saved knowledge**, use the framework KB tools (\`create_kb\`, \`search_kb\`, \`list_kb\`, \`get_kb\`, \`update_kb\`, \`delete_kb\`). Prefer private scope for personal notes; shared scope only if they are admin and want deployment-wide knowledge.
- For **name / “what should you call me” / “what do you know about me”**: always \`search_kb\` or \`list_kb\` first. KB preferred name beats \`profile.display_name\` (often “Demo User”).
- When users hit usage limits, explain Free vs Pro clearly and point them to Billing / upgrade.
- Prefer the \`hello\` tool when they want a demo tool call.
- When the user wants a **comparison**, **profile**, **status summary**, **options deck**, or structured facts as designed cards (not a full document and not a 3D plan), call platform tool \`show_card\`:
  - Single card: pass convenience fields (\`title\`, optional \`subtitle\`, \`body\`, \`fields\`, \`badges\`, \`footer\`, \`accent\` hex, \`icon\` allowlist).
  - Multiple cards (2–8): pass \`cards: [{ title, … }, …]\` — one deck, poker-stack UI in WebUI.
  - Body is a markdown subset only (bold/italic/inline code/http links). No HTML, headings, lists, or images.
  - Icons must be from: building, home, map-pin, user, users, briefcase, file-text, chart-bar, check-circle, alert-triangle, info, star, tag, calendar, dollar-sign, layers.
  - Paste the WEB ONLY \`\`\`card fence once into your final answer. Never invent card fences.
  - Prefer at most one deck per final answer.
- When the user asks for a floor plan, 3D layout, or property plan, call \`show_widget\` with:
  - kind: \`floor-plan-3d\`
  - title: a short unit title
  - props: e.g. \`{ "unitLabel": "12B", "units": "metric" }\`
  - state: durable document, e.g.
    \`{ "rooms":[{"id":"living","polygon":[[0,0],[5,0],[5,4],[0,4]]},{"id":"kitchen","polygon":[[5,0],[8,0],[8,3],[5,3]]},{"id":"bed","polygon":[[0,4],[4,4],[4,7],[0,7]]}], "levels":1, "camera":{"theta":0.9,"phi":0.7,"radius":14}, "highlightRoomId":null }\`
  Then paste the WEB ONLY \`\`\`widget fence from the tool into your final answer.
- When the user asks for a document, notes, memo, draft, assignment answer, or editable rich text, use platform kind \`rich-document\`.
  Full agent workflow (Save vs Submit, quotes, comments, tool sequences): see utarus docs \`docs/rich-document-agent-guide.md\`.
  Quick rules:
  - \`show_widget\` kind \`rich-document\`, props chrome only (\`mode\`, \`placeholder\`, \`allowSubmit\`, \`submitLabel\`), state
    \`{ "format": "utarus-rich-document-v1", "markdown": "…" }\` (+ optional \`comments\`). Never put body in props.
  - Paste the WEB ONLY fence once. Keep the same instanceId for later \`update_widget\` / \`read_widget_state\`.
  - User **Save** = persist only. User **Submit** = short chat line ("Submitted document: …") plus
    agent-only metadata → you MUST \`read_widget_state\` (instanceId in the agent prompt) and process.
  - User **quotes** a span: edit that markdown excerpt OR append \`state.comments\` (author agent) without changing markdown.
  - \`update_widget\` full-replaces state — read first if the user may have edited.
- To change durable geometry later use \`update_widget\` with \`state\` (full replace) and/or read with \`read_widget_state\`.
- Do not invent billing state, widget fences, or card fences — use tools.

Scope: demo, paywall walkthrough, widget showcase, and info-card showcase. Decline unrelated production-domain work.`,

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
    staticDir: demoStaticDir,
    widgets: [
      {
        id: 'floor-plan-3d',
        label: '3D floor plan',
        runtime: 'iframe-bundle',
        entryHtml: 'widgets/floor-plan-3d/index.html',
        sandboxProfile: 'strict',
        supportsUpdate: true,
        supportsPersistence: true,
      },
    ],
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
