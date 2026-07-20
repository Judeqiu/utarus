/**
 * react-markdown pipeline configured per docs/webui-chat-design.md §8.5.
 *
 * Pipeline: remark-gfm + remark-math + remark-bindrive-assets (custom)
 * followed by rehype-katex + rehype-highlight + rehype-sanitize + rehype-raw.
 *
 * Math uses $$...$$ only (singleDollarTextMath: false). Domain agents often
 * emit currency amounts ($1.675T, $14.7B); default single-$ math would treat
 * spans between dollar signs as KaTeX, collapse word spaces, and leave ** as
 * literal asterisks — the chat "garbled finance text" bug.
 *
 * Components map:
 *   a       → <AssetLink>
 *   img     → <AssetImage>
 *   code    → <CodeBlock> | MapEmbed | WidgetCard | DiagramEmbed
 *   table   → wrapped (horizontal-scroll container)
 *   iframe  → <SandboxedIframe> (only same-origin /api/files URLs)
 *
 * New chat fence embeds: root element must set CHAT_EMBED_PROPS
 * (data-chat-embed) — see web/src/embeds/chat-embed.ts.
 *
 * The custom remark plugin tags asset nodes with data-asset-kind; the
 * components map uses those tags to decide embed-vs-link.
 */

import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Root } from 'hast';

import { CHAT_EMBED_ATTR, CHAT_EMBED_PROPS } from '../embeds/chat-embed.js';
import { remarkBinDriveAssets } from '../remark/bindrive-assets.js';
import { remarkMapFence } from '../remark/map-fence.js';
import { remarkMermaidFence } from '../remark/mermaid-fence.js';
import { remarkWidgetFence } from '../remark/widget-fence.js';
import { parseWidgetFenceBody } from '../widgets/widget-spec.js';
import { AssetLink } from './assets/AssetLink.js';
import { AssetImage } from './assets/AssetImage.js';
import { SandboxedIframe } from './assets/SandboxedIframe.js';
import { CodeBlock } from './assets/CodeBlock.js';
import { DiagramEmbed } from './assets/DiagramEmbed.js';
import { DiagramError } from './assets/DiagramError.js';
import { MapEmbed } from './assets/MapEmbed.js';
import { MapError } from './assets/MapError.js';
import { WidgetCard, WidgetError } from './widgets/WidgetCard.js';
import type { WidgetSpec } from '../widgets/widget-spec.js';

interface MarkdownRendererProps {
  text: string;
  viewerSlug: string;
  onOpenWidget?: (spec: WidgetSpec) => void;
  /**
   * When true (assistant still streaming/pending), chat embeds (map / widget /
   * mermaid) stay as labeled source fences. Full cards/embeds only after the
   * reply finishes — incomplete fences otherwise spam parse/render errors.
   */
  streaming?: boolean;
}

/** Shared chrome while an embed fence is still streaming in. */
function EmbedFencePending({
  label,
  language,
  codeProps,
}: {
  label: string;
  language: string;
  codeProps: ComponentPropsWithoutRef<'code'>;
}) {
  const className =
    typeof codeProps.className === 'string' &&
    codeProps.className.includes('language-')
      ? codeProps.className
      : `language-${language}`;
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-embed-pending
      className="my-3 overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700"
    >
      <div className="flex items-center gap-2 border-b border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
        <span className="font-medium text-stone-700 dark:text-stone-200">{label}</span>
        <span className="text-stone-400">·</span>
        <span>source (renders when reply finishes)</span>
      </div>
      <div className="[&_.my-3]:my-0 [&_pre]:rounded-none [&_pre]:border-0">
        <CodeBlock {...codeProps} className={className} />
      </div>
    </div>
  );
}

/** True when props mark a chat fence embed root (`data-chat-embed`). */
function hasChatEmbedAttr(props: unknown): boolean {
  if (props == null || typeof props !== 'object') return false;
  const rec = props as Record<string, unknown>;
  const v = rec[CHAT_EMBED_ATTR] ?? rec.dataChatEmbed;
  return v === true || v === '' || v === 'true' || v === 1;
}

/**
 * Whether a react-markdown `pre` child is a chat embed (unwrap pre chrome).
 * Accepts a single element with CHAT_EMBED_ATTR, or a Fragment whose child has it.
 */
function isChatEmbedMarkdownChild(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  if (hasChatEmbedAttr(node.props)) return true;
  if (node.type === Fragment) {
    const kids = Children.toArray(
      (node.props as { children?: ReactNode }).children,
    );
    return kids.some(
      (k) => isValidElement(k) && hasChatEmbedAttr((k as ReactElement).props),
    );
  }
  return false;
}

/**
 * Sanitization schema: GFM-safe + data-asset-* attributes + an iframe
 * allowlist restricted to same-origin /api/files URLs with sandbox.
 * Spec: §8.7 rule 4.
 *
 * We build it on top of `defaultSchema` from rehype-sanitize. The type is
 * not exported in this version, so we use a structural cast.
 */
/**
 * rehype-raw camelCases data-* into dataFoo. Allow both forms so sanitize
 * does not strip map/asset tags after the raw pass.
 */
const DATA_ASSET_ATTRS = [
  'data-asset-kind',
  'data-asset-url',
  'data-asset-filename',
  'dataAssetKind',
  'dataAssetUrl',
  'dataAssetFilename',
] as const;

const DATA_MAP_ATTRS = [
  'data-map',
  'data-map-error',
  'data-map-mode',
  'data-map-query',
  'data-map-lat',
  'data-map-lng',
  'data-map-zoom',
  'data-map-label',
  'dataMap',
  'dataMapError',
  'dataMapMode',
  'dataMapQuery',
  'dataMapLat',
  'dataMapLng',
  'dataMapZoom',
  'dataMapLabel',
] as const;

const DATA_WIDGET_ATTRS = [
  'data-widget',
  'data-widget-error',
  'data-widget-instance-id',
  'data-widget-kind',
  'data-widget-title',
  'data-widget-action',
  'data-widget-persistence',
  'dataWidget',
  'dataWidgetError',
  'dataWidgetInstanceId',
  'dataWidgetKind',
  'dataWidgetTitle',
  'dataWidgetAction',
  'dataWidgetPersistence',
] as const;

const DATA_DIAGRAM_ATTRS = [
  'data-diagram',
  'data-diagram-error',
  'dataDiagram',
  'dataDiagramError',
] as const;

function buildSchema(): typeof defaultSchema {
  const base = defaultSchema;
  return {
    ...base,
    attributes: {
      ...base.attributes,
      a: [...(base.attributes?.a ?? []), ...DATA_ASSET_ATTRS],
      img: [...(base.attributes?.img ?? []), ...DATA_ASSET_ATTRS, 'loading'],
      iframe: [
        'src',
        'sandbox',
        'width',
        'height',
        'title',
        ...DATA_ASSET_ATTRS,
      ],
      code: [
        ...(base.attributes?.code ?? []),
        'className',
        ...DATA_MAP_ATTRS,
        ...DATA_WIDGET_ATTRS,
        ...DATA_DIAGRAM_ATTRS,
      ],
      pre: [...(base.attributes?.pre ?? []), 'className'],
      span: [...(base.attributes?.span ?? []), 'className'],
    },
    tagNames: [...(base.tagNames ?? []), 'iframe'],
    protocols: {
      ...base.protocols,
      src: ['http', 'https', 'relative'],
    },
    strip: ['script', 'object', 'embed', 'form'],
  };
}

/** kebab-case → camelCase for data attributes (rehype-raw renames them). */
function kebabToCamelDataAttr(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function pickDataProp(
  props: Record<string, unknown>,
  name: string,
): string | undefined {
  const direct = props[name];
  if (typeof direct === 'string') return direct;
  const camel = kebabToCamelDataAttr(name);
  if (camel !== name) {
    const alt = props[camel];
    if (typeof alt === 'string') return alt;
  }
  return undefined;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  viewerSlug,
  onOpenWidget,
  streaming = false,
}: MarkdownRendererProps) {
  const schema = useMemo(() => buildSchema(), []);
  const remarkPlugins = useMemo(
    () =>
      [
        remarkGfm,
        // Currency $ amounts must not open inline math (see file header).
        [remarkMath, { singleDollarTextMath: false }],
        [remarkBinDriveAssets, { viewerSlug }],
        remarkMapFence,
        // Tag embed fences while streaming; full render gated in code component.
        remarkMermaidFence,
        remarkWidgetFence,
      ] as never,
    [viewerSlug],
  );
  const rehypePlugins = useMemo(
    () =>
      [
        rehypeRaw,
        [rehypeSanitize, schema],
        rehypeKatex,
        // Do not highlight ```map / ```widget / ```mermaid fences.
        [rehypeHighlight, { plainText: ['map', 'widget', 'mermaid'] }],
      ] as never,
    [schema],
  );

  return (
    <div className="prose-chat max-w-none text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          a: (props) => <AssetLink {...props} viewerSlug={viewerSlug} />,
          img: (props) => <AssetImage {...props} />,
          code: (props) => {
            const rec = props as Record<string, unknown>;
            const widgetFlag = pickDataProp(rec, 'data-widget');
            if (widgetFlag === 'error' || widgetFlag === '1') {
              if (streaming) {
                return (
                  <EmbedFencePending
                    label="Widget"
                    language="widget"
                    codeProps={props}
                  />
                );
              }
              if (widgetFlag === 'error') {
                return (
                  <WidgetError
                    message={
                      pickDataProp(rec, 'data-widget-error') ??
                      'Invalid widget block'
                    }
                  />
                );
              }
              // Re-parse fence body from code children for full props (not in attrs).
              const rawChildren = props.children;
              const body = String(
                Array.isArray(rawChildren)
                  ? rawChildren.join('')
                  : (rawChildren ?? ''),
              );
              const parsed = parseWidgetFenceBody(body);
              if (!parsed.ok) {
                return <WidgetError message={parsed.error} />;
              }
              if (!onOpenWidget) {
                return <WidgetError message="Widget panel is not available" />;
              }
              return <WidgetCard spec={parsed.spec} onOpen={onOpenWidget} />;
            }
            const mapFlag = pickDataProp(rec, 'data-map');
            if (mapFlag === 'error' || mapFlag === '1') {
              if (streaming) {
                return (
                  <EmbedFencePending label="Map" language="map" codeProps={props} />
                );
              }
              if (mapFlag === 'error') {
                return (
                  <MapError
                    message={
                      pickDataProp(rec, 'data-map-error') ?? 'Invalid map block'
                    }
                  />
                );
              }
              const mode = pickDataProp(rec, 'data-map-mode');
              if (mode !== 'place' && mode !== 'view') {
                return <MapError message="map mode missing or invalid after sanitize" />;
              }
              const latStr = pickDataProp(rec, 'data-map-lat');
              const lngStr = pickDataProp(rec, 'data-map-lng');
              const zoomStr = pickDataProp(rec, 'data-map-zoom');
              let lat: number | undefined;
              let lng: number | undefined;
              let zoom: number | undefined;
              if (latStr !== undefined) {
                lat = Number(latStr);
                if (!Number.isFinite(lat)) {
                  return <MapError message="map lat is not a number after sanitize" />;
                }
              }
              if (lngStr !== undefined) {
                lng = Number(lngStr);
                if (!Number.isFinite(lng)) {
                  return <MapError message="map lng is not a number after sanitize" />;
                }
              }
              if (zoomStr !== undefined) {
                zoom = Number(zoomStr);
                if (!Number.isInteger(zoom)) {
                  return <MapError message="map zoom is not an integer after sanitize" />;
                }
              }
              return (
                <MapEmbed
                  mode={mode}
                  query={pickDataProp(rec, 'data-map-query')}
                  lat={lat}
                  lng={lng}
                  zoom={zoom}
                  label={pickDataProp(rec, 'data-map-label')}
                />
              );
            }
            const diagramFlag = pickDataProp(rec, 'data-diagram');
            if (diagramFlag === 'error' || diagramFlag === '1') {
              if (streaming) {
                return (
                  <EmbedFencePending
                    label="Diagram"
                    language="mermaid"
                    codeProps={props}
                  />
                );
              }
              if (diagramFlag === 'error') {
                return (
                  <DiagramError
                    message={
                      pickDataProp(rec, 'data-diagram-error') ??
                      'Invalid diagram block'
                    }
                  />
                );
              }
              const rawChildren = props.children;
              const body = String(
                Array.isArray(rawChildren)
                  ? rawChildren.join('')
                  : (rawChildren ?? ''),
              );
              return <DiagramEmbed source={body} />;
            }
            return <CodeBlock {...props} />;
          },
          iframe: (props) => {
            const src = typeof props.src === 'string' ? props.src : '';
            const filename =
              pickDataProp(props as Record<string, unknown>, 'data-asset-filename') ??
              (typeof props.title === 'string' ? props.title : 'embed');
            const kind =
              pickDataProp(props as Record<string, unknown>, 'data-asset-kind') ?? 'html';
            if (!src) return null;
            return (
              <SandboxedIframe
                src={src}
                filename={filename}
                kind={kind}
                viewerSlug={viewerSlug}
              />
            );
          },
          table: (props) => (
            <div className="my-3 overflow-x-auto">
              <table {...props} />
            </div>
          ),
          // Fenced blocks are pre>code. Embed components replace code — unwrap
          // pre when the child opts into CHAT_EMBED_ATTR (see embeds/chat-embed.ts).
          pre: ({ children }) => {
            const list = Children.toArray(children);
            if (list.length === 1 && isChatEmbedMarkdownChild(list[0])) {
              return <>{children}</>;
            }
            return <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Re-export to keep the import graph tidy for callers that want the type.
export type { Root };
