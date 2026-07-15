/**
 * Server-side asset extraction.
 *
 * Pure regex scan over the agent's final text. Finds every BinDrive asset
 * URL owned by the viewer and emits a structured AssetRef[]. Used to
 * populate the `done.assets[]` SSE field (§7.2) — the inline embeds come
 * from the markdown renderer walking the same text, this is parallel
 * metadata for the attachment strip and prefetch hints.
 *
 * Spec: docs/webui-chat-design.md §8.6
 */

import type { AssetKind, AssetRef } from './types.js';

const ASSET_URL = /(?:\/api\/files\/([a-z0-9._-]+)(?:\/view|\/raw)?\?slug=([a-z0-9-]+))/gi;

const EXT_KIND: Record<string, AssetKind> = {
  html: 'html',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  csv: 'csv',
  json: 'json',
  txt: 'text',
  md: 'text',
  log: 'text',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
};

/**
 * Scan `text` for BinDrive asset URLs owned by `viewerSlug`.
 * Cross-slug refs are stripped — the viewer is not allowed to embed
 * another user's files even if the agent mistakenly wrote such a URL.
 */
export function extractAssets(text: string, viewerSlug: string): AssetRef[] {
  const out = new Map<string, AssetRef>();
  for (const m of text.matchAll(ASSET_URL)) {
    const filename = m[1];
    const ownerSlug = m[2];
    if (!filename || !ownerSlug) continue;
    if (ownerSlug !== viewerSlug) continue;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const kind: AssetKind = EXT_KIND[ext] ?? 'unknown';
    const url = m[0];
    if (out.has(url)) continue;
    out.set(url, { kind, url, filename, ownerSlug });
  }
  return [...out.values()];
}
