/**
 * DiagramError — fail-fast chrome for invalid or failed Mermaid fences.
 */

import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';

interface DiagramErrorProps {
  message: string;
}

/** Hint when the classic unquoted-parens failure surfaces (got 'PS'). */
function parseHint(message: string): string | null {
  if (/\bgot\s+'PS'/i.test(message) || /Expecting[\s\S]*PIPE[\s\S]*got/i.test(message)) {
    return 'Tip: quote node labels that contain parentheses — use B{"g(x) ≥ 0?"} not B{g(x) ≥ 0?}, and A["f(x)"] not A[f(x)].';
  }
  return null;
}

export function DiagramError({ message }: DiagramErrorProps) {
  const hint = parseHint(message);
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-diagram-embed
      className="my-3 w-full rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
      role="alert"
    >
      <div className="font-medium">Invalid diagram</div>
      <div className="mt-0.5 whitespace-pre-wrap opacity-90">{message}</div>
      {hint ? (
        <div className="mt-1.5 text-xs opacity-80">{hint}</div>
      ) : null}
    </div>
  );
}

DiagramError.displayName = 'DiagramError';
