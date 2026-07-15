/**
 * Generic report publish — every HTML report written by Utarus agents should
 * go through here so openability is consistent across tools.
 *
 * Dual delivery:
 *   1. **Public durable URL** — `data/reports/<owner>-<filename>` served by
 *      Caddy at `{origin}/reports/...` (no auth, never expires).
 *   2. **Private BinDrive URL** — `data/drive/<owner>/<filename>` with a
 *      short-lived signed `?t=` token (default max 24h).
 *
 * Prefer the permanent public URL when pasting links into chat. The signed
 * link is for private BinDrive portal access; without `?t=` it redirects to
 * login and cannot open for most users.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { resolveDataRoot } from '../config.js';
import {
  signedBinDriveViewUrl,
  publicBinDriveOrigin,
  MAX_LINK_TOKEN_TTL_MS,
} from '../webapp/auth.js';

export interface PublishReportHtmlParams {
  /** Drive folder owner (seller slug or user slug). */
  ownerSlug: string;
  /**
   * File name only (no directory). Must end in .html for view routes.
   * Path separators and leading dots are rejected (fail fast).
   */
  filename: string;
  /** Full HTML document string. */
  html: string;
  /** Optional display name for the signed-token session. */
  displayName?: string;
  /**
   * Signed-link TTL in ms. Clamped by createLinkToken (min 1m, max 24h).
   * Default: MAX_LINK_TOKEN_TTL_MS (24h).
   */
  ttlMs?: number;
}

export interface PublishReportHtmlResult {
  filename: string;
  ownerSlug: string;
  /** Absolute path under data/drive/<owner>/ */
  drivePath: string;
  /** Absolute path under data/reports/ */
  publicPath: string;
  /** Public file name: `<owner>-<filename>` */
  publicFilename: string;
  /** Permanent open link — no auth. Prefer this in agent replies. */
  publicUrl: string;
  /** Private signed BinDrive /view URL (includes ?t=). */
  viewUrl: string;
  expiresAt: number;
  expiresInMs: number;
  bytes: number;
}

function assertSafeFilename(name: string): string {
  const safe = basename(name);
  if (!safe || safe !== name || safe.startsWith('.')) {
    throw new Error(`Invalid report filename: "${name}"`);
  }
  if (!safe.toLowerCase().endsWith('.html')) {
    throw new Error(`Report filename must end in .html (got "${safe}")`);
  }
  return safe;
}

/**
 * Write HTML to BinDrive + public reports/, mint signed view URL.
 * Fails fast if UTARUS_REPORTS_URL is missing (required for both URL kinds).
 */
export function publishReportHtml(params: PublishReportHtmlParams): PublishReportHtmlResult {
  const ownerSlug = params.ownerSlug?.trim();
  if (!ownerSlug) {
    throw new Error('publishReportHtml requires ownerSlug');
  }
  if (!params.html?.trim()) {
    throw new Error('publishReportHtml requires non-empty html');
  }

  const filename = assertSafeFilename(params.filename);
  const root = resolveDataRoot();
  const bytes = Buffer.byteLength(params.html, 'utf-8');

  // 1) BinDrive private copy
  const driveDir = join(root, 'drive', ownerSlug);
  mkdirSync(driveDir, { recursive: true });
  const drivePath = join(driveDir, filename);
  writeFileSync(drivePath, params.html, 'utf-8');

  // 2) Public durable copy (Caddy /reports/*)
  // Prefix with owner so multi-tenant files never collide.
  const publicFilename = `${ownerSlug}-${filename}`;
  const reportsDir = join(root, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const publicPath = join(reportsDir, publicFilename);
  writeFileSync(publicPath, params.html, 'utf-8');

  const origin = publicBinDriveOrigin();
  const publicUrl = `${origin}/reports/${encodeURIComponent(publicFilename)}`;

  // 3) Signed private link (max TTL by default)
  const signed = signedBinDriveViewUrl(ownerSlug, filename, {
    displayName: params.displayName || ownerSlug,
    ttlMs: params.ttlMs ?? MAX_LINK_TOKEN_TTL_MS,
  });

  return {
    filename,
    ownerSlug,
    drivePath,
    publicPath,
    publicFilename,
    publicUrl,
    viewUrl: signed.url,
    expiresAt: signed.expiresAt,
    expiresInMs: signed.expiresInMs,
    bytes,
  };
}

/**
 * Standard agent-facing lines for report links.
 * Permanent public URL first; signed private URL second.
 */
export function formatReportLinkMessage(links: {
  publicUrl: string;
  viewUrl: string;
  expiresInMs: number;
}): string {
  const ttlHours = Math.max(1, Math.round(links.expiresInMs / 3600000));
  return [
    `🌐 Open report (permanent, no login): ${links.publicUrl}`,
    `🔐 Private BinDrive link (~${ttlHours}h, requires full URL including &t=…): ${links.viewUrl}`,
    '',
    'YOU MUST paste the permanent URL above verbatim in your reply (use that one first).',
    'Never drop query parameters from URLs. Prefer the permanent /reports/ link.',
  ].join('\n');
}
