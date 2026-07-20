/**
 * Pure widget fence grammar + validation.
 * Mirror: web/src/widgets/widget-spec.ts (keep in lockstep — parity tests enforce).
 */

export type WidgetAction = 'open' | 'update';
export type WidgetPersistence = 'none' | 'bindrive';

export interface WidgetSpec {
  instanceId: string;
  kind: string;
  title: string;
  props: Record<string, unknown>;
  entry?: string;
  action: WidgetAction;
  summary?: string;
  persistence: WidgetPersistence;
}

export type WidgetSpecResult =
  | { ok: true; spec: WidgetSpec }
  | { ok: false; error: string };

/** Max UTF-8 byte length of JSON.stringify(props) in a fence / tool overlay. */
export const WIDGET_PROPS_MAX_BYTES = 64 * 1024;

/** Max UTF-8 byte length of JSON.stringify(state.data) in the store. */
export const WIDGET_STATE_DATA_MAX_BYTES = 512 * 1024;

/** Max UTF-8 byte length of entire fence body (all lines). */
export const WIDGET_FENCE_BODY_MAX_BYTES = WIDGET_PROPS_MAX_BYTES + 4 * 1024;

export const WIDGET_TITLE_MAX = 120;
export const WIDGET_SUMMARY_MAX = 200;

/** Parent waits this long for guest `ready` after iframe load + init. */
export const WIDGET_BRIDGE_READY_TIMEOUT_MS = 10_000;

export const WIDGET_KIND_RE = /^[a-z][a-z0-9-]{1,63}$/;
export const WIDGET_INSTANCE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Platform-reserved kind ids — domain may not register these. */
export const PLATFORM_WIDGET_KIND_IDS = ['html-bundle'] as const;

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

function reject(error: string): WidgetSpecResult {
  return { ok: false, error };
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateTitle(raw: string): WidgetSpecResult & { ok: true; value: string } | WidgetSpecResult {
  const title = raw.trim();
  if (!title) return reject('title is empty');
  if (title.length > WIDGET_TITLE_MAX) return reject(`title exceeds ${WIDGET_TITLE_MAX} characters`);
  if (CONTROL_CHARS.test(title)) return reject('title contains control characters');
  return { ok: true, value: title } as WidgetSpecResult & { ok: true; value: string };
}

function validateSummary(raw: string): WidgetSpecResult & { ok: true; value: string } | WidgetSpecResult {
  const summary = raw.trim();
  if (!summary) return reject('summary is empty');
  if (summary.length > WIDGET_SUMMARY_MAX) {
    return reject(`summary exceeds ${WIDGET_SUMMARY_MAX} characters`);
  }
  if (CONTROL_CHARS.test(summary)) return reject('summary contains control characters');
  return { ok: true, value: summary } as WidgetSpecResult & { ok: true; value: string };
}

/**
 * Parse a ```widget fence body into a WidgetSpec.
 * props MUST be last field; single-line minified JSON only.
 */
export function parseWidgetFenceBody(body: string): WidgetSpecResult {
  if (typeof body !== 'string') return reject('widget fence body must be a string');
  if (utf8Bytes(body) > WIDGET_FENCE_BODY_MAX_BYTES) {
    return reject(`widget fence body exceeds ${WIDGET_FENCE_BODY_MAX_BYTES} bytes`);
  }

  const fields = new Map<string, string>();
  let propsConsumed = false;
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (propsConsumed) return reject('fields after props');

    const colon = trimmed.indexOf(':');
    if (colon <= 0) return reject(`invalid widget line (expected key: value): ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!KEY_RE.test(key)) return reject(`invalid widget field name: ${key}`);
    if (fields.has(key)) return reject(`duplicate widget field: ${key}`);

    if (key === 'props') {
      // remainder of THIS line only (value already is that)
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        return reject(`props JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!isPlainObject(parsed)) return reject('props must be a plain JSON object');
      if (utf8Bytes(value) > WIDGET_PROPS_MAX_BYTES) {
        return reject(`props exceed WIDGET_PROPS_MAX_BYTES=${WIDGET_PROPS_MAX_BYTES}`);
      }
      fields.set(key, value);
      propsConsumed = true;
      continue;
    }

    fields.set(key, value);
  }

  const raw: Record<string, unknown> = {};
  for (const [k, v] of fields) {
    if (k === 'props') {
      raw.props = JSON.parse(v) as Record<string, unknown>;
    } else {
      raw[k] = v;
    }
  }
  return validateWidgetSpec(raw);
}

/**
 * Validate a loose object (tool params or parsed fence) into WidgetSpec.
 * No silent defaults for required fields.
 */
export function validateWidgetSpec(input: unknown): WidgetSpecResult {
  if (!isPlainObject(input)) return reject('widget spec must be an object');
  const o = input;
  const allowed = new Set([
    'action',
    'instanceId',
    'kind',
    'title',
    'summary',
    'entry',
    'props',
    'persistence',
  ]);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) return reject(`unknown widget field: ${k}`);
  }

  if (o.action !== 'open' && o.action !== 'update') {
    return reject('action must be open or update');
  }
  const action = o.action as WidgetAction;

  if (typeof o.instanceId !== 'string' || !WIDGET_INSTANCE_ID_RE.test(o.instanceId)) {
    return reject('instanceId must be a UUID');
  }
  const instanceId = o.instanceId;

  if (typeof o.kind !== 'string' || !WIDGET_KIND_RE.test(o.kind)) {
    return reject('kind must match WIDGET_KIND_RE');
  }
  const kind = o.kind;

  if (typeof o.title !== 'string') return reject('title must be a string');
  const titleR = validateTitle(o.title);
  if (!titleR.ok) return titleR;
  const title = (titleR as { ok: true; value: string }).value;

  if (o.persistence !== 'none' && o.persistence !== 'bindrive') {
    return reject('persistence must be none or bindrive');
  }
  const persistence = o.persistence as WidgetPersistence;

  let summary: string | undefined;
  if (o.summary !== undefined) {
    if (typeof o.summary !== 'string') return reject('summary must be a string');
    const sr = validateSummary(o.summary);
    if (!sr.ok) return sr;
    summary = (sr as { ok: true; value: string }).value;
  }

  let entry: string | undefined;
  if (o.entry !== undefined) {
    if (typeof o.entry !== 'string') return reject('entry must be a string');
    const e = o.entry.trim();
    if (!e) return reject('entry is empty');
    if (kind !== 'html-bundle') return reject('entry is only valid for html-bundle');
    entry = e;
  }

  if (!isPlainObject(o.props)) return reject('props must be a plain object');
  const propsJson = JSON.stringify(o.props);
  if (utf8Bytes(propsJson) > WIDGET_PROPS_MAX_BYTES) {
    return reject(`props exceed WIDGET_PROPS_MAX_BYTES=${WIDGET_PROPS_MAX_BYTES}`);
  }

  const spec: WidgetSpec = {
    action,
    instanceId,
    kind,
    title,
    props: o.props,
    persistence,
  };
  if (summary !== undefined) spec.summary = summary;
  if (entry !== undefined) spec.entry = entry;
  return { ok: true, spec };
}

/** Emit fully resolved single-line-props fence body (no outer ```). */
export function toFence(spec: WidgetSpec): string {
  const lines = [
    `action: ${spec.action}`,
    `instanceId: ${spec.instanceId}`,
    `kind: ${spec.kind}`,
    `title: ${spec.title}`,
  ];
  if (spec.summary !== undefined) lines.push(`summary: ${spec.summary}`);
  lines.push(`persistence: ${spec.persistence}`);
  if (spec.entry !== undefined) lines.push(`entry: ${spec.entry}`);
  lines.push(`props: ${JSON.stringify(spec.props)}`);
  return lines.join('\n');
}

/**
 * Allowlist for widget iframe entry URLs (host-built or agent html-bundle).
 * Same-origin paths only.
 */
export function isAllowedWidgetEntryUrl(
  src: string,
  ctx: { viewerSlug: string; agentKey: string | null },
): boolean {
  if (typeof src !== 'string' || !src.trim()) return false;
  let u: URL;
  try {
    u = new URL(src, 'http://widget.local');
  } catch {
    return false;
  }
  // Relative or same-origin only — reject absolute other hosts when parsed against base
  if (src.includes('://')) {
    try {
      const abs = new URL(src);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return false;
      // absolute URLs only allowed if path-only form is used relative in practice;
      // for server tools we expect path-only. Reject host-bearing absolute for safety.
      return false;
    } catch {
      return false;
    }
  }
  const path = u.pathname;
  if (path.includes('..') || path.includes('\\')) return false;

  if (path.startsWith('/domain-assets/')) {
    if (!ctx.agentKey) return false;
    const prefix = `/domain-assets/${ctx.agentKey}/`;
    if (!path.startsWith(prefix)) return false;
    if (u.search && u.search !== '') return false;
    return true;
  }

  if (path.startsWith('/reports/')) {
    if (path.includes('..')) return false;
    return true;
  }

  if (path.startsWith('/api/files/')) {
    const slug = u.searchParams.get('slug');
    if (!slug || slug !== ctx.viewerSlug) return false;
    for (const key of u.searchParams.keys()) {
      if (key !== 'slug' && key !== 't') return false;
    }
    return true;
  }

  return false;
}

/** Validate state.data size (store / tools). */
export function validateStateData(data: unknown): { ok: true } | { ok: false; error: string } {
  if (!isPlainObject(data)) return { ok: false, error: 'state data must be a plain object' };
  const json = JSON.stringify(data);
  if (utf8Bytes(json) > WIDGET_STATE_DATA_MAX_BYTES) {
    return {
      ok: false,
      error: `state data exceeds WIDGET_STATE_DATA_MAX_BYTES=${WIDGET_STATE_DATA_MAX_BYTES}`,
    };
  }
  return { ok: true };
}
