/**
 * Build WebUI manifest for the SPA shell from DomainExtension.webUi.
 */

import type { DomainExtension, DomainWebNavItem, DomainWebRoute } from '../extension.js';
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
}

export function buildWebUiManifest(ext: DomainExtension): WebUiManifest {
  const webUi = ext.webUi;
  const productName = webUi?.productName?.trim() || config.agent.name || 'Agent';
  const widgetRegistry = buildWidgetRegistry(ext);

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
  };
}
