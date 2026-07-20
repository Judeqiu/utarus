/**
 * Mermaid diagram-spec validation (mirrors web/src/diagrams/diagram-spec.ts).
 * Client owns the module; this test copies the pure rules for fail-fast guarantees.
 */
import { describe, expect, it } from 'vitest';
import {
  MERMAID_BODY_MAX_BYTES,
  parseMermaidFenceBody,
  prepareMermaidSource,
  validateMermaidSource,
} from '../web/src/diagrams/diagram-spec.js';

describe('validateMermaidSource', () => {
  it('accepts a simple flowchart', () => {
    const r = validateMermaidSource('flowchart TD\n  A-->B');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).toContain('flowchart');
  });

  it('rejects empty body', () => {
    const r = validateMermaidSource('   \n  ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/i);
  });

  it('rejects non-string', () => {
    const r = validateMermaidSource(null);
    expect(r.ok).toBe(false);
  });

  it('rejects oversize body', () => {
    const big = 'flowchart TD\n' + 'A-->B\n'.repeat(20_000);
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(MERMAID_BODY_MAX_BYTES);
    const r = validateMermaidSource(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exceeds/);
  });

  it('normalizes CRLF', () => {
    const r = parseMermaidFenceBody('flowchart TD\r\n  A-->B\r\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.source).not.toContain('\r');
  });

  it('keeps formatting tags agents use in labels', () => {
    const r = validateMermaidSource(
      'flowchart TD\n  A["<b>Introduction</b><br/>Hook"]',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toContain('<b>Introduction</b>');
      expect(r.source).toContain('<br/>');
    }
  });
});

describe('prepareMermaidSource', () => {
  it('strips script tags and on* handlers', () => {
    const out = prepareMermaidSource(
      'flowchart TD\n  A["x<script>alert(1)</script>"]\n  B["y" onclick="evil()"]',
    );
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/onclick/i);
  });

  it('normalizes br variants', () => {
    expect(prepareMermaidSource('A["a<br>b"]')).toContain('<br/>');
  });
});
