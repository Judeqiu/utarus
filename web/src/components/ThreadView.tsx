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
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center text-slate-500">
        <div className="mb-3 text-4xl">👋</div>
        <div className="mb-1 text-lg font-medium text-slate-700">
          Welcome to {agentName}
        </div>
        <p className="max-w-md text-sm">
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
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
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
