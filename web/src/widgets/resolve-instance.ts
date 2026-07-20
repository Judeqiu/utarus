/**
 * Resolve latest WidgetSpec for an instanceId from conversation messages.
 */

import {
  parseWidgetFenceBody,
  type WidgetSpec,
  type WidgetSpecResult,
} from './widget-spec.js';

const FENCE_RE = /```widget\n([\s\S]*?)```/g;

export function extractWidgetFences(text: string): WidgetSpec[] {
  const out: WidgetSpec[] = [];
  if (typeof text !== 'string') return out;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const parsed = parseWidgetFenceBody(m[1] ?? '');
    if (parsed.ok) out.push(parsed.spec);
  }
  return out;
}

export function resolveWidgetInstance(
  messages: ReadonlyArray<{ role: string; text: string }>,
  instanceId: string,
): WidgetSpecResult {
  let kind0: string | undefined;
  let persistence0: string | undefined;
  let last: WidgetSpec | undefined;
  let sawOpen = false;

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const spec of extractWidgetFences(msg.text)) {
      if (spec.instanceId !== instanceId) continue;
      if (spec.action === 'open') {
        if (!sawOpen) {
          kind0 = spec.kind;
          persistence0 = spec.persistence;
          sawOpen = true;
        } else if (spec.kind !== kind0) {
          return {
            ok: false,
            error: `kind mismatch for instanceId ${instanceId} (open was '${kind0}', update is '${spec.kind}')`,
          };
        }
      } else {
        if (kind0 !== undefined && spec.kind !== kind0) {
          return {
            ok: false,
            error: `kind mismatch for instanceId ${instanceId} (open was '${kind0}', update is '${spec.kind}')`,
          };
        }
        if (persistence0 !== undefined && spec.persistence !== persistence0) {
          return {
            ok: false,
            error: `persistence mismatch for instanceId ${instanceId}`,
          };
        }
      }
      last = spec;
    }
  }

  if (!last) {
    return { ok: false, error: `No widget fences for instanceId ${instanceId}` };
  }
  if (!sawOpen) {
    return {
      ok: false,
      error: `Update without prior open for instanceId ${instanceId}`,
    };
  }
  return { ok: true, spec: last };
}

/** Last action:open fence in assistant text of a single message (for auto-open). */
export function lastOpenInAssistantText(text: string): WidgetSpec | null {
  const specs = extractWidgetFences(text).filter((s) => s.action === 'open');
  return specs.length ? specs[specs.length - 1]! : null;
}

/** Last widget fence of any action (open or update) in a single assistant message. */
export function lastWidgetFenceInAssistantText(text: string): WidgetSpec | null {
  const specs = extractWidgetFences(text);
  return specs.length ? specs[specs.length - 1]! : null;
}
