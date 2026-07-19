/**
 * read_image — fetch a public image URL and return it as a vision content part
 * so the model can actually see site plans, floor plans, screenshots, etc.
 *
 * Firecrawl/markdown only gives URL strings. Without this tool the model
 * correctly says it "cannot read images". User photo uploads already go
 * through WebUI attachments; this covers tool-discovered URLs mid-turn.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { requireActiveLlmRoute } from '../llm/run-context.js';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const FETCH_TIMEOUT_MS = 30_000;

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function ok(
  parts: AgentToolResult<unknown>['content'],
  details: unknown,
): AgentToolResult<unknown> {
  return { content: parts, details };
}

function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

function sniffMimeFromUrl(url: string): string | null {
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return null;
}

function normalizeMime(header: string | null, url: string): string {
  const raw = (header || '').split(';')[0]?.trim().toLowerCase() || '';
  if (raw === 'image/jpg') return 'image/jpeg';
  if (ALLOWED_MIME.has(raw)) return raw === 'image/jpg' ? 'image/jpeg' : raw;
  const fromUrl = sniffMimeFromUrl(url);
  if (fromUrl) return fromUrl;
  throw new Error(
    `Unsupported or missing Content-Type "${header || '(empty)'}". ` +
      'Allowed: image/jpeg, image/png, image/webp, image/gif.',
  );
}

export function createReadImageTool(): AgentTool {
  return {
    name: 'read_image',
    label: 'Read Image (vision)',
    description: [
      'Fetch a public http(s) image URL and attach the pixels for vision models',
      '(site plans, floor plans, listing photos, screenshots).',
      'Use when firecrawl/markdown only gave you an image URL but you need to read',
      'compass orientation, layout labels, floor plan dimensions, or other visual detail.',
      'Requires a vision-capable LLM (e.g. Kimi k3). Fail-fast if vision is disabled.',
      'Pass only direct image URLs (not HTML pages). One image per call.',
    ].join(' '),
    parameters: Type.Object({
      url: Type.String({
        description: 'Direct image URL (https preferred), e.g. a site-plan PNG from a listing CDN.',
      }),
      focus: Type.Optional(
        Type.String({
          description:
            'What to look for (e.g. "north arrow / compass orientation of Stack 08"). Helps your next reasoning step.',
        }),
      ),
    }),
    async execute(_id, raw) {
      try {
        const route = requireActiveLlmRoute('read_image');
        if (!route.resolved.capabilities.imageInput) {
          return fail(
            'read_image failed: active model for this turn does not accept image input ' +
              `(profile=${route.profileName}, model=${route.resolved.model.id}). ` +
              'Image turns must use the vision route; mid-turn upgrade is not supported.',
          );
        }

        const p = raw as { url?: string; focus?: string };
        const url = p.url?.trim();
        if (!url) return fail('read_image failed: url is required');

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return fail(`read_image failed: invalid URL "${url}"`);
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return fail('read_image failed: only http(s) image URLs are allowed');
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(url, {
            signal: controller.signal,
            headers: {
              Accept: 'image/*,*/*;q=0.8',
              'User-Agent': 'Utarus-read_image/1.0',
            },
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          return fail(`read_image failed: HTTP ${res.status} fetching ${url}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0) {
          return fail('read_image failed: empty response body');
        }
        if (buf.byteLength > MAX_BYTES) {
          return fail(
            `read_image failed: image is ${buf.byteLength} bytes (max ${MAX_BYTES}). Use a smaller asset.`,
          );
        }

        const mimeType = normalizeMime(res.headers.get('content-type'), url);
        const data = buf.toString('base64');
        const focus = p.focus?.trim();

        const note = [
          `Image loaded for vision (${mimeType}, ${buf.byteLength} bytes).`,
          `Source: ${url}`,
          focus ? `Focus requested: ${focus}` : null,
          'The image is attached below — read it directly (do not claim you cannot see images).',
        ]
          .filter(Boolean)
          .join('\n');

        return ok(
          [
            { type: 'text' as const, text: note },
            { type: 'image' as const, data, mimeType },
          ],
          {
            url,
            mimeType,
            bytes: buf.byteLength,
            focus: focus || null,
          },
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[read_image]', message);
        return fail(`read_image failed: ${message}`);
      }
    },
  };
}
