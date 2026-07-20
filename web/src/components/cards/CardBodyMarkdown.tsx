/**
 * Safe renderer for validated card body markdown (allowlisted nodes only).
 * Full text via wrap + vertical scrollbar inside the portrait face.
 */

import { useMemo, type ReactNode } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type {
  Root,
  PhrasingContent,
  Paragraph,
  Emphasis,
  Strong,
  InlineCode,
  Link,
  Text,
} from 'mdast';

interface CardBodyMarkdownProps {
  body: string;
  /** Fill remaining flex height of the portrait card (deck / tall face). */
  fill?: boolean;
}

function renderPhrasing(nodes: PhrasingContent[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'text':
        return (node as Text).value;
      case 'emphasis':
        return (
          <em key={key}>{renderPhrasing((node as Emphasis).children, key)}</em>
        );
      case 'strong':
        return (
          <strong key={key}>{renderPhrasing((node as Strong).children, key)}</strong>
        );
      case 'inlineCode':
        return (
          <code
            key={key}
            className="rounded bg-stone-100 px-1 py-0.5 text-[0.85em] dark:bg-stone-800"
          >
            {(node as InlineCode).value}
          </code>
        );
      case 'link': {
        const link = node as Link;
        return (
          <a
            key={key}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {renderPhrasing(link.children, key)}
          </a>
        );
      }
      default:
        return null;
    }
  });
}

function renderRoot(tree: Root): ReactNode {
  return tree.children.map((child, i) => {
    if (child.type !== 'paragraph') return null;
    const p = child as Paragraph;
    return (
      <p key={i} className="text-xs leading-relaxed text-stone-600 dark:text-stone-300">
        {renderPhrasing(p.children, `p${i}`)}
      </p>
    );
  });
}

/** Wheel only — do not stop pointer/click so deck selection still works. */
function stopWheelBubble(e: React.WheelEvent) {
  e.stopPropagation();
}

export function CardBodyMarkdown({ body, fill = false }: CardBodyMarkdownProps) {
  const content = useMemo(() => {
    const tree = fromMarkdown(body);
    return renderRoot(tree);
  }, [body]);

  return (
    <div
      className={
        fill
          ? 'info-card-body flex min-h-0 min-w-0 w-full flex-1 flex-col'
          : 'info-card-body mt-0 min-w-0 w-full max-w-full'
      }
      onWheel={stopWheelBubble}
    >
      <div
        className={
          fill
            ? 'info-card-body-scroll info-card-body-scroll--fill'
            : 'info-card-body-scroll'
        }
        data-info-card-body-scroll
      >
        {content}
      </div>
    </div>
  );
}
