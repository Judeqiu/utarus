/**
 * QuoteChip — compact preview of a quoted message span (composer + user bubble).
 */

import { X } from 'lucide-react';
import type { ChatQuoteRef } from '../types.js';

const CHIP_PREVIEW = 100;
const TOOLTIP_PREVIEW = 280;

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

interface QuoteChipProps {
  quote: ChatQuoteRef;
  /** When set, show a dismiss control (composer pending quote). */
  onRemove?: () => void;
  className?: string;
}

export function QuoteChip({ quote, onRemove, className = '' }: QuoteChipProps) {
  const preview = truncate(quote.text, CHIP_PREVIEW);
  const title = truncate(quote.text, TOOLTIP_PREVIEW);
  const roleLabel =
    quote.role === 'widget' || quote.source === 'widget'
      ? quote.widgetTitle?.trim()
        ? `Document · ${quote.widgetTitle.trim()}`
        : quote.widgetKind
          ? `Widget · ${quote.widgetKind}`
          : 'Document'
      : quote.role === 'assistant'
        ? 'Assistant'
        : 'You';

  return (
    <div
      className={
        'flex min-w-0 max-w-full items-start gap-2 rounded-xl border border-stone-200 ' +
        'border-l-4 border-l-stone-400 bg-stone-50 px-2.5 py-1.5 text-xs text-stone-700 ' +
        className
      }
      title={title}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 font-medium text-stone-500">{roleLabel}</div>
        <div className="whitespace-pre-wrap break-words text-stone-800">{preview}</div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove quote"
          aria-label="Remove quote"
          className="shrink-0 rounded-full p-0.5 text-stone-400 hover:bg-stone-200 hover:text-stone-700"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
