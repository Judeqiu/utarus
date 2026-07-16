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

  // Focus on mount, after send, and when a reply finishes.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isStreaming) {
      textareaRef.current?.focus();
    }
  }, [isStreaming]);

  // iOS Safari: when the soft keyboard opens it shrinks visualViewport but
  // keeps layout viewport unchanged, so the textarea can be hidden behind
  // the keyboard. Scroll it into view on resize.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  function focusInput() {
    // After setState, focus on next frame so the element is still editable.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    if (trimmed === '/clear') {
      onClear();
      setText('');
      focusInput();
      return;
    }
    if (trimmed === '/help') {
      onHelp();
      setText('');
      focusInput();
      return;
    }
    onSend(trimmed, { queue: false });
    setText('');
    focusInput();
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
      className="pb-safe border-t border-slate-200 bg-white px-3 py-2 sm:px-4 sm:py-3"
    >
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            // Stay focusable while streaming so caret does not leave after send.
            rows={1}
            placeholder={
              isStreaming
                ? `${agentName} is replying…`
                : `Message ${agentName}…`
            }
            className={
              'w-full resize-none rounded-2xl border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
              (isStreaming ? 'bg-slate-50 text-slate-700' : '')
            }
          />
        </div>
        {isStreaming ? (
          <button
            type="button"
            onClick={onAbort}
            title="Stop"
            aria-label="Stop"
            className="inline-flex items-center gap-1 rounded-2xl bg-rose-600 px-3 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            <Square className="h-4 w-4" /> <span className="hidden sm:inline">Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={!text.trim()}
            title="Send"
            aria-label="Send"
            className="inline-flex items-center gap-1 rounded-2xl bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-slate-300"
          >
            <CornerDownLeft className="h-4 w-4" /> <span className="hidden sm:inline">Send</span>
          </button>
        )}
      </div>
      <div className="mt-1 hidden items-center justify-between text-[11px] text-slate-400 sm:flex">
        <span>
          <code className="rounded bg-slate-100 px-1 py-0.5">/help</code> for commands ·{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">shift+enter</code> for newline
        </span>
      </div>
    </form>
  );
}
