/**
 * Collect show_card tool fences and ensure they appear in the assistant final text.
 *
 * WebUI renders InfoCard / InfoCardDeck only from ```card fences. Agents often
 * call show_card successfully but forget to paste the WEB ONLY fence, or paste a
 * collapsed/mid-line blob that is not a CommonMark fence. This module makes the
 * run resilient without inventing fences (only reuses tool-returned fence bodies).
 *
 * Mirrors widget-fences.ts. Cards have no instanceId — identity is the validated
 * deck spec (JSON of parseCardFenceBody result).
 */

import { parseCardFenceBody } from '../../cards/card-spec.js';

/** Closed ```card fences with a newline after the info string (CommonMark). */
const CARD_FENCE_RE = /```card\n([\s\S]*?)```/g;

/** Stable identity for a valid fence body. */
export function cardFenceKey(body: string): string {
  const parsed = parseCardFenceBody(body);
  if (!parsed.ok) {
    throw new Error(`cardFenceKey: invalid fence: ${parsed.error}`);
  }
  return JSON.stringify(parsed.spec);
}

/** Extract fence bodies from text that parse as valid card decks. */
export function validCardFenceBodiesInText(text: string): string[] {
  const bodies: string[] = [];
  if (typeof text !== 'string' || !text) return bodies;
  CARD_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CARD_FENCE_RE.exec(text)) !== null) {
    const body = (m[1] ?? '').replace(/\n$/, '');
    const parsed = parseCardFenceBody(body);
    if (parsed.ok) bodies.push(body);
  }
  return bodies;
}

/**
 * Remove closed ```card fences that fail parse, and mid-line / single-line
 * collapsed pastes that never form a valid multi-line fence body.
 */
export function stripBrokenCardFences(text: string): string {
  if (typeof text !== 'string' || !text) return text;

  // 1) Closed multi-line fences: drop invalid, keep valid.
  let out = text.replace(/```card\n([\s\S]*?)```/g, (full, body: string) => {
    const parsed = parseCardFenceBody(body);
    return parsed.ok ? full : '';
  });

  // 2) Mid-line collapsed paste (fence not at line start), e.g.
  //    "Here's a summary:```card version: 1 layout: stack cards: [...]"
  //    Optional trailing ``` on the same line.
  out = out.replace(/([^\n`])```card\b[^\n]*(?:```)?/g, '$1');

  // 3) Line-start single-line collapsed fence (fields not on separate lines).
  //    e.g. "```card version: 1 layout: stack cards: [...]```"
  out = out.replace(/^```card[ \t]+[^\n]+(?:```)?$/gm, '');

  // Collapse leftover blank runs from removals.
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out;
}

/**
 * If `text` already has a valid fence matching a tool body, leave it.
 * Otherwise append the tool-returned fence body as a ```card block.
 * Broken/mangled card-like blobs are stripped first so garbage does not remain.
 * `fenceBodies` order is preserved; last body for a given deck key wins.
 */
export function ensureCardFencesInText(
  text: string,
  fenceBodies: readonly string[],
): string {
  if (fenceBodies.length === 0) return text;

  // Last fence body per deck key (later tool calls replace earlier).
  const byKey = new Map<string, string>();
  for (const body of fenceBodies) {
    if (typeof body !== 'string' || !body.trim()) {
      throw new Error('ensureCardFencesInText: empty fence body');
    }
    const parsed = parseCardFenceBody(body);
    if (!parsed.ok) {
      throw new Error(`ensureCardFencesInText: invalid fence: ${parsed.error}`);
    }
    byKey.set(cardFenceKey(body), body);
  }

  const cleaned = stripBrokenCardFences(typeof text === 'string' ? text : '');
  const presentKeys = new Set(
    validCardFenceBodiesInText(cleaned).map((b) => cardFenceKey(b)),
  );

  const missing: string[] = [];
  for (const [key, body] of byKey) {
    if (!presentKeys.has(key)) missing.push(body);
  }

  if (missing.length === 0) return cleaned;

  const blocks = missing.map((body) => `\`\`\`card\n${body}\n\`\`\``).join('\n\n');
  const base = cleaned.trimEnd();
  if (!base) return blocks + '\n';
  return `${base}\n\n${blocks}\n`;
}

/**
 * Read fence body from a successful show_card tool result.
 * Fail-fast when the tool claims success but omits a usable fence.
 */
export function fenceBodyFromCardToolResult(
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
  const parsed = parseCardFenceBody(fence);
  if (!parsed.ok) {
    throw new Error(`${toolName} details.fence invalid: ${parsed.error}`);
  }
  return fence;
}
