/**
 * ThreadView — scrollable message list. Auto-scrolls to bottom on new
 * messages unless the user has scrolled up.
 */

import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types.js';
import { MessageView } from './Message.js';

interface ThreadViewProps {
  messages: ChatMessage[];
  viewerSlug: string;
  now: number;
  agentName: string;
}

export function ThreadView({ messages, viewerSlug, now, agentName }: ThreadViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  useEffect(() => {
    if (stick.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, now]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10 text-center sm:px-6 sm:py-12">
        <div className="mb-2 font-serif text-2xl font-semibold text-stone-900 sm:text-3xl">
          How can I help you today?
        </div>
        <p className="max-w-md text-sm text-stone-500">
          Send a message to start. Tables, code, and BinDrive reports render
          inline here.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto bg-white px-3 py-3 sm:px-4 sm:py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            viewerSlug={viewerSlug}
            now={now}
            agentName={agentName}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
