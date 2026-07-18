/**
 * Pure helpers for resolving a chat quote from a DOM Selection.
 * Spec: docs/webui-chat-quote-design.md
 */

export interface QuoteSelectionResult {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  rangeRect: DOMRect;
}

/**
 * Resolve a quote from the current selection.
 * Requires anchors under a single [data-quote-source] with a server-known id.
 */
export function resolveQuoteFromSelection(
  selection: Selection | null,
  opts: { serverKnownMessageIds: ReadonlySet<string> },
): QuoteSelectionResult | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (!text) return null;

  const range = selection.getRangeAt(0);
  const startEl = nodeToElement(range.startContainer);
  const endEl = nodeToElement(range.endContainer);
  if (!startEl || !endEl) return null;

  const startRoot = startEl.closest('[data-quote-source]') as HTMLElement | null;
  const endRoot = endEl.closest('[data-quote-source]') as HTMLElement | null;
  if (!startRoot || !endRoot || startRoot !== endRoot) return null;

  const messageId = startRoot.getAttribute('data-message-id');
  const roleAttr = startRoot.getAttribute('data-message-role');
  if (!messageId || (roleAttr !== 'user' && roleAttr !== 'assistant')) {
    return null;
  }
  if (!opts.serverKnownMessageIds.has(messageId)) {
    return null;
  }

  let rangeRect: DOMRect;
  const rects = range.getClientRects();
  if (rects.length > 0) {
    rangeRect = rects[0]!;
  } else {
    rangeRect = range.getBoundingClientRect();
  }
  if (!rangeRect || (rangeRect.width === 0 && rangeRect.height === 0)) {
    // Fallback: use the source root
    rangeRect = startRoot.getBoundingClientRect();
  }

  return {
    messageId,
    role: roleAttr,
    text,
    rangeRect,
  };
}

function nodeToElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}
