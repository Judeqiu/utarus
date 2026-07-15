/**
 * Composer — message input box at the bottom of the chat page.
 *
 * States:
 *  - idle: type + ↵ to send
 *  - streaming: input disabled, send button replaced with "■ stop"
 *
 * Slash commands handled client-side:
 *  - /clear → clears agent context (and local state)
 *  - /help  → opens help modal (parent handles via callback)
 *
 * Spec: docs/webui-chat-design.md §7.5, §9.
 */

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import { CornerDownLeft, Square } from 'lucide-react';

interface ComposerProps {
  isStreaming: boolean;
  agentName: string;
  onSend: (text: string, opts: { queue: boolean }) => void;
  onAbort: () => void;
  onClear: () => void;
  onHelp: () => void;
}

export function Composer({
  isStreaming,
  agentName,
  onSend,
  onAbort,
  onClear,
  onHelp,
}: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    if (trimmed === '/clear') {
      onClear();
      setText('');
      return;
    }
    if (trimmed === '/help') {
      onHelp();
      setText('');
      return;
    }
    onSend(trimmed, { queue: false });
    setText('');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-slate-200 bg-white px-4 py-3"
    >
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            rows={1}
            placeholder={
              isStreaming
                ? `${agentName} is replying…`
                : `Message ${agentName}…`
            }
            className="w-full resize-none rounded-2xl border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-500"
          />
        </div>
        {isStreaming ? (
          <button
            type="button"
            onClick={onAbort}
            className="inline-flex items-center gap-1 rounded-2xl bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            <Square className="h-4 w-4" /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!text.trim()}
            className="inline-flex items-center gap-1 rounded-2xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
          >
            <CornerDownLeft className="h-4 w-4" /> Send
          </button>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
        <span>
          <code className="rounded bg-slate-100 px-1 py-0.5">/help</code> for commands ·{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">shift+enter</code> for newline
        </span>
      </div>
    </form>
  );
}
