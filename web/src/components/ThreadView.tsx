/**
 * ThreadView — scrollable message list. Auto-scrolls to bottom on new
 * messages unless the user has scrolled up.
 *
 * Desktop (fine pointer): selection inside [data-quote-source] shows a
 * floating Quote toolbar; activates a frozen selection snapshot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatQuoteRef } from '../types.js';
import { QUOTE_TEXT_MAX } from '../types.js';
import { MessageView } from './Message.js';
import { QuoteToolbar } from './QuoteToolbar.js';
import {
  resolveQuoteFromSelection,
  type QuoteSelectionResult,
} from '../lib/quote-selection.js';
import type { WidgetSpec } from '../widgets/widget-spec.js';

export interface ChatEmptyStateView {
  title: string;
  body: string[];
  bullets?: string[];
  starters?: Array<{ label: string; message: string }>;
  footer?: string;
}

const DEFAULT_EMPTY: ChatEmptyStateView = {
  title: 'How can I help you today?',
  body: [
    'Send a message to start. Tables, code, and BinDrive reports render inline here.',
  ],
  footer: 'Select text to quote it into your next message.',
};

interface ThreadViewProps {
  messages: ChatMessage[];
  viewerSlug: string;
  now: number;
  agentName: string;
  /** Message ids known to exist on the server (load + run ack). */
  serverKnownMessageIds: ReadonlySet<string>;
  /** Domain/product empty-state from WebUI manifest (Web only). */
  emptyState?: ChatEmptyStateView | null;
  /** Starter chip → send as first user message. */
  onStarter?: (message: string) => void;
  onQuote?: (quote: ChatQuoteRef) => void;
  onQuoteError?: (message: string) => void;
  onOpenWidget?: (spec: WidgetSpec) => void;
}

export function ThreadView({
  messages,
  viewerSlug,
  now,
  agentName,
  serverKnownMessageIds,
  emptyState,
  onStarter,
  onQuote,
  onQuoteError,
  onOpenWidget,
}: ThreadViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastValid = useRef<QuoteSelectionResult | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(
    null,
  );

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Dismiss quote toolbar on scroll (v1: no re-position).
    lastValid.current = null;
    setToolbar(null);
  }

  useEffect(() => {
    if (stick.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, now]);

  const refreshSelection = useCallback(() => {
    const resolved = resolveQuoteFromSelection(window.getSelection(), {
      serverKnownMessageIds,
    });
    // Exclude streaming/pending messages by id membership only for server ids;
    // also skip if the live message object is still streaming/pending.
    if (!resolved) {
      lastValid.current = null;
      setToolbar(null);
      return;
    }
    const host = messages.find((m) => m.id === resolved.messageId);
    if (!host || host.streaming || host.pending) {
      lastValid.current = null;
      setToolbar(null);
      return;
    }
    lastValid.current = resolved;
    // Prefer above selection when space allows.
    const gap = 8;
    const top = Math.max(8, resolved.rangeRect.top - gap);
    const left = resolved.rangeRect.left + resolved.rangeRect.width / 2;
    setToolbar({ top, left });
  }, [messages, serverKnownMessageIds]);

  useEffect(() => {
    // Coarse pointer (touch): do not mount selection listeners / toolbar.
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.matches) return;

    const onSel = () => refreshSelection();
    const onResize = () => {
      lastValid.current = null;
      setToolbar(null);
    };
    document.addEventListener('selectionchange', onSel);
    document.addEventListener('mouseup', onSel);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      document.removeEventListener('mouseup', onSel);
      window.removeEventListener('resize', onResize);
    };
  }, [refreshSelection]);

  function handleQuoteClick() {
    const snap = lastValid.current;
    if (!snap || !onQuote) return;
    if (snap.text.length > QUOTE_TEXT_MAX) {
      onQuoteError?.(
        `Selection is too long (max ${QUOTE_TEXT_MAX} characters). Select a shorter span.`,
      );
      lastValid.current = null;
      setToolbar(null);
      return;
    }
    onQuote({
      messageId: snap.messageId,
      role: snap.role,
      text: snap.text,
    });
    window.getSelection()?.removeAllRanges();
    lastValid.current = null;
    setToolbar(null);
  }

  if (messages.length === 0) {
    const empty = emptyState ?? DEFAULT_EMPTY;
    const footer =
      empty.footer ??
      'Select text to quote it into your next message. Tables, code, and BinDrive reports render inline.';
    return (
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8 text-center sm:px-6 sm:py-10">
        <div className="mb-3 max-w-xl font-serif text-2xl font-semibold text-stone-900 sm:text-3xl">
          {empty.title}
        </div>
        <div className="max-w-xl space-y-2 text-sm leading-relaxed text-stone-600">
          {empty.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
        {empty.bullets && empty.bullets.length > 0 && (
          <ul className="mt-4 max-w-xl list-none space-y-1.5 text-left text-sm text-stone-700">
            {empty.bullets.map((b, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-stone-400" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
        {empty.starters && empty.starters.length > 0 && onStarter && (
          <div className="mt-5 flex max-w-xl flex-wrap items-center justify-center gap-2">
            {empty.starters.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => onStarter(s.message)}
                className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-left text-xs font-medium text-stone-800 shadow-sm transition hover:border-stone-400 hover:bg-stone-50"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <p className="mt-5 max-w-md text-xs text-stone-400">{footer}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="relative flex-1 overflow-y-auto bg-white px-3 py-3 sm:px-4 sm:py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            viewerSlug={viewerSlug}
            now={now}
            agentName={agentName}
            onOpenWidget={onOpenWidget}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {toolbar && onQuote && (
        <QuoteToolbar
          top={toolbar.top}
          left={toolbar.left}
          onQuote={handleQuoteClick}
        />
      )}
    </div>
  );
}
