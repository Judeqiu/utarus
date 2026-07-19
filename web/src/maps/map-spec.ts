/**
 * Pure map fence grammar + Google Maps Embed URL builder.
 * Mirror: src/maps/map-spec.ts (keep in lockstep — parity tests enforce).
 */

export type MapMode = 'place' | 'view';

export interface MapSpec {
  mode: MapMode;
  query?: string;
  lat?: number;
  lng?: number;
  zoom?: number;
  label?: string;
}

export type MapSpecResult =
  | { ok: true; spec: MapSpec }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const ALLOWED_QUERY_SCHEMES = new Set(['place_id:']);

const KEY_RE = /^[a-z]+$/;

function reject(error: string): MapSpecResult {
  return { ok: false, error };
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function validateQuery(raw: string): MapSpecResult & { ok: true; value: string } | MapSpecResult {
  const query = raw.trim();
  if (!query) return reject('query is empty');
  if (query.length > 200) return reject('query exceeds 200 characters');
  if (CONTROL_CHARS.test(query)) return reject('query contains control characters');
  if (SCHEME_PREFIX.test(query)) {
    const scheme = query.match(SCHEME_PREFIX)?.[0]?.toLowerCase() ?? '';
    if (!ALLOWED_QUERY_SCHEMES.has(scheme)) {
      return reject(`query must not use URI scheme "${scheme.replace(/:$/, '')}"`);
    }
  }
  return { ok: true, value: query } as MapSpecResult & { ok: true; value: string };
}

function validateLabel(raw: string): MapSpecResult & { ok: true; value: string } | MapSpecResult {
  const label = raw.trim();
  if (!label) return reject('label is empty');
  if (label.length > 80) return reject('label exceeds 80 characters');
  if (CONTROL_CHARS.test(label)) return reject('label contains control characters');
  return { ok: true, value: label } as MapSpecResult & { ok: true; value: string };
}

function validateZoom(raw: unknown): MapSpecResult & { ok: true; value: number } | MapSpecResult {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return reject('zoom must be an integer');
  }
  if (raw < 0 || raw > 21) return reject('zoom must be in [0, 21]');
  return { ok: true, value: raw } as MapSpecResult & { ok: true; value: number };
}

/**
 * Parse a ```map fence body into a MapSpec (mode always resolved).
 */
export function parseMapFenceBody(body: string): MapSpecResult {
  if (typeof body !== 'string') return reject('map fence body must be a string');
  const fields = new Map<string, string>();
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return reject(`invalid map line (expected key: value): ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!KEY_RE.test(key)) return reject(`invalid map field name: ${key}`);
    if (fields.has(key)) return reject(`duplicate map field: ${key}`);
    fields.set(key, value);
  }

  const raw: Record<string, unknown> = {};
  for (const [k, v] of fields) {
    if (k === 'lat' || k === 'lng') {
      if (v === '') return reject(`${k} is empty`);
      const n = Number(v);
      if (!Number.isFinite(n)) return reject(`${k} is not a number`);
      raw[k] = n;
    } else if (k === 'zoom') {
      if (v === '') return reject('zoom is empty');
      if (!/^-?\d+$/.test(v)) return reject('zoom must be an integer');
      raw[k] = Number(v);
    } else if (k === 'mode' || k === 'query' || k === 'label') {
      raw[k] = v;
    } else {
      return reject(`unknown map field: ${k}`);
    }
  }
  return validateMapSpec(raw);
}

/**
 * Validate a loose object (tool params or parsed fence) into MapSpec.
 * No silent defaults: mode omission is formal grammar only when query present.
 */
export function validateMapSpec(input: unknown): MapSpecResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return reject('map spec must be an object');
  }
  const o = input as Record<string, unknown>;
  const allowed = new Set(['mode', 'query', 'lat', 'lng', 'zoom', 'label']);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) return reject(`unknown map field: ${k}`);
  }

  let modeField: MapMode | undefined;
  if (o.mode !== undefined) {
    if (o.mode !== 'place' && o.mode !== 'view') {
      return reject('mode must be "place" or "view"');
    }
    modeField = o.mode;
  }

  let query: string | undefined;
  if (o.query !== undefined) {
    if (typeof o.query !== 'string') return reject('query must be a string');
    const q = validateQuery(o.query);
    if (!q.ok) return q;
    query = (q as { ok: true; value: string }).value;
  }

  let lat: number | undefined;
  let lng: number | undefined;
  if (o.lat !== undefined) {
    if (!isFiniteNumber(o.lat)) return reject('lat must be a finite number');
    if (o.lat < -90 || o.lat > 90) return reject('lat must be in [-90, 90]');
    lat = o.lat;
  }
  if (o.lng !== undefined) {
    if (!isFiniteNumber(o.lng)) return reject('lng must be a finite number');
    if (o.lng < -180 || o.lng > 180) return reject('lng must be in [-180, 180]');
    lng = o.lng;
  }
  if ((lat !== undefined) !== (lng !== undefined)) {
    return reject('lat and lng must both be present or both absent');
  }

  let zoom: number | undefined;
  if (o.zoom !== undefined) {
    const z = validateZoom(o.zoom);
    if (!z.ok) return z;
    zoom = (z as { ok: true; value: number }).value;
  }

  let label: string | undefined;
  if (o.label !== undefined) {
    if (typeof o.label !== 'string') return reject('label must be a string');
    const l = validateLabel(o.label);
    if (!l.ok) return l;
    label = (l as { ok: true; value: string }).value;
  }

  let mode: MapMode;
  if (modeField === 'place') {
    if (query === undefined) return reject('mode place requires query');
    mode = 'place';
  } else if (modeField === 'view') {
    if (lat === undefined || lng === undefined) {
      return reject('mode view requires lat and lng');
    }
    mode = 'view';
  } else if (query !== undefined) {
    mode = 'place';
  } else if (lat !== undefined && lng !== undefined) {
    mode = 'view';
  } else {
    return reject('map requires query or both lat and lng');
  }

  const spec: MapSpec = { mode };
  if (query !== undefined) spec.query = query;
  if (lat !== undefined) spec.lat = lat;
  if (lng !== undefined) spec.lng = lng;
  if (zoom !== undefined) spec.zoom = zoom;
  if (label !== undefined) spec.label = label;
  return { ok: true, spec };
}

/** Always emits fully resolved fence including mode; only set fields. */
export function toFence(spec: MapSpec): string {
  const lines = [`mode: ${spec.mode}`];
  if (spec.query !== undefined) lines.push(`query: ${spec.query}`);
  if (spec.lat !== undefined) lines.push(`lat: ${spec.lat}`);
  if (spec.lng !== undefined) lines.push(`lng: ${spec.lng}`);
  if (spec.zoom !== undefined) lines.push(`zoom: ${spec.zoom}`);
  if (spec.label !== undefined) lines.push(`label: ${spec.label}`);
  return lines.join('\n');
}

export function toOpenUrl(spec: MapSpec): string {
  if (spec.query !== undefined) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(spec.query)}`;
  }
  if (spec.lat === undefined || spec.lng === undefined) {
    throw new Error('toOpenUrl: view map requires lat and lng');
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${spec.lat},${spec.lng}`)}`;
}

export function buildGoogleEmbedUrl(spec: MapSpec, embedApiKey: string): string {
  if (typeof embedApiKey !== 'string' || !embedApiKey.trim()) {
    throw new Error('buildGoogleEmbedUrl: embedApiKey is empty');
  }
  const key = embedApiKey.trim();
  const params = new URLSearchParams();
  params.set('key', key);

  let path: string;
  if (spec.mode === 'place') {
    if (spec.query === undefined || !spec.query) {
      throw new Error('buildGoogleEmbedUrl: place mode requires query');
    }
    path = '/maps/embed/v1/place';
    params.set('q', spec.query);
  } else if (spec.mode === 'view') {
    if (spec.lat === undefined || spec.lng === undefined) {
      throw new Error('buildGoogleEmbedUrl: view mode requires lat and lng');
    }
    path = '/maps/embed/v1/view';
    params.set('center', `${spec.lat},${spec.lng}`);
  } else {
    throw new Error(`buildGoogleEmbedUrl: unknown mode`);
  }

  if (spec.zoom !== undefined) {
    params.set('zoom', String(spec.zoom));
  }

  const url = `https://www.google.com${path}?${params.toString()}`;
  if (!isAllowedMapEmbedUrl(url)) {
    throw new Error(`buildGoogleEmbedUrl: constructed URL failed allowlist: ${url}`);
  }
  return url;
}

export function isAllowedMapEmbedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.origin !== 'https://www.google.com') return false;
  if (!/^\/maps\/embed\/v1\/(place|view)$/.test(parsed.pathname)) return false;
  return true;
}
