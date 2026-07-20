/**
 * Pure Mermaid diagram fence validation + label prep (client).
 * Free ```mermaid fences only — no tool, no server dual module in v1.
 *
 * Agents often put HTML emphasis in node labels (`<b>Title</b>`). Mermaid only
 * renders that when htmlLabels are on; we also strip active content tags so
 * label HTML stays formatting-only.
 */

/** Max UTF-8 byte length of the Mermaid source body (not including fence markers). */
export const MERMAID_BODY_MAX_BYTES = 64 * 1024;

export type DiagramSpecResult =
  | { ok: true; source: string }
  | { ok: false; error: string };

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function reject(error: string): DiagramSpecResult {
  return { ok: false, error };
}

/**
 * Allow formatting tags agents commonly emit; strip active / navigational HTML.
 * Called after size/empty checks. Mermaid still runs with securityLevel antiscript.
 */
export function prepareMermaidSource(source: string): string {
  let s = source;
  // Drop whole dangerous elements (incl. content).
  s = s.replace(
    /<\/?(?:script|iframe|object|embed|form|link|meta|style|svg|math|foreignObject)\b[^>]*>/gi,
    '',
  );
  // Strip inline event handlers and javascript: URLs.
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(
    /\s+(?:href|src|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|javascript:[^\s>]+)/gi,
    '',
  );
  // Normalize common self-closing breaks for flowchart labels.
  s = s.replace(/<br\s*\/?>/gi, '<br/>');
  return s;
}

/**
 * Validate a ```mermaid fence body.
 * Fail-fast: empty, oversize, or non-string → clear error. No silent defaults.
 * On success, `source` is prepared for mermaid.render (safe label HTML).
 */
export function validateMermaidSource(body: unknown): DiagramSpecResult {
  if (typeof body !== 'string') {
    return reject('mermaid fence body must be a string');
  }
  // Normalize line endings; do not trim interior (layout can matter).
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.trim().length === 0) {
    return reject('mermaid fence body is empty');
  }
  const bytes = utf8ByteLength(normalized);
  if (bytes > MERMAID_BODY_MAX_BYTES) {
    return reject(
      `mermaid fence body exceeds ${MERMAID_BODY_MAX_BYTES} bytes (got ${bytes})`,
    );
  }
  return { ok: true, source: prepareMermaidSource(normalized) };
}

/**
 * Parse a ```mermaid fence body (alias for validate — body is already the source).
 */
export function parseMermaidFenceBody(body: string): DiagramSpecResult {
  return validateMermaidSource(body);
}
