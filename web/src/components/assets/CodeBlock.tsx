/**
 * CodeBlock — renders <code> with optional copy button. Inline vs block is
 * distinguished by whether the node has a parent <pre> (className
 * language-* present).
 */

import { useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps extends ComponentPropsWithoutRef<'code'> {}

export function CodeBlock(props: CodeBlockProps) {
  const className = typeof props.className === 'string' ? props.className : '';
  const isBlock = className.startsWith('language-') || !!props.children?.toString().includes('\n');
  const [copied, setCopied] = useState(false);

  if (!isBlock) {
    return <code {...props} />;
  }

  const text = getText(props.children);
  return (
    <div className="relative my-3">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-stone-700 px-2 py-1 text-xs text-stone-200 hover:bg-stone-600"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="my-3 overflow-x-auto rounded-lg bg-stone-900 p-3 text-stone-100">
        <code {...props} />
      </pre>
    </div>
  );
}

function getText(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(getText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return getText((children as { props: { children?: unknown } }).props.children);
  }
  return '';
}
