/**
 * SandboxedIframe — embed for HTML reports and PDFs. Always carries the
 * exact sandbox attribute from §8.7 rule 3 (NO allow-top-navigation).
 *
 *   sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
 *
 * The src is verified same-origin before render (defence-in-depth; the
 * remark plugin and rehype-sanitize already strip cross-origin iframes).
 */

import { useMemo } from 'react';
import { Download, ExternalLink, FileText } from 'lucide-react';

interface SandboxedIframeProps {
  src: string;
  filename: string;
  kind: string;
  viewerSlug: string;
}

export const SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

export function SandboxedIframe({
  src,
  filename,
  kind,
  viewerSlug,
}: SandboxedIframeProps) {
  // Defence-in-depth: verify the URL is same-origin /api/files/.
  // If a foreign URL slips through (shouldn't happen — sanitize strips it),
  // render a link instead of embedding.
  const safe = useMemo(() => isSafeEmbedUrl(src, viewerSlug), [src, viewerSlug]);

  if (!safe) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline hover:text-blue-800"
      >
        {filename} (external)
      </a>
    );
  }

  const label = kind === 'pdf' ? 'PDF' : 'HTML report';

  return (
    <div className="my-3 rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-slate-700">
          <FileText className="h-4 w-4 shrink-0 text-slate-500" />
          <span className="truncate font-medium">{filename}</span>
          <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">
            {label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            <ExternalLink className="h-3 w-3" /> Open
          </a>
          <a
            href={downloadUrl(src)}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            <Download className="h-3 w-3" /> Download
          </a>
        </div>
      </div>
      <iframe
        src={src}
        sandbox={SANDBOX}
        title={filename}
        className="h-[600px] w-full rounded-b-lg bg-white"
        loading="lazy"
      />
    </div>
  );
}

export function isSafeEmbedUrl(src: string, viewerSlug: string): boolean {
  let u: URL;
  try {
    u = new URL(src, window.location.origin);
  } catch {
    return false;
  }
  if (u.origin !== window.location.origin) return false;
  // Public dual-published reports are not owner-scoped.
  if (u.pathname.startsWith('/reports/')) return true;
  if (!u.pathname.startsWith('/api/files/')) return false;
  const slug = u.searchParams.get('slug');
  // Owner-slug check: drop mismatches. Spec §8.7 rule 2.
  if (slug && slug !== viewerSlug) return false;
  return true;
}

export function downloadUrl(src: string): string {
  // Swap /raw or /view back to the download endpoint so the browser sets
  // Content-Disposition: attachment.
  try {
    const u = new URL(src, window.location.origin);
    u.pathname = u.pathname.replace(/\/(raw|view)$/, '');
    return u.pathname + u.search;
  } catch {
    return src;
  }
}
