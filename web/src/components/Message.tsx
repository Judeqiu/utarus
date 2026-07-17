/**
 * Message — one entry in the conversation thread.
 *
 * User bubble: warm-gray rounded bubble, right-aligned, plain text (escaped).
 * Assistant: plain full-width markdown (no card) — tool chips above, work
 * status row below while streaming, copy action when finished, then
 * attachments.
 *
 * Spec: docs/webui-chat-design.md §9.
 */

import { useEffect, useState } from 'react';
import type { ChatMessage } from '../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolChipView } from './ToolChip.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { Check, Copy, Loader2 } from 'lucide-react';

interface MessageViewProps {
  message: ChatMessage;
  viewerSlug: string;
  now: number;
  agentName: string;
}

export function MessageView({ message, viewerSlug, now }: MessageViewProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[#f0eeea] px-4 py-2.5 text-sm text-stone-900 sm:max-w-[80%]">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-start">
      <div className="w-full">
        {message.tools && message.tools.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {message.tools.map((t) => (
              <ToolChipView key={t.toolCallId} tool={t} now={now} />
            ))}
          </div>
        )}

        {message.error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {message.error}
          </div>
        ) : message.text ? (
          <MarkdownRenderer text={message.text} viewerSlug={viewerSlug} />
        ) : null}

        {message.assets && message.assets.length > 0 && (
          <AttachmentStrip assets={message.assets} viewerSlug={viewerSlug} />
        )}

        {message.stopReason && message.stopReason !== 'stop' && (
          <div className="mt-2 text-xs text-stone-500">
            stop: <code className="rounded bg-stone-100 px-1 py-0.5">{message.stopReason}</code>
          </div>
        )}

        {message.streaming && <WorkStatusRow message={message} now={now} />}
      </div>

      {!message.streaming && !message.pending && !message.error && message.text && (
        <CopyButton text={message.text} />
      )}
    </div>
  );
}

/**
 * Live "agent is working" indicator pinned to the bottom of a streaming
 * message so it stays visible no matter how long the reply grows.
 * Shows elapsed time (server heartbeat when available) + running tool names.
 */
function WorkStatusRow({ message, now }: { message: ChatMessage; now: number }) {
  const running = (message.tools ?? []).filter((t) => !t.endedAt);
  const elapsedMs =
    message.workElapsedMs ??
    (message.startedAt ? Math.max(0, now - message.startedAt) : 0);
  const secs = Math.floor(elapsedMs / 1000);
  const label = message.text ? 'Working' : 'Thinking';

  return (
    <div className="mt-2 flex items-center gap-2 text-xs text-stone-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>
        {label}… {secs}s
        {running.length > 0 && (
          <span className="text-stone-400">
            {' '}
            · {running.map((t) => t.name).join(', ')}
          </span>
        )}
      </span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context) — leave state unchanged.
    }
  }

  return (
    <div className="mt-1.5 flex items-center gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
      <button
        type="button"
        onClick={() => void copy()}
        className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
        title={copied ? 'Copied' : 'Copy'}
        aria-label={copied ? 'Copied' : 'Copy message'}
      >
        {copied ? (
          <Check className="h-4 w-4 text-emerald-600" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
