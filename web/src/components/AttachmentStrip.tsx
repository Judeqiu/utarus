/**
 * AttachmentStrip — file cards rendered below an assistant message.
 * Populated from the `done.assets[]` SSE field.
 *
 * html/pdf/image cards open the file in the side panel (AssetPanelContext);
 * other kinds open in a new tab. The download icon always links directly.
 */

import { useContext } from 'react';
import type { AssetRef } from '../types.js';
import { AssetPanelContext } from '../panel.js';
import { downloadUrl } from './assets/SandboxedIframe.js';
import { Download, FileText, FileImage, FileCode, FileSpreadsheet } from 'lucide-react';

interface AttachmentStripProps {
  assets: AssetRef[];
  viewerSlug: string;
}

const PANEL_KINDS = new Set(['html', 'pdf', 'image']);

export function AttachmentStrip({ assets, viewerSlug }: AttachmentStripProps) {
  const openPanel = useContext(AssetPanelContext);
  const own = assets.filter((a) => a.ownerSlug === viewerSlug);
  if (own.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {own.map((a) => {
        if (PANEL_KINDS.has(a.kind)) {
          return (
            <div
              key={a.url}
              role="button"
              tabIndex={0}
              onClick={() => openPanel({ url: a.url, filename: a.filename, kind: a.kind })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPanel({ url: a.url, filename: a.filename, kind: a.kind });
                }
              }}
              className="flex max-w-md cursor-pointer items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
            >
              <CardBody kind={a.kind} filename={a.filename} />
              <a
                href={downloadUrl(a.url)}
                onClick={(e) => e.stopPropagation()}
                className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
                title="Download"
                aria-label={`Download ${a.filename}`}
              >
                <Download className="h-4 w-4" />
              </a>
            </div>
          );
        }
        return (
          <a
            key={a.url}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex max-w-md items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
          >
            <CardBody kind={a.kind} filename={a.filename} />
            <Download className="h-4 w-4 shrink-0 text-stone-400" />
          </a>
        );
      })}
    </div>
  );
}

function CardBody({ kind, filename }: { kind: AssetRef['kind']; filename: string }) {
  return (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f0eeea] text-stone-700">
        {iconFor(kind)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">
        {filename}
      </span>
    </>
  );
}

function iconFor(kind: AssetRef['kind']) {
  switch (kind) {
    case 'image':
      return <FileImage className="h-5 w-5" />;
    case 'csv':
      return <FileSpreadsheet className="h-5 w-5" />;
    case 'json':
      return <FileCode className="h-5 w-5" />;
    default:
      return <FileText className="h-5 w-5" />;
  }
}
