/**
 * remark-bindrive-assets — walks link/image nodes, recognises BinDrive URLs,
 * classifies them by extension, tags them with `data-asset-kind`, and
 * normalises their URL to the `/api/files/<name>/raw?slug=` form so the
 * browser gets the correct Content-Type.
 *
 * Spec: docs/webui-chat-design.md §8.4, §8.5.
 */

import type { Plugin } from 'unified';
import type { Root, Link, Image, Text } from 'mdast';
import { visit } from 'unist-util-visit';

export const EXT_KIND: Record<string, string> = {
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

// /api/files/<name>(/view|/raw)?slug=<ownerSlug>
const ASSET_PATH = /^\/api\/files\/([^/]+?)(?:\/(view|raw))?(?:\?.*?\bslug=([A-Za-z0-9_-]+).*?)?$/;

export interface BinDriveAssetMatch {
  filename: string;
  ownerSlug: string | undefined;
  kind: string;
  normalisedUrl: string;
}

export function classifyBinDriveUrl(
  rawUrl: string,
  viewerSlug: string,
): BinDriveAssetMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;

  const m = ASSET_PATH.exec(url.pathname + (url.search || ''));
  if (!m) return null;
  // ASSET_PATH combines pathname and search; re-split to be safe.
  const pathOnly = url.pathname;
  const m2 = /^\/api\/files\/([^/]+?)(?:\/(view|raw))?$/.exec(pathOnly);
  if (!m2) return null;
  const filename = decodeURIComponent(m2[1]);
  const ownerSlug = url.searchParams.get('slug') ?? undefined;

  // Owner-slug defence-in-depth (§8.7 rule 2). The server enforces this too;
  // we drop it on the floor here so we don't render broken embeds.
  if (ownerSlug && ownerSlug !== viewerSlug) return null;

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const kind = EXT_KIND[ext] ?? 'unknown';

  // Normalise to /raw so <img>/<video>/<audio>/<iframe> get the right
  // Content-Type from the server (§8.8). Keep the slug query param.
  const params = ownerSlug ? `?slug=${encodeURIComponent(ownerSlug)}` : '';
  const normalisedUrl = `/api/files/${encodeURIComponent(filename)}/raw${params}`;

  return { filename, ownerSlug, kind, normalisedUrl };
}

export interface RemarkBinDriveOptions {
  viewerSlug: string;
}

export const remarkBinDriveAssets: Plugin<[RemarkBinDriveOptions], Root> = (
  options,
) => {
  const { viewerSlug } = options;
  if (!viewerSlug) {
    throw new Error('remarkBinDriveAssets requires viewerSlug');
  }

  return (tree) => {
    visit(tree, ['link', 'image'], (node) => {
      if (node.type === 'link') {
        transformLink(node, viewerSlug);
      } else if (node.type === 'image') {
        transformImage(node, viewerSlug);
      }
    });
  };
};

function transformLink(node: Link, viewerSlug: string): void {
  const match = classifyBinDriveUrl(node.url, viewerSlug);
  if (!match) return;
  const data = (node.data ??= {});
  data.hProperties = {
    ...(data.hProperties as Record<string, unknown> | undefined),
    'data-asset-kind': match.kind,
    'data-asset-url': match.normalisedUrl,
    'data-asset-filename': match.filename,
  };
  node.url = match.normalisedUrl;

  // If the link text is empty or just echoes the URL, replace it with the
  // filename so the rendered card has something to show.
  const text = firstText(node);
  if (!text || text === node.url) {
    node.children = [{ type: 'text', value: match.filename }];
  }
}

function transformImage(node: Image, viewerSlug: string): void {
  const match = classifyBinDriveUrl(node.url, viewerSlug);
  if (!match) return;
  const data = (node.data ??= {});
  data.hProperties = {
    ...(data.hProperties as Record<string, unknown> | undefined),
    'data-asset-kind': match.kind,
    'data-asset-url': match.normalisedUrl,
    'data-asset-filename': match.filename,
  };
  node.url = match.normalisedUrl;
}

function firstText(node: Link): string | undefined {
  for (const child of node.children) {
    if ((child as Text).type === 'text') return (child as Text).value;
  }
  return undefined;
}
