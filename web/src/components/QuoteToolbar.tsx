/**
 * Floating Quote control near the current text selection.
 * Activates a frozen selection snapshot via pointerdown + preventDefault
 * so the browser does not collapse selection before the handler runs.
 */

import { Quote } from 'lucide-react';

interface QuoteToolbarProps {
  /** Viewport-fixed position (from selection rangeRect). */
  top: number;
  left: number;
  onQuote: () => void;
}

export function QuoteToolbar({ top, left, onQuote }: QuoteToolbarProps) {
  return (
    <div
      className="fixed z-50 -translate-x-1/2 -translate-y-full"
      style={{ top: `${top}px`, left: `${left}px` }}
      role="toolbar"
      aria-label="Quote selection"
    >
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onQuote();
        }}
        className="mb-1 flex items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-lg hover:bg-stone-700"
      >
        <Quote className="h-3.5 w-3.5" />
        Quote
      </button>
    </div>
  );
}
