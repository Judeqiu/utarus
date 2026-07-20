/**
 * Widget kind registry — platform builtins + domain DomainWebUiExtension.widgets.
 */

import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { DomainExtension } from '../extension.js';
import {
  PLATFORM_WIDGET_KIND_IDS,
  WIDGET_KIND_RE,
  WIDGET_PROPS_MAX_BYTES,
} from './widget-spec.js';

export type WidgetSandboxProfile = 'strict';
export type WidgetRuntime = 'iframe-bundle';

export interface WidgetKindRegistration {
  id: string;
  label: string;
  runtime: WidgetRuntime;
  entryHtml?: string;
  propsSchema?: Record<string, unknown>;
  propsMaxBytes?: number;
  sandboxProfile: WidgetSandboxProfile;
  supportsUpdate: boolean;
  supportsPersistence: boolean;
}

export const PLATFORM_HTML_BUNDLE_KIND: WidgetKindRegistration = {
  id: 'html-bundle',
  label: 'HTML bundle',
  runtime: 'iframe-bundle',
  sandboxProfile: 'strict',
  supportsUpdate: false,
  supportsPersistence: false,
};

export interface WidgetRegistry {
  byId: ReadonlyMap<string, WidgetKindRegistration>;
  agentKey: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertEntryHtmlSafe(entryHtml: string): void {
  if (!entryHtml || typeof entryHtml !== 'string') {
    throw new Error('widget entryHtml must be a non-empty string');
  }
  if (
    entryHtml.includes('..') ||
    entryHtml.startsWith('/') ||
    entryHtml.includes('\\') ||
    entryHtml.includes('://') ||
    entryHtml.includes('?') ||
    entryHtml.includes('#')
  ) {
    throw new Error(`widget entryHtml is unsafe: "${entryHtml}"`);
  }
}

/**
 * Fail-fast boot validation for domain widget registrations.
 */
export function assertWidgetRegistrations(ext: DomainExtension): void {
  const webUi = ext.webUi;
  const widgets = webUi?.widgets;
  if (widgets === undefined) return;
  if (!Array.isArray(widgets)) {
    throw new Error('DomainWebUiExtension.widgets must be an array');
  }

  const seen = new Set<string>();
  for (const raw of widgets) {
    if (!isPlainObject(raw)) {
      throw new Error('each widget registration must be a plain object');
    }
    const r = raw as unknown as WidgetKindRegistration;
    if (typeof r.id !== 'string' || !WIDGET_KIND_RE.test(r.id)) {
      throw new Error(`widget id invalid: ${String(r.id)}`);
    }
    if (seen.has(r.id)) {
      throw new Error(`duplicate widget id: ${r.id}`);
    }
    seen.add(r.id);
    if ((PLATFORM_WIDGET_KIND_IDS as readonly string[]).includes(r.id)) {
      throw new Error(`widget id reserved for platform: ${r.id}`);
    }
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 80) {
      throw new Error(`widget label invalid for ${r.id}`);
    }
    if (r.runtime !== 'iframe-bundle') {
      throw new Error(`widget ${r.id}: runtime must be iframe-bundle`);
    }
    if (r.sandboxProfile !== 'strict') {
      throw new Error(`widget ${r.id}: sandboxProfile must be strict`);
    }
    if (typeof r.supportsUpdate !== 'boolean') {
      throw new Error(`widget ${r.id}: supportsUpdate is required boolean`);
    }
    if (typeof r.supportsPersistence !== 'boolean') {
      throw new Error(`widget ${r.id}: supportsPersistence is required boolean`);
    }
    if (r.supportsPersistence && !r.supportsUpdate) {
      throw new Error(
        `widget ${r.id}: supportsPersistence requires supportsUpdate true in v1`,
      );
    }
    if (typeof r.entryHtml !== 'string' || !r.entryHtml.trim()) {
      throw new Error(`widget ${r.id}: entryHtml is required for domain kinds`);
    }
    assertEntryHtmlSafe(r.entryHtml);
    if (r.propsMaxBytes !== undefined) {
      if (
        typeof r.propsMaxBytes !== 'number' ||
        !Number.isInteger(r.propsMaxBytes) ||
        r.propsMaxBytes < 1 ||
        r.propsMaxBytes > WIDGET_PROPS_MAX_BYTES
      ) {
        throw new Error(
          `widget ${r.id}: propsMaxBytes must be integer 1..${WIDGET_PROPS_MAX_BYTES}`,
        );
      }
    }
    if (r.propsSchema !== undefined && !isPlainObject(r.propsSchema)) {
      throw new Error(`widget ${r.id}: propsSchema must be a plain object when present`);
    }
  }

  if (widgets.length > 0) {
    const agentKey = webUi?.agentKey?.trim();
    const staticDir = webUi?.staticDir?.trim();
    if (!agentKey) {
      throw new Error('widgets registered but webUi.agentKey is missing');
    }
    if (!staticDir) {
      throw new Error('widgets registered but webUi.staticDir is missing');
    }
    if (!existsSync(staticDir) || !statSync(staticDir).isDirectory()) {
      throw new Error(`webUi.staticDir does not exist or is not a directory: ${staticDir}`);
    }
    for (const r of widgets) {
      const full = join(staticDir, r.entryHtml!);
      if (!existsSync(full) || !statSync(full).isFile()) {
        throw new Error(`widget ${r.id}: entryHtml file missing: ${full}`);
      }
    }
  }

  // Platform constant integrity
  const p = PLATFORM_HTML_BUNDLE_KIND;
  if (
    p.id !== 'html-bundle' ||
    p.supportsUpdate !== false ||
    p.supportsPersistence !== false ||
    p.entryHtml !== undefined ||
    p.sandboxProfile !== 'strict'
  ) {
    throw new Error('PLATFORM_HTML_BUNDLE_KIND is misconfigured');
  }
}

export function buildWidgetRegistry(ext: DomainExtension): WidgetRegistry {
  assertWidgetRegistrations(ext);
  const map = new Map<string, WidgetKindRegistration>();
  map.set(PLATFORM_HTML_BUNDLE_KIND.id, { ...PLATFORM_HTML_BUNDLE_KIND });
  for (const w of ext.webUi?.widgets ?? []) {
    map.set(w.id, { ...w });
  }
  return {
    byId: map,
    agentKey: ext.webUi?.agentKey?.trim() || null,
  };
}

/** Serialisable list for WebUI manifest (platform + domain). */
export function listWidgetRegistrations(reg: WidgetRegistry): WidgetKindRegistration[] {
  return Array.from(reg.byId.values()).map((w) => ({ ...w }));
}
