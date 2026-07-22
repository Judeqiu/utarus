/**
 * Collect widget tool fences and ensure they appear in the assistant final text.
 *
 * WebUI opens the side panel / WidgetCard only from ```widget fences (or a live
 * SSE `widget` event). Agents sometimes call show_widget successfully but forget
 * to paste the WEB ONLY fence — this module makes the run resilient without
 * inventing fences (only reuses tool-returned fence bodies).
 */

import { parseWidgetFenceBody } from '../../widgets/widget-spec.js';

const WIDGET_FENCE_RE = /```widget\n([\s\S]*?)```/g;

/** Extract instanceIds already present as ```widget fences in assistant text. */
export function widgetInstanceIdsInText(text: string): Set<string> {
  const ids = new Set<string>();
  if (typeof text !== 'string' || !text) return ids;
  WIDGET_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIDGET_FENCE_RE.exec(text)) !== null) {
    const parsed = parseWidgetFenceBody(m[1] ?? '');
    if (parsed.ok) ids.add(parsed.spec.instanceId);
  }
  return ids;
}

/**
 * If `text` already has a fence for an instance, leave it.
 * Otherwise append the tool-returned fence body as a ```widget block.
 * `fenceBodies` order is preserved; last body for a given instance wins when
 * the same id appears twice in the list.
 */
export function ensureWidgetFencesInText(
  text: string,
  fenceBodies: readonly string[],
): string {
  if (fenceBodies.length === 0) return text;

  // Last fence body per instanceId (later tool calls replace earlier).
  const byInstance = new Map<string, string>();
  for (const body of fenceBodies) {
    if (typeof body !== 'string' || !body.trim()) {
      throw new Error('ensureWidgetFencesInText: empty fence body');
    }
    const parsed = parseWidgetFenceBody(body);
    if (!parsed.ok) {
      throw new Error(`ensureWidgetFencesInText: invalid fence: ${parsed.error}`);
    }
    byInstance.set(parsed.spec.instanceId, body);
  }

  const present = widgetInstanceIdsInText(text);
  const missing: string[] = [];
  for (const [instanceId, body] of byInstance) {
    if (!present.has(instanceId)) {
      missing.push(body);
    }
  }
  if (missing.length === 0) return text;

  const blocks = missing.map((body) => `\`\`\`widget\n${body}\n\`\`\``).join('\n\n');
  const base = text.trimEnd();
  if (!base) return blocks + '\n';
  return `${base}\n\n${blocks}\n`;
}

/**
 * Read fence body from a successful show_widget / update_widget tool result.
 * Fail-fast when the tool claims success but omits a usable fence.
 */
export function fenceBodyFromWidgetToolResult(
  toolName: string,
  result: unknown,
): string {
  if (result === null || typeof result !== 'object') {
    throw new Error(`${toolName} result is not an object`);
  }
  const details = (result as { details?: unknown }).details;
  if (details === null || typeof details !== 'object') {
    throw new Error(`${toolName} succeeded without details`);
  }
  const fence = (details as { fence?: unknown }).fence;
  if (typeof fence !== 'string' || !fence.trim()) {
    throw new Error(`${toolName} succeeded without details.fence`);
  }
  const parsed = parseWidgetFenceBody(fence);
  if (!parsed.ok) {
    throw new Error(`${toolName} details.fence invalid: ${parsed.error}`);
  }
  return fence;
}
