/**
 * Pure card fence grammar + validation + plain summary.
 * Mirror: src/cards/card-spec.ts (keep in lockstep — parity tests enforce).
 * Only allowed divergence: utf8Bytes (Buffer vs TextEncoder).
 */

import { fromMarkdown } from 'mdast-util-from-markdown';

/** Fence language tag (case-sensitive). */
export const CARD_FENCE_LANG = 'card' as const;

/** Protocol version emitted by tools; client accepts only this value in v1. */
export const CARD_SPEC_VERSION = 1 as const;

export type CardLayout = 'stack';

/** Max cards in one deck fence. */
export const CARD_DECK_MAX_CARDS = 8;

/** Max key-value rows per card. */
export const CARD_FIELDS_MAX = 12;

/** Max badges per card. */
export const CARD_BADGES_MAX = 6;

export const CARD_TITLE_MAX = 80;
export const CARD_SUBTITLE_MAX = 120;
export const CARD_BODY_MAX = 800;
export const CARD_FOOTER_MAX = 160;
export const CARD_FIELD_LABEL_MAX = 40;
export const CARD_FIELD_VALUE_MAX = 200;
export const CARD_BADGE_LABEL_MAX = 24;

/** Max UTF-8 byte length of entire fence body. */
export const CARD_FENCE_BODY_MAX_BYTES = 24 * 1024;

/** Max UTF-8 byte length of the minified `cards` JSON array alone. */
export const CARD_CARDS_JSON_MAX_BYTES = 20 * 1024;

/** Max chars of body first line included in toPlainSummary. */
export const CARD_SUMMARY_BODY_MAX = 120;

/** Plain-text summary hard cap (characters). */
export const CARD_SUMMARY_MAX_CHARS = 3500;

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const CARD_ICON_ALLOWLIST = [
  'building',
  'home',
  'map-pin',
  'user',
  'users',
  'briefcase',
  'file-text',
  'chart-bar',
  'check-circle',
  'alert-triangle',
  'info',
  'star',
  'tag',
  'calendar',
  'dollar-sign',
  'layers',
] as const;

export type CardIconName = (typeof CARD_ICON_ALLOWLIST)[number];

const ICON_SET = new Set<string>(CARD_ICON_ALLOWLIST);
const BADGE_TONES = new Set<string>(['neutral', 'success', 'warning', 'danger', 'info']);
const ACCENT_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const HTML_TAG_LIKE = /<[a-zA-Z/!?]/;
const BODY_ALLOWED_TYPES = new Set([
  'root',
  'paragraph',
  'text',
  'emphasis',
  'strong',
  'inlineCode',
  'link',
]);

export interface CardField {
  label: string;
  value: string;
}

export interface CardBadge {
  label: string;
  tone?: BadgeTone;
}

export interface InfoCardSpec {
  title: string;
  subtitle?: string;
  body?: string;
  fields?: CardField[];
  badges?: CardBadge[];
  footer?: string;
  accent?: string;
  icon?: CardIconName;
}

export interface InfoCardDeckSpec {
  version: typeof CARD_SPEC_VERSION;
  layout: CardLayout;
  cards: InfoCardSpec[];
}

export type CardSpecResult =
  | { ok: true; spec: InfoCardDeckSpec }
  | { ok: false; error: string };

export type CardBodyResult =
  | { ok: true; body: string }
  | { ok: false; error: string };

export type InfoCardResult =
  | { ok: true; card: InfoCardSpec }
  | { ok: false; error: string };

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function reject(error: string): CardSpecResult {
  return { ok: false, error };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateNonEmptyString(
  raw: unknown,
  field: string,
  max: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: `${field} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${field} is empty` };
  if (value.length > max) return { ok: false, error: `${field} exceeds ${max} characters` };
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, error: `${field} contains control characters` };
  }
  return { ok: true, value };
}

/**
 * Validate card body markdown subset (mdast allowlist).
 */
export function validateCardBodyMarkdown(body: string): CardBodyResult {
  if (typeof body !== 'string') return { ok: false, error: 'body must be a string' };
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (CONTROL_CHARS.test(normalized)) {
    return { ok: false, error: 'body contains control characters' };
  }
  if (normalized.trim().length === 0) return { ok: false, error: 'body is empty' };
  if (normalized.length > CARD_BODY_MAX) {
    return { ok: false, error: `body exceeds ${CARD_BODY_MAX} characters` };
  }
  if (HTML_TAG_LIKE.test(normalized)) {
    return { ok: false, error: 'body must not contain HTML' };
  }

  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(normalized);
  } catch (e) {
    return {
      ok: false,
      error: `body markdown parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as { type?: string; children?: unknown[]; url?: string; title?: unknown };
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      return { ok: false, error: 'body contains invalid markdown node' };
    }
    if (!BODY_ALLOWED_TYPES.has(node.type)) {
      return {
        ok: false,
        error: `body contains disallowed markdown construct: ${node.type}`,
      };
    }
    if (node.type === 'link') {
      if (typeof node.url !== 'string' || !node.url) {
        return { ok: false, error: 'body link url is empty' };
      }
      let u: URL;
      try {
        u = new URL(node.url);
      } catch {
        return { ok: false, error: `body link url is invalid: ${node.url}` };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, error: `body link scheme not allowed: ${u.protocol}` };
      }
      if (node.title !== undefined && node.title !== null) {
        if (typeof node.title !== 'string') {
          return { ok: false, error: 'body link title must be a string' };
        }
        if (CONTROL_CHARS.test(node.title)) {
          return { ok: false, error: 'body link title contains control characters' };
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) stack.push(child);
    }
  }

  return { ok: true, body: normalized };
}

function validateField(
  raw: unknown,
  index: number,
): { ok: true; field: CardField } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `fields[${index}] must be an object` };
  }
  const allowed = new Set(['label', 'value']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `fields[${index}] unknown field: ${k}` };
    }
  }
  const labelR = validateNonEmptyString(raw.label, `fields[${index}].label`, CARD_FIELD_LABEL_MAX);
  if (!labelR.ok) return labelR;
  const valueR = validateNonEmptyString(raw.value, `fields[${index}].value`, CARD_FIELD_VALUE_MAX);
  if (!valueR.ok) return valueR;
  return {
    ok: true,
    field: { label: labelR.value, value: valueR.value },
  };
}

function validateBadge(
  raw: unknown,
  index: number,
): { ok: true; badge: CardBadge } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `badges[${index}] must be an object` };
  }
  const allowed = new Set(['label', 'tone']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `badges[${index}] unknown field: ${k}` };
    }
  }
  const labelR = validateNonEmptyString(raw.label, `badges[${index}].label`, CARD_BADGE_LABEL_MAX);
  if (!labelR.ok) return labelR;
  const badge: CardBadge = { label: labelR.value };
  if (raw.tone !== undefined) {
    if (typeof raw.tone !== 'string' || !BADGE_TONES.has(raw.tone)) {
      return {
        ok: false,
        error: `badges[${index}].tone must be one of neutral|success|warning|danger|info`,
      };
    }
    badge.tone = raw.tone as BadgeTone;
  }
  return { ok: true, badge };
}

/**
 * Validate one card object.
 */
export function validateInfoCardSpec(input: unknown): InfoCardResult {
  if (!isPlainObject(input)) return { ok: false, error: 'card must be an object' };
  const allowed = new Set([
    'title',
    'subtitle',
    'body',
    'fields',
    'badges',
    'footer',
    'accent',
    'icon',
  ]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) return { ok: false, error: `unknown card field: ${k}` };
  }

  const titleR = validateNonEmptyString(input.title, 'title', CARD_TITLE_MAX);
  if (!titleR.ok) return titleR;

  const card: InfoCardSpec = { title: titleR.value };

  if (input.subtitle !== undefined) {
    const r = validateNonEmptyString(input.subtitle, 'subtitle', CARD_SUBTITLE_MAX);
    if (!r.ok) return r;
    card.subtitle = r.value;
  }

  if (input.body !== undefined) {
    const br = validateCardBodyMarkdown(input.body as string);
    if (!br.ok) return br;
    card.body = br.body;
  }

  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) return { ok: false, error: 'fields must be an array' };
    if (input.fields.length === 0) return { ok: false, error: 'fields must not be empty when present' };
    if (input.fields.length > CARD_FIELDS_MAX) {
      return { ok: false, error: `fields exceed max ${CARD_FIELDS_MAX}` };
    }
    const fields: CardField[] = [];
    for (let i = 0; i < input.fields.length; i++) {
      const fr = validateField(input.fields[i], i);
      if (!fr.ok) return fr;
      fields.push(fr.field);
    }
    card.fields = fields;
  }

  if (input.badges !== undefined) {
    if (!Array.isArray(input.badges)) return { ok: false, error: 'badges must be an array' };
    if (input.badges.length === 0) return { ok: false, error: 'badges must not be empty when present' };
    if (input.badges.length > CARD_BADGES_MAX) {
      return { ok: false, error: `badges exceed max ${CARD_BADGES_MAX}` };
    }
    const badges: CardBadge[] = [];
    for (let i = 0; i < input.badges.length; i++) {
      const br = validateBadge(input.badges[i], i);
      if (!br.ok) return br;
      badges.push(br.badge);
    }
    card.badges = badges;
  }

  if (input.footer !== undefined) {
    const r = validateNonEmptyString(input.footer, 'footer', CARD_FOOTER_MAX);
    if (!r.ok) return r;
    card.footer = r.value;
  }

  if (input.accent !== undefined) {
    if (typeof input.accent !== 'string' || !ACCENT_RE.test(input.accent)) {
      return {
        ok: false,
        error: 'accent must be #RGB or #RRGGBB hex',
      };
    }
    card.accent = input.accent;
  }

  if (input.icon !== undefined) {
    if (typeof input.icon !== 'string' || !ICON_SET.has(input.icon)) {
      return { ok: false, error: `icon must be one of: ${CARD_ICON_ALLOWLIST.join(', ')}` };
    }
    card.icon = input.icon as CardIconName;
  }

  return { ok: true, card };
}

/**
 * Validate a loose deck object (tool params or parsed fence).
 */
export function validateCardDeckSpec(input: unknown): CardSpecResult {
  if (!isPlainObject(input)) return reject('card deck must be an object');
  const allowed = new Set(['version', 'layout', 'cards']);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) return reject(`unknown deck field: ${k}`);
  }

  if (input.version !== 1 && input.version !== '1') {
    return reject('version must be 1');
  }
  // Accept string "1" only from fence parse path; coerce only that exact form.
  if (input.version === '1') {
    // fence path
  } else if (input.version !== 1) {
    return reject('version must be 1');
  }

  if (input.layout !== 'stack') {
    return reject('layout must be "stack"');
  }

  if (!Array.isArray(input.cards)) return reject('cards must be an array');
  if (input.cards.length < 1) return reject('cards must contain at least one card');
  if (input.cards.length > CARD_DECK_MAX_CARDS) {
    return reject(`cards exceed max ${CARD_DECK_MAX_CARDS}`);
  }

  const cards: InfoCardSpec[] = [];
  for (let i = 0; i < input.cards.length; i++) {
    const cr = validateInfoCardSpec(input.cards[i]);
    if (!cr.ok) return reject(`cards[${i}]: ${cr.error}`);
    cards.push(cr.card);
  }

  return {
    ok: true,
    spec: {
      version: CARD_SPEC_VERSION,
      layout: 'stack',
      cards,
    },
  };
}

/**
 * Parse a ```card fence body into InfoCardDeckSpec.
 * cards MUST be last field; single-line minified JSON only.
 */
export function parseCardFenceBody(body: string): CardSpecResult {
  if (typeof body !== 'string') return reject('card fence body must be a string');
  if (utf8Bytes(body) > CARD_FENCE_BODY_MAX_BYTES) {
    return reject(`card fence body exceeds ${CARD_FENCE_BODY_MAX_BYTES} bytes`);
  }

  const fields = new Map<string, string>();
  let cardsConsumed = false;
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (cardsConsumed) return reject('fields after cards');

    const colon = trimmed.indexOf(':');
    if (colon <= 0) return reject(`invalid card line (expected key: value): ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!KEY_RE.test(key)) return reject(`invalid card field name: ${key}`);
    if (fields.has(key)) return reject(`duplicate card field: ${key}`);

    if (key === 'cards') {
      if (utf8Bytes(value) > CARD_CARDS_JSON_MAX_BYTES) {
        return reject(`cards exceed CARD_CARDS_JSON_MAX_BYTES=${CARD_CARDS_JSON_MAX_BYTES}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch (e) {
        return reject(`cards JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!Array.isArray(parsed)) return reject('cards must be a JSON array');
      fields.set(key, value);
      cardsConsumed = true;
      continue;
    }

    if (key !== 'version' && key !== 'layout') {
      return reject(`unknown card field: ${key}`);
    }

    fields.set(key, value);
  }

  if (!fields.has('cards')) return reject('cards is required');
  if (!fields.has('version')) return reject('version is required');
  if (!fields.has('layout')) return reject('layout is required');

  const raw: Record<string, unknown> = {
    version: fields.get('version'),
    layout: fields.get('layout'),
    cards: JSON.parse(fields.get('cards')!) as unknown[],
  };

  // version from fence is a string; validateCardDeckSpec accepts "1"
  if (raw.version === '1') {
    // ok
  } else if (raw.version === '1.0') {
    return reject('version must be 1');
  } else {
    // try integer string
    if (typeof raw.version === 'string' && /^-?\d+$/.test(raw.version)) {
      raw.version = Number(raw.version);
    }
  }

  return validateCardDeckSpec(raw);
}

/** Emit fully resolved fence body (no outer ```). */
export function toFence(spec: InfoCardDeckSpec): string {
  return [
    `version: ${spec.version}`,
    `layout: ${spec.layout}`,
    `cards: ${JSON.stringify(spec.cards)}`,
  ].join('\n');
}

function stripMarkdownForSummary(body: string): string {
  let s = body;
  s = s.replace(/\*\*/g, '');
  s = s.replace(/\*/g, '');
  s = s.replace(/`/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > CARD_SUMMARY_BODY_MAX) {
    return s.slice(0, CARD_SUMMARY_BODY_MAX) + '…';
  }
  return s;
}

function formatCardBlock(card: InfoCardSpec, index1: number): string {
  const lines: string[] = [];
  let head = `${index1}. ${card.title}`;
  if (card.subtitle !== undefined) head += ` — ${card.subtitle}`;
  lines.push(head);
  if (card.fields) {
    for (const f of card.fields) {
      lines.push(`  ${f.label}: ${f.value}`);
    }
  }
  if (card.badges) {
    lines.push(`  [${card.badges.map((b) => b.label).join('] [')}]`);
  }
  if (card.body !== undefined) {
    lines.push(`  ${stripMarkdownForSummary(card.body)}`);
  }
  return lines.join('\n');
}

/**
 * Deterministic plain-text summary for all channels.
 */
export function toPlainSummary(spec: InfoCardDeckSpec): string {
  const blocks = spec.cards.map((c, i) => formatCardBlock(c, i + 1));
  let full = blocks.join('\n\n');
  if (full.length <= CARD_SUMMARY_MAX_CHARS) return full;

  // Keep whole cards from the start until next would exceed cap.
  const kept: string[] = [];
  let len = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const extra = i === 0 ? block.length : block.length + 2; // blank line
    if (len + extra > CARD_SUMMARY_MAX_CHARS) break;
    kept.push(block);
    len += extra;
  }
  if (kept.length > 0) return kept.join('\n\n');

  // Even card 1 exceeds — hard-slice
  const first = blocks[0]!;
  return first.slice(0, CARD_SUMMARY_MAX_CHARS - 1) + '…';
}
