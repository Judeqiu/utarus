/**
 * Build WebUI manifest for the SPA shell from DomainExtension.webUi.
 */

import type {
  ChatEmptyState,
  DomainExtension,
  DomainWebNavItem,
  DomainWebRoute,
} from '../extension.js';
import { config } from '../config.js';
import { isBillingEnabled } from '../billing/index.js';
import {
  buildWidgetRegistry,
  listWidgetRegistrations,
  type WidgetKindRegistration,
} from '../widgets/registry.js';

export interface WebUiManifest {
  agentKey: string | null;
  productName: string;
  defaultPath: string;
  nav: Array<DomainWebNavItem & { framework?: boolean }>;
  routes: DomainWebRoute[];
  /** Always present after widgets ship — platform + domain kinds. */
  widgets: WidgetKindRegistration[];
  /** Domain empty-chat guidance (WebUI). Null → SPA framework default. */
  chatEmptyState: ChatEmptyState | null;
}

function normalizeChatEmptyState(raw: ChatEmptyState | undefined): ChatEmptyState | null {
  if (!raw) return null;
  const title = raw.title?.trim();
  if (!title) {
    throw new Error('DomainWebUiExtension.chatEmptyState.title is required when chatEmptyState is set.');
  }
  if (!Array.isArray(raw.body) || raw.body.length === 0) {
    throw new Error('DomainWebUiExtension.chatEmptyState.body must be a non-empty string array.');
  }
  const body = raw.body.map((p, i) => {
    if (typeof p !== 'string' || !p.trim()) {
      throw new Error(`DomainWebUiExtension.chatEmptyState.body[${i}] must be a non-empty string.`);
    }
    return p.trim();
  });
  const bullets = raw.bullets?.map((b, i) => {
    if (typeof b !== 'string' || !b.trim()) {
      throw new Error(`DomainWebUiExtension.chatEmptyState.bullets[${i}] must be a non-empty string.`);
    }
    return b.trim();
  });
  const starters = raw.starters?.map((s, i) => {
    if (!s || typeof s.label !== 'string' || !s.label.trim()) {
      throw new Error(`DomainWebUiExtension.chatEmptyState.starters[${i}].label is required.`);
    }
    if (typeof s.message !== 'string' || !s.message.trim()) {
      throw new Error(`DomainWebUiExtension.chatEmptyState.starters[${i}].message is required.`);
    }
    return { label: s.label.trim(), message: s.message.trim() };
  });
  const footer = raw.footer?.trim() || undefined;
  return { title, body, bullets, starters, footer };
}

export function buildWebUiManifest(ext: DomainExtension): WebUiManifest {
  const webUi = ext.webUi;
  const productName = webUi?.productName?.trim() || config.agent.name || 'Agent';
  const widgetRegistry = buildWidgetRegistry(ext);
  const chatEmptyState = normalizeChatEmptyState(webUi?.chatEmptyState);

  const frameworkNav: Array<DomainWebNavItem & { framework?: boolean }> = [
    {
      id: 'chat',
      label: 'Chat',
      path: '/',
      icon: 'message-square',
      order: 0,
      framework: true,
    },
  ];

  if (isBillingEnabled()) {
    frameworkNav.push({
      id: 'billing',
      label: 'Billing',
      path: '/billing',
      icon: 'credit-card',
      order: 50,
      framework: true,
    });
  }

  const domainNav = (webUi?.nav ?? []).map((n) => ({ ...n, framework: false as const }));
  const adminNav: Array<DomainWebNavItem & { framework?: boolean }> = [
    {
      id: 'admin',
      label: 'Admin',
      path: '/admin',
      icon: 'shield',
      order: 1000,
      adminOnly: true,
      framework: true,
    },
  ];

  const nav = [...frameworkNav, ...domainNav, ...adminNav].sort(
    (a, b) => (a.order ?? 50) - (b.order ?? 50),
  );

  return {
    agentKey: webUi?.agentKey ?? null,
    productName,
    defaultPath: webUi?.defaultPath?.trim() || '/',
    nav,
    routes: webUi?.routes ?? [],
    widgets: listWidgetRegistrations(widgetRegistry),
    chatEmptyState,
  };
}
