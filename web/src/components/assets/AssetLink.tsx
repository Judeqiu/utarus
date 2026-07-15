/**
 * AssetLink — handles <a> nodes in rendered markdown. Decides embed-vs-link
 * based on the `data-asset-kind` tag injected by remark-bindrive-assets.
 *
 * Spec: docs/webui-chat-design.md §8.5 (component responsibilities).
 *
 * Kinds:
 *   html → <SandboxedIframe> with a header strip (Open / Download buttons).
 *   pdf  → <SandboxedIframe> (browser-native PDF viewer).
 *   image → fall through to <a> (the markdown <img> renderer handles inline).
 *   csv  → <CsvTable> (fetch + parse).
 *   json → <AssetJson> (table if array-of-objects, else code block).
 *   text/unknown → file card.
 *   no data-asset-kind → external link, target=_blank rel=noopener.
 */

import type { ComponentPropsWithoutRef } from 'react';
import { SandboxedIframe } from './SandboxedIframe.js';
import { CsvTable } from './CsvTable.js';
import { AssetJson } from './AssetJson.js';
import { AssetFileCard } from './AssetFileCard.js';
import { ExternalLink } from 'lucide-react';

interface AssetLinkProps extends ComponentPropsWithoutRef<'a'> {
  viewerSlug: string;
}

export function AssetLink({ viewerSlug, ...props }: AssetLinkProps) {
  const kind = getDataAttr(props, 'data-asset-kind');
  const url = getDataAttr(props, 'data-asset-url') ?? props.href ?? '';
  const filename = getDataAttr(props, 'data-asset-filename') ?? '';

  if (!kind) {
    // External link — never embedded (§8.7 rule 1).
    return (
      <a
        {...props}
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

  if (kind === 'html' || kind === 'pdf') {
    return <SandboxedIframe src={url} filename={filename} kind={kind} viewerSlug={viewerSlug} />;
  }
  if (kind === 'csv') {
    return <CsvTable url={url} filename={filename} />;
  }
  if (kind === 'json') {
    return <AssetJson url={url} filename={filename} />;
  }

  // text, unknown, image (image-as-link), video, audio → file card
  // (image/video/audio inside a link are unusual; the renderer prefers
  // bare ![]() which goes through AssetImage / inline players).
  return <AssetFileCard url={url} filename={filename} kind={kind} />;
}

function getDataAttr(
  props: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = props[name];
  return typeof v === 'string' ? v : undefined;
}
