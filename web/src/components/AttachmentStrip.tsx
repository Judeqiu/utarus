/**
 * AttachmentStrip — small summary row rendered below an assistant message
 * bubble. Populated from the `done.assets[]` SSE field.
 *
 * Spec: docs/webui-chat-design.md §9 (chat page layout, "📎 3 attachments: …").
 */

import type { AssetRef } from '../types.js';
import { FileText, FileImage, FileCode, FileSpreadsheet } from 'lucide-react';

interface AttachmentStripProps {
  assets: AssetRef[];
  viewerSlug: string;
}

export function AttachmentStrip({ assets, viewerSlug }: AttachmentStripProps) {
  const own = assets.filter((a) => a.ownerSlug === viewerSlug);
  if (own.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
      <span className="font-medium">📎 {own.length} attachment{own.length === 1 ? '' : 's'}:</span>
      {own.map((a) => (
        <a
          key={a.url}
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 hover:bg-slate-200"
        >
          {iconFor(a.kind)}
          <span className="max-w-[200px] truncate">{a.filename}</span>
        </a>
      ))}
    </div>
  );
}

function iconFor(kind: AssetRef['kind']) {
  switch (kind) {
    case 'image':
      return <FileImage className="h-3 w-3" />;
    case 'csv':
      return <FileSpreadsheet className="h-3 w-3" />;
    case 'json':
      return <FileCode className="h-3 w-3" />;
    default:
      return <FileText className="h-3 w-3" />;
  }
}
