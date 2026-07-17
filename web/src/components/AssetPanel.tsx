/**
 * AssetPanel — StoreClaw-style right-hand panel for viewing reports without
 * leaving the chat. Opened via AssetPanelContext from attachment cards and
 * inline html/pdf link cards.
 *
 * Desktop (lg+): inline column to the right of the thread.
 * Mobile: full-screen overlay. Both share the same header + body.
 */

import { Download, ExternalLink, FileCode, FileImage, FileText, X } from 'lucide-react';
import type { PanelAsset } from '../panel.js';
import { SANDBOX, downloadUrl, isSafeEmbedUrl } from './assets/SandboxedIframe.js';

interface AssetPanelProps {
  asset: PanelAsset;
  viewerSlug: string;
  onClose: () => void;
}

/** Ensure the iframe/img hits the /raw endpoint (correct Content-Type).
 *  /reports/* files are served directly — no /raw suffix exists there. */
function rawUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    if (u.pathname.startsWith('/reports/')) return u.pathname + u.search;
    if (!/\/(raw|view)$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/?$/, '/raw');
    }
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function AssetPanel({ asset, viewerSlug, onClose }: AssetPanelProps) {
  const src = rawUrl(asset.url);
  const embeddable =
    (asset.kind === 'html' || asset.kind === 'pdf') && isSafeEmbedUrl(src, viewerSlug);
  const label =
    asset.kind === 'pdf' ? 'PDF' : asset.kind === 'image' ? 'Image' : 'HTML report';

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-white lg:static lg:z-auto lg:w-1/2 lg:shrink-0 lg:border-l lg:border-stone-200">
      <div className="flex shrink-0 items-center gap-3 border-b border-stone-200 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#f0eeea] text-stone-700">
          {asset.kind === 'image' ? (
            <FileImage className="h-4 w-4" />
          ) : asset.kind === 'html' ? (
            <FileCode className="h-4 w-4" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium text-stone-900">
            {asset.filename}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-stone-400">
            {label}
          </div>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          title="Open in new tab"
          aria-label="Open in new tab"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <a
          href={downloadUrl(src)}
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          title="Download"
          aria-label="Download"
        >
          <Download className="h-4 w-4" />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          title="Close panel"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50">
        {embeddable ? (
          <iframe
            src={src}
            sandbox={SANDBOX}
            title={asset.filename}
            className="h-full w-full border-0 bg-white"
          />
        ) : asset.kind === 'image' ? (
          <div className="flex min-h-full items-center justify-center p-4">
            <img
              src={src}
              alt={asset.filename}
              className="max-h-full max-w-full rounded-lg border border-stone-200 bg-white"
            />
          </div>
        ) : (
          <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-stone-500">
              This file can't be previewed in the panel.
            </p>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700"
            >
              <ExternalLink className="h-4 w-4" /> Open in new tab
            </a>
          </div>
        )}
      </div>
    </aside>
  );
}
