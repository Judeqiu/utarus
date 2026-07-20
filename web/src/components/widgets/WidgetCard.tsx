/**
 * Inline chat card for a widget fence — opens side panel on click.
 */

import { Box, Layers } from 'lucide-react';
import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';
import { useWidgetRegistry } from '../../widgets/registry-context.js';
import type { WidgetSpec } from '../../widgets/widget-spec.js';

interface WidgetCardProps {
  spec: WidgetSpec;
  onOpen: (spec: WidgetSpec) => void;
}

export function WidgetCard({ spec, onOpen }: WidgetCardProps) {
  const reg = useWidgetRegistry();
  const kindLabel = reg.byId.get(spec.kind)?.label ?? spec.kind;
  const isUpdate = spec.action === 'update';

  return (
    <button
      type="button"
      {...CHAT_EMBED_PROPS}
      data-widget-card
      onClick={() => onOpen(spec)}
      className="my-3 flex w-full max-w-md items-start gap-3 rounded-xl border border-stone-200 bg-white p-3 text-left shadow-sm transition hover:border-stone-300 hover:bg-stone-50"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white">
        {spec.kind.includes('3d') || spec.kind.includes('floor') ? (
          <Box className="h-5 w-5" />
        ) : (
          <Layers className="h-5 w-5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-stone-900">
          {spec.title}
        </span>
        <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-stone-400">
          {kindLabel}
          {isUpdate ? ' · Updated' : ' · Widget'}
          {spec.persistence === 'bindrive' ? ' · Saved' : ''}
        </span>
        {spec.summary && (
          <span className="mt-1 block truncate text-xs text-stone-500">{spec.summary}</span>
        )}
      </span>
    </button>
  );
}

export function WidgetError({ message }: { message: string }) {
  return (
    <div
      {...CHAT_EMBED_PROPS}
      data-widget-card
      className="my-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
    >
      Widget error: {message}
    </div>
  );
}
