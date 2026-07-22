/**
 * ThreadView — scrollable message list with ChatGPT/Claude-style stick-to-bottom:
 *  - While the user is near the bottom, follow new content (streaming + growth).
 *  - If they scroll up, stop auto-scrolling and keep their place.
 *  - Show a jump-to-latest control at the bottom; click reattaches and scrolls down.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
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

/** Distance from bottom (px) counted as "following" the latest content. */
const NEAR_BOTTOM_PX = 80;

interface ThreadViewProps {
  messages: ChatMessage[];
  viewerSlug: string;
  now: number;
  agentName: string;
  /** Active conversation — used to re-stick when switching chats. */
  conversationId?: string | null;
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

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isNearBottom(el: HTMLElement): boolean {
  return distanceFromBottom(el) < NEAR_BOTTOM_PX;
}

export function ThreadView({
  messages,
  viewerSlug,
  now,
  agentName,
  conversationId,
  serverKnownMessageIds,
  emptyState,
  onStarter,
  onQuote,
  onQuoteError,
  onOpenWidget,
}: ThreadViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** When true, new content auto-scrolls the viewport to the latest line. */
  const stick = useRef(true);
  /** Suppress stick updates while we programmatically scroll (avoids false detach). */
  const programmaticScroll = useRef(false);
  const lastValid = useRef<QuoteSelectionResult | null>(null);
  const prevMessageCount = useRef(0);
  const prevLastUserId = useRef<string | null>(null);
  const prevConversationId = useRef<string | null | undefined>(conversationId);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [toolbar, setToolbar] = useState<{ top: number; left: number } | null>(
    null,
  );

  const updateStickFromScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (programmaticScroll.current) return;
    const near = isNearBottom(el);
    stick.current = near;
    setShowJumpToLatest(!near);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    if (behavior === 'smooth') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      // Re-enable stick tracking after the smooth animation settles.
      window.setTimeout(() => {
        programmaticScroll.current = false;
        if (el && isNearBottom(el)) {
          stick.current = true;
          setShowJumpToLatest(false);
        }
      }, 400);
    } else {
      el.scrollTop = el.scrollHeight;
      // Instant scroll fires 'scroll' synchronously in most browsers; clear on next frame.
      requestAnimationFrame(() => {
        programmaticScroll.current = false;
        stick.current = true;
        setShowJumpToLatest(false);
      });
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    stick.current = true;
    setShowJumpToLatest(false);
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  function onScroll() {
    updateStickFromScroll();
    // Dismiss quote toolbar on scroll (v1: no re-position).
    lastValid.current = null;
    setToolbar(null);
  }

  // Follow latest content while stuck; force-follow when the user sends a new message.
  useLayoutEffect(() => {
    const conversationChanged =
      conversationId !== undefined &&
      conversationId !== prevConversationId.current;
    if (conversationChanged) {
      prevConversationId.current = conversationId;
      prevMessageCount.current = messages.length;
      const lastUser =
        [...messages].reverse().find((m) => m.role === 'user') ?? null;
      prevLastUserId.current = lastUser?.id ?? null;
      stick.current = true;
      setShowJumpToLatest(false);
      scrollToBottom('auto');
      return;
    }

    const last = messages[messages.length - 1];
    const lastUser =
      [...messages].reverse().find((m) => m.role === 'user') ?? null;
    const lastUserId = lastUser?.id ?? null;
    const userJustSent =
      lastUserId !== null && lastUserId !== prevLastUserId.current;
    prevLastUserId.current = lastUserId;

    const countGrew = messages.length > prevMessageCount.current;
    prevMessageCount.current = messages.length;

    // New outbound user message always reattaches (ChatGPT/Claude behavior).
    if (userJustSent && last?.role === 'user') {
      stick.current = true;
      setShowJumpToLatest(false);
      scrollToBottom('auto');
      return;
    }

    if (stick.current) {
      // Instant during stream/growth so follow stays tight and scroll events
      // don't falsely detach mid-animation.
      scrollToBottom('auto');
      return;
    }

    // Not stuck: if content grew while reading history, keep jump control visible.
    if (countGrew || last?.streaming) {
      setShowJumpToLatest(true);
    }
  }, [messages, conversationId, scrollToBottom]);

  // Content can grow without a messages-array identity change (images, widgets,
  // markdown layout). ResizeObserver keeps follow mode accurate.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stick.current) {
        scrollToBottom('auto');
      } else {
        const el = containerRef.current;
        if (el && !isNearBottom(el)) {
          setShowJumpToLatest(true);
        }
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
    // Re-bind when the scroll tree mounts (empty → messages).
  }, [scrollToBottom, messages.length > 0]);

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

  const streaming = messages.some((m) => m.streaming || m.pending);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto bg-white px-3 py-3 sm:px-4 sm:py-4"
      >
        <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-6">
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
          <div ref={bottomRef} aria-hidden className="h-px w-full shrink-0" />
        </div>
        {toolbar && onQuote && (
          <QuoteToolbar
            top={toolbar.top}
            left={toolbar.left}
            onQuote={handleQuoteClick}
          />
        )}
      </div>

      {showJumpToLatest && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 sm:bottom-4">
          <button
            type="button"
            onClick={jumpToLatest}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/95 px-3.5 py-2 text-sm font-medium text-stone-700 shadow-md backdrop-blur-sm transition hover:border-stone-300 hover:bg-white hover:text-stone-900 hover:shadow-lg active:scale-[0.98]"
            aria-label="Scroll to latest messages"
          >
            <ArrowDown className="h-4 w-4 shrink-0" aria-hidden />
            <span>{streaming ? 'Jump to latest' : 'Scroll to bottom'}</span>
          </button>
        </div>
      )}
    </div>
  );
}
