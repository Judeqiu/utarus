/**
 * AssetFileCard — generic fallback for text/unknown kinds. Shows filename
 * with a download button.
 *
 * Spec: docs/webui-chat-design.md §8.3 (text & unknown rows).
 */

import { Download, FileText } from 'lucide-react';

interface AssetFileCardProps {
  url: string;
  filename: string;
  kind: string;
}

export function AssetFileCard({ url, filename, kind }: AssetFileCardProps) {
  return (
    <a
      href={downloadUrl(url)}
      className="my-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:border-slate-300 hover:bg-slate-50"
    >
      <FileText className="h-5 w-5 shrink-0 text-slate-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-slate-900">{filename}</div>
        <div className="text-xs uppercase tracking-wide text-slate-500">
          {kind} file
        </div>
      </div>
      <span className="inline-flex items-center gap-1 text-xs text-blue-600">
        <Download className="h-3 w-3" /> Download
      </span>
    </a>
  );
}

function downloadUrl(src: string): string {
  try {
    const u = new URL(src, window.location.origin);
    u.pathname = u.pathname.replace(/\/(raw|view)$/, '');
    return u.pathname + u.search;
  } catch {
    return src;
  }
}
