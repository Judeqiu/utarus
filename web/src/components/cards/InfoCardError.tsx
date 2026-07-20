/**
 * Fail-fast chrome for invalid card fences.
 */

import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';

export function InfoCardError({ message }: { message: string }) {
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-info-card-error
      className="my-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
    >
      Invalid card block: {message}
    </div>
  );
}
