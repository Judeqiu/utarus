/**
 * DiagramError — fail-fast chrome for invalid or failed Mermaid fences.
 */

import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';

interface DiagramErrorProps {
  message: string;
}

export function DiagramError({ message }: DiagramErrorProps) {
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-diagram-embed
      className="my-3 w-full rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
      role="alert"
    >
      <div className="font-medium">Invalid diagram</div>
      <div className="mt-0.5 whitespace-pre-wrap opacity-90">{message}</div>
    </div>
  );
}

DiagramError.displayName = 'DiagramError';
