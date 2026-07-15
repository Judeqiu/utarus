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

import { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Root } from 'hast';

import { remarkBinDriveAssets } from '../remark/bindrive-assets.js';
import { AssetLink } from './assets/AssetLink.js';
import { AssetImage } from './assets/AssetImage.js';
import { SandboxedIframe } from './assets/SandboxedIframe.js';
import { CodeBlock } from './assets/CodeBlock.js';

interface MarkdownRendererProps {
  text: string;
  viewerSlug: string;
}

/**
 * Sanitization schema: GFM-safe + data-asset-* attributes + an iframe
 * allowlist restricted to same-origin /api/files URLs with sandbox.
 * Spec: §8.7 rule 4.
 *
 * We build it on top of `defaultSchema` from rehype-sanitize. The type is
 * not exported in this version, so we use a structural cast.
 */
function buildSchema(): typeof defaultSchema {
  const base = defaultSchema;
  return {
    ...base,
    attributes: {
      ...base.attributes,
      a: [
        ...(base.attributes?.a ?? []),
        'data-asset-kind',
        'data-asset-url',
        'data-asset-filename',
      ],
      img: [
        ...(base.attributes?.img ?? []),
        'data-asset-kind',
        'data-asset-url',
        'data-asset-filename',
        'loading',
      ],
      iframe: [
        'src',
        'sandbox',
        'width',
        'height',
        'title',
        'data-asset-kind',
        'data-asset-url',
        'data-asset-filename',
      ],
      code: [...(base.attributes?.code ?? []), 'className'],
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

function pickDataProp(
  props: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = props[name];
  return typeof v === 'string' ? v : undefined;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  viewerSlug,
}: MarkdownRendererProps) {
  const schema = useMemo(() => buildSchema(), []);
  const remarkPlugins = useMemo(
    () =>
      [
        remarkGfm,
        // Currency $ amounts must not open inline math (see file header).
        [remarkMath, { singleDollarTextMath: false }],
        [remarkBinDriveAssets, { viewerSlug }],
      ] as never,
    [viewerSlug],
  );
  const rehypePlugins = useMemo(
    () =>
      [
        rehypeRaw,
        [rehypeSanitize, schema],
        rehypeKatex,
        rehypeHighlight,
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
          code: (props) => <CodeBlock {...props} />,
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

// Re-export to keep the import graph tidy for callers that want the type.
export type { Root };
