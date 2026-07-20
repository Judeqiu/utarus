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

interface ThreadViewProps {
  messages: ChatMessage[];
  viewerSlug: string;
  now: number;
  agentName: string;
  /** Message ids known to exist on the server (load + run ack). */
  serverKnownMessageIds: ReadonlySet<string>;
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
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6 sm:py-12">
        <div className="mb-2 font-serif text-2xl font-semibold text-stone-900 sm:text-3xl">
          How can I help you today?
        </div>
        <p className="max-w-md text-sm text-stone-500">
          Send a message to start. Tables, code, and BinDrive reports render
          inline here. Select text to quote it into your next message.
        </p>
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
