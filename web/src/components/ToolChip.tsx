/**
 * ToolChip — inline chip rendered above an assistant message bubble.
 *
 * While a tool is running:  🔧 get_portfolio · 4s…
 * After completion:         🔧 get_portfolio · 240ms ✅ (or ❌)
 *
 * Mirrors Slack's "eyes → gear → ✅/❌" affordance.
 * Spec: docs/webui-chat-design.md §9.
 */

import type { ToolChip as ToolChipData } from '../types.js';
import { CheckCircle2, Loader2, XCircle, Wrench } from 'lucide-react';

interface ToolChipViewProps {
  tool: ToolChipData;
  now: number;
}

export function ToolChipView({ tool, now }: ToolChipViewProps) {
  if (tool.endedAt) {
    return (
      <div className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700">
        <Wrench className="h-3 w-3" />
        <span className="font-mono">{tool.name}</span>
        {tool.durationMs !== undefined && (
          <span className="text-stone-500">· {formatMs(tool.durationMs)}</span>
        )}
        {tool.ok ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <XCircle className="h-3 w-3 text-rose-600" />
        )}
      </div>
    );
  }

  const elapsedMs = now - tool.startedAt;
  return (
    <div className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-700">
      <Wrench className="h-3 w-3" />
      <span className="font-mono">{tool.name}</span>
      <span className="text-stone-500">· {formatMs(elapsedMs)}…</span>
      <Loader2 className="h-3 w-3 animate-spin" />
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
