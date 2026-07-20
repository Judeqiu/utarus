/**
 * Chat fence embeds (map, widget, mermaid, future gadgets).
 *
 * Fenced blocks render as <pre><code>…</code></pre>. Custom embed components
 * replace <code>, but without unwrap the dark `.prose-chat pre` shell remains
 * (black outer card).
 *
 * Convention for every embed root:
 * 1. Single React root element (no Fragment as the code-component return).
 * 2. Put {@link CHAT_EMBED_ATTR} on that root DOM node.
 *
 * MarkdownRenderer unwraps <pre> when the only child carries this attribute;
 * CSS also strips pre chrome via :has([data-chat-embed]) as a safety net.
 */

/** DOM attribute — set on the outer element of any chat fence embed. */
export const CHAT_EMBED_ATTR = 'data-chat-embed' as const;

/** Spread onto the embed root: `<div {...CHAT_EMBED_PROPS} className=…>`. */
export const CHAT_EMBED_PROPS = {
  [CHAT_EMBED_ATTR]: true,
} as const;
