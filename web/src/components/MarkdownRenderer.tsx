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
 *   code    → <CodeBlock>
 *   table   → wrapped (horizontal-scroll container)
 *   iframe  → <SandboxedIframe> (only same-origin /api/files URLs)
 *
 * The custom remark plugin tags asset nodes with data-asset-kind; the
 * components map uses those tags to decide embed-vs-link.
 */

import { Children, isValidElement, memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Root } from 'hast';

import { remarkBinDriveAssets } from '../remark/bindrive-assets.js';
import { remarkMapFence } from '../remark/map-fence.js';
import { remarkWidgetFence } from '../remark/widget-fence.js';
import { parseWidgetFenceBody } from '../widgets/widget-spec.js';
import { AssetLink } from './assets/AssetLink.js';
import { AssetImage } from './assets/AssetImage.js';
import { SandboxedIframe } from './assets/SandboxedIframe.js';
import { CodeBlock } from './assets/CodeBlock.js';
import { MapEmbed } from './assets/MapEmbed.js';
import { MapError } from './assets/MapError.js';
import { WidgetCard, WidgetError } from './widgets/WidgetCard.js';
import type { WidgetSpec } from '../widgets/widget-spec.js';

interface MarkdownRendererProps {
  text: string;
  viewerSlug: string;
  onOpenWidget?: (spec: WidgetSpec) => void;
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
        // Do not highlight ```map / ```widget fences.
        [rehypeHighlight, { plainText: ['map', 'widget'] }],
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
            if (widgetFlag === 'error') {
              return (
                <WidgetError
                  message={
                    pickDataProp(rec, 'data-widget-error') ?? 'Invalid widget block'
                  }
                />
              );
            }
            if (widgetFlag === '1') {
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
            if (mapFlag === 'error') {
              return (
                <MapError
                  message={pickDataProp(rec, 'data-map-error') ?? 'Invalid map block'}
                />
              );
            }
            if (mapFlag === '1') {
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
          // Fenced blocks are pre>code; Map/Widget replace code — unwrap pre
          // so they are not styled as dark code shells (.prose-chat pre).
          pre: ({ children }) => {
            const list = Children.toArray(children);
            if (list.length === 1 && isValidElement(list[0])) {
              const el = list[0];
              const t = el.type;
              const displayName =
                typeof t === 'function' || (typeof t === 'object' && t !== null)
                  ? (t as { displayName?: string; name?: string }).displayName ||
                    (t as { name?: string }).name
                  : undefined;
              const props = el.props as {
                'data-map-embed'?: boolean | string;
                'data-widget-card'?: boolean | string;
              };
              const isMap =
                t === MapEmbed ||
                t === MapError ||
                displayName === 'MapEmbed' ||
                displayName === 'MapError' ||
                props['data-map-embed'] === true ||
                props['data-map-embed'] === '';
              const isWidget =
                t === WidgetCard ||
                t === WidgetError ||
                displayName === 'WidgetCard' ||
                displayName === 'WidgetError' ||
                props['data-widget-card'] === true ||
                props['data-widget-card'] === '';
              if (isMap || isWidget) {
                return <>{children}</>;
              }
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
