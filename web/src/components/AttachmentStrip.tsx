/**
 * AttachmentStrip — file cards rendered below an assistant message.
 * Populated from the `done.assets[]` SSE field.
 *
 * Spec: docs/webui-chat-design.md §9 (chat page layout, "📎 3 attachments: …").
 */

import type { AssetRef } from '../types.js';
import { Download, FileText, FileImage, FileCode, FileSpreadsheet } from 'lucide-react';

interface AttachmentStripProps {
  assets: AssetRef[];
  viewerSlug: string;
}

export function AttachmentStrip({ assets, viewerSlug }: AttachmentStripProps) {
  const own = assets.filter((a) => a.ownerSlug === viewerSlug);
  if (own.length === 0) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      {own.map((a) => (
        <a
          key={a.url}
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex max-w-md items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f0eeea] text-stone-700">
            {iconFor(a.kind)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">
            {a.filename}
          </span>
          <Download className="h-4 w-4 shrink-0 text-stone-400" />
        </a>
      ))}
    </div>
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
