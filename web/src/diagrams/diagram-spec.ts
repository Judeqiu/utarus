/**
 * Pure Mermaid diagram fence validation (client).
 * Free ```mermaid fences only — no tool, no server dual module in v1.
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
 * Validate a ```mermaid fence body.
 * Fail-fast: empty, oversize, or non-string → clear error. No silent defaults.
 */
export function validateMermaidSource(body: unknown): DiagramSpecResult {
  if (typeof body !== 'string') {
    return reject('mermaid fence body must be a string');
  }
  // Normalize line endings; do not trim interior (layout can matter).
  const source = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (source.trim().length === 0) {
    return reject('mermaid fence body is empty');
  }
  const bytes = utf8ByteLength(source);
  if (bytes > MERMAID_BODY_MAX_BYTES) {
    return reject(
      `mermaid fence body exceeds ${MERMAID_BODY_MAX_BYTES} bytes (got ${bytes})`,
    );
  }
  return { ok: true, source };
}

/**
 * Parse a ```mermaid fence body (alias for validate — body is already the source).
 */
export function parseMermaidFenceBody(body: string): DiagramSpecResult {
  return validateMermaidSource(body);
}
