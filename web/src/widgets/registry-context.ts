/**
 * Widget registry from WebUI manifest — provided by Shell, consumed by Chat/host.
 */

import { createContext, useContext } from 'react';

export interface WidgetKindRegistration {
  id: string;
  label: string;
  runtime: 'iframe-bundle';
  entryHtml?: string;
  propsSchema?: Record<string, unknown>;
  propsMaxBytes?: number;
  sandboxProfile: 'strict';
  supportsUpdate: boolean;
  supportsPersistence: boolean;
}

export interface WidgetRegistryClient {
  agentKey: string | null;
  byId: ReadonlyMap<string, WidgetKindRegistration>;
  registryAvailable: boolean;
  unavailableReason: string | null;
}

export const WidgetRegistryContext = createContext<WidgetRegistryClient | null>(null);

export function useWidgetRegistry(): WidgetRegistryClient {
  const ctx = useContext(WidgetRegistryContext);
  if (!ctx) {
    throw new Error('useWidgetRegistry used outside WidgetRegistryContext provider');
  }
  return ctx;
}

export function buildClientRegistry(opts: {
  agentKey: string | null;
  widgets: WidgetKindRegistration[] | undefined;
  fetchOk: boolean;
  fetchError?: string;
}): WidgetRegistryClient {
  if (!opts.fetchOk) {
    return {
      agentKey: opts.agentKey,
      byId: new Map(),
      registryAvailable: false,
      unavailableReason: opts.fetchError ?? 'WebUI manifest failed to load',
    };
  }
  if (opts.widgets === undefined) {
    return {
      agentKey: opts.agentKey,
      byId: new Map(),
      registryAvailable: false,
      unavailableReason: 'manifest.widgets missing — server upgrade required',
    };
  }
  const byId = new Map<string, WidgetKindRegistration>();
  for (const w of opts.widgets) {
    byId.set(w.id, w);
  }
  return {
    agentKey: opts.agentKey,
    byId,
    registryAvailable: true,
    unavailableReason: null,
  };
}
