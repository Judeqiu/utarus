/**
 * Generic HTML report delivery for Utarus agents.
 *
 * Slack (and other chat UIs) must NOT rely on raw .html file attachments for
 * rendering — mobile clients show source. Persist to BinDrive and return a
 * signed /view URL (Content-Type: text/html).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { resolveDataRoot } from '../config.js';
import { signedBinDriveViewUrl } from '../webapp/auth.js';
import { markdownToHtml, wrapHtmlReport } from '../interfaces/slack/markdown-to-html.js';

/** True when the user explicitly wants an HTML report / browser page. */
export function wantsHtmlDelivery(userText: string): boolean {
  const t = (userText || '').toLowerCase();
  if (!t.trim()) return false;

  // Explicit format requests
  if (
    /\b(as\s+html|in\s+html|to\s+html|html\s+report|html\s+file|html\s+page|as\s+a\s+webpage|as\s+a\s+web\s+page)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(generate|create|make|export|post|send|share|publish|produce)\b[\s\S]{0,48}\bhtml\b/i.test(t)) {
    return true;
  }
  // Report-as-document (often long-form; deliver as viewable HTML)
  if (
    /\b(full\s+report|detailed\s+report|written\s+report|analysis\s+report|portfolio\s+report)\b/i.test(t) &&
    /\b(html|pdf|document|file|page|download|link)\b/i.test(t)
  ) {
    return true;
  }
  if (/\breport\b/i.test(t) && /\b(html|as\s+a\s+file|in\s+browser|open\s+in\s+browser)\b/i.test(t)) {
    return true;
  }
  return false;
}

export interface PublishHtmlReportParams {
  ownerSlug: string;
  title: string;
  /** Markdown body (converted) or raw HTML fragment/document. */
  content: string;
  /** default markdown */
  contentFormat?: 'markdown' | 'html';
  /** Optional filename; auto-generated if omitted. */
  filename?: string;
  agentName?: string;
}

export interface PublishHtmlReportResult {
  filename: string;
  absolutePath: string;
  viewUrl: string;
  expiresAt: number;
  expiresInMs: number;
  bytes: number;
}

function safeFilenamePart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'report';
}

/**
 * Write HTML to data/drive/<ownerSlug>/ and return a signed browser view URL.
 * Fails fast if UTARUS_REPORTS_URL is not configured (required for signed URLs).
 */
export function publishHtmlReport(params: PublishHtmlReportParams): PublishHtmlReportResult {
  const ownerSlug = params.ownerSlug?.trim();
  if (!ownerSlug) throw new Error('publishHtmlReport requires ownerSlug');
  if (!params.title?.trim()) throw new Error('publishHtmlReport requires title');
  if (!params.content?.trim()) throw new Error('publishHtmlReport requires content');

  const format = params.contentFormat ?? 'markdown';
  const agentName = params.agentName ?? 'Agent';

  let fullHtml: string;
  if (format === 'html' && /<html[\s>]/i.test(params.content)) {
    fullHtml = params.content;
  } else if (format === 'html') {
    fullHtml = wrapHtmlReport(params.title, params.content);
  } else {
    fullHtml = wrapHtmlReport(params.title, markdownToHtml(params.content));
  }

  const filename =
    params.filename?.replace(/[^a-zA-Z0-9._-]/g, '_') ||
    `${safeFilenamePart(agentName)}-${safeFilenamePart(params.title)}-${Date.now()}.html`;

  const driveDir = join(resolveDataRoot(), 'drive', ownerSlug);
  mkdirSync(driveDir, { recursive: true });
  const absolutePath = join(driveDir, filename);
  writeFileSync(absolutePath, fullHtml, 'utf-8');
  const bytes = Buffer.byteLength(fullHtml, 'utf-8');

  const signed = signedBinDriveViewUrl(ownerSlug, filename, {
    displayName: ownerSlug,
  });

  return {
    filename,
    absolutePath,
    viewUrl: signed.url,
    expiresAt: signed.expiresAt,
    expiresInMs: signed.expiresInMs,
    bytes,
  };
}
