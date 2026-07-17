/**
 * AssetLink — handles <a> nodes in rendered markdown. Decides embed-vs-link
 * based on the `data-asset-kind` tag injected by remark-bindrive-assets.
 *
 * Spec: docs/webui-chat-design.md §8.5 (component responsibilities).
 *
 * Kinds:
 *   html/pdf → file card that opens the report in the side panel
 *   image → fall through to <a> (the markdown <img> renderer handles inline).
 *   csv  → <CsvTable> (fetch + parse).
 *   json → <AssetJson> (table if array-of-objects, else code block).
 *   text/unknown → file card.
 *   no data-asset-kind → external link, target=_blank rel=noopener.
 */

import { useContext, type ComponentPropsWithoutRef } from 'react';
import { CsvTable } from './CsvTable.js';
import { AssetJson } from './AssetJson.js';
import { AssetFileCard } from './AssetFileCard.js';
import { downloadUrl } from './SandboxedIframe.js';
import { classifyBinDriveUrl } from '../../remark/bindrive-assets.js';
import { AssetPanelContext } from '../../panel.js';
import { Download, ExternalLink, FileCode, FileText } from 'lucide-react';

interface AssetLinkProps extends ComponentPropsWithoutRef<'a'> {
  viewerSlug: string;
}

export function AssetLink({ viewerSlug, ...props }: AssetLinkProps) {
  const openPanel = useContext(AssetPanelContext);
  const kind = getDataAttr(props, 'data-asset-kind');
  const url = getDataAttr(props, 'data-asset-url') ?? props.href ?? '';
  const filename = getDataAttr(props, 'data-asset-filename') ?? '';

  // Raw-HTML links (rehype-raw) bypass the remark tagger — classify by URL
  // so /reports/*.html and /api/files/* links written as literal <a> tags
  // still get the asset treatment (side panel etc.).
  const match = kind ? null : classifyBinDriveUrl(url, viewerSlug);
  const effectiveKind = kind ?? match?.kind;
  const assetUrl = kind ? url : (match?.normalisedUrl ?? url);
  const assetFilename = filename || match?.filename || '';

  if (!effectiveKind) {
    // External link — never embedded (§8.7 rule 1). Note: no {...props}
    // spread — react-markdown injects a non-DOM `node` prop that would leak.
    return (
      <a
        href={props.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline underline-offset-2 hover:text-blue-800 inline-flex items-center gap-1"
      >
        {props.children}
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }

  if (effectiveKind === 'html' || effectiveKind === 'pdf') {
    // File card → open in the side panel (StoreClaw-style) instead of an
    // inline iframe embed, so long threads stay compact.
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => openPanel({ url: assetUrl, filename: assetFilename, kind: effectiveKind })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPanel({ url: assetUrl, filename: assetFilename, kind: effectiveKind });
          }
        }}
        className="my-3 flex max-w-md cursor-pointer items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f0eeea] text-stone-700">
          {effectiveKind === 'html' ? <FileCode className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-stone-900">
            {assetFilename || props.children}
          </span>
          <span className="block text-[11px] uppercase tracking-wide text-stone-400">
            {effectiveKind === 'pdf' ? 'PDF' : 'HTML report'} — click to view
          </span>
        </span>
        <a
          href={downloadUrl(assetUrl)}
          onClick={(e) => e.stopPropagation()}
          className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
          title="Download"
          aria-label={`Download ${assetFilename}`}
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    );
  }
  if (effectiveKind === 'csv') {
    return <CsvTable url={assetUrl} filename={assetFilename} />;
  }
  if (effectiveKind === 'json') {
    return <AssetJson url={assetUrl} filename={assetFilename} />;
  }

  // text, unknown, image (image-as-link), video, audio → file card
  // (image/video/audio inside a link are unusual; the renderer prefers
  // bare ![]() which goes through AssetImage / inline players).
  return <AssetFileCard url={assetUrl} filename={assetFilename} kind={effectiveKind} />;
}

function getDataAttr(
  props: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = props[name];
  return typeof v === 'string' ? v : undefined;
}
