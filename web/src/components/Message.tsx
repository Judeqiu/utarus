/**
 * Message — one bubble in the conversation thread.
 *
 * User bubble: plain text (escaped). Assistant bubble: tool chips, then
 * MarkdownRenderer, then AttachmentStrip. Pending state shows a "…"
 * placeholder while waiting for the first delta.
 *
 * Spec: docs/webui-chat-design.md §9.
 */

import type { ChatMessage } from '../types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { ToolChipView } from './ToolChip.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { Loader } from 'lucide-react';

interface MessageViewProps {
  message: ChatMessage;
  viewerSlug: string;
  now: number;
  agentName: string;
}

export function MessageView({ message, viewerSlug, now, agentName }: MessageViewProps) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-blue-600 px-3 py-2 text-sm text-white">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start">
      <div className="mb-1 text-xs font-medium text-slate-500">{agentName}</div>
      <div className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        {message.tools && message.tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.tools.map((t) => (
              <ToolChipView key={t.toolCallId} tool={t} now={now} />
            ))}
          </div>
        )}

        {message.error ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {message.error}
          </div>
        ) : message.text ? (
          <MarkdownRenderer text={message.text} viewerSlug={viewerSlug} />
        ) : message.pending ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader className="h-4 w-4 animate-spin" />
            <span>Thinking…</span>
          </div>
        ) : null}

        {message.assets && message.assets.length > 0 && (
          <AttachmentStrip assets={message.assets} viewerSlug={viewerSlug} />
        )}

        {message.stopReason && message.stopReason !== 'stop' && (
          <div className="mt-2 text-xs text-slate-500">
            stop: <code className="rounded bg-slate-100 px-1 py-0.5">{message.stopReason}</code>
          </div>
        )}
      </div>
    </div>
  );
}
