/**
 * Mermaid diagram-spec validation (mirrors web/src/diagrams/diagram-spec.ts).
 * Client owns the module; this test copies the pure rules for fail-fast guarantees.
 */
import { describe, expect, it } from 'vitest';
import {
  MERMAID_BODY_MAX_BYTES,
  mermaidLabelNeedsQuotes,
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

  it('auto-quotes unquoted diamond labels with parentheses (math agent pitfall)', () => {
    // Real failure from mathteacher: B{g(x) ≥ 0?} → lexer got 'PS'
    const out = prepareMermaidSource(
      'flowchart TD\n    A["|f(x)| < g(x)"] --> B{g(x) ≥ 0?}\n    B -->|Yes| D["Square"]',
    );
    expect(out).toContain('B{"g(x) ≥ 0?"}');
    expect(out).not.toMatch(/B\{g\(x\)/);
  });

  it('auto-quotes unquoted rectangle labels with parentheses', () => {
    const out = prepareMermaidSource('flowchart TD\n  A[g(x)] --> B[ok]');
    expect(out).toContain('A["g(x)"]');
  });

  it('does not re-quote already quoted labels', () => {
    const src = 'flowchart TD\n  A["g(x)"] --> B{"h(x) ≥ 0?"}';
    expect(prepareMermaidSource(src)).toContain('A["g(x)"]');
    expect(prepareMermaidSource(src)).toContain('B{"h(x) ≥ 0?"}');
  });

  it('does not touch labels without parentheses', () => {
    const src = 'flowchart TD\n  A[Integral messy] --> B{Product?}';
    expect(prepareMermaidSource(src)).toContain('A[Integral messy]');
    expect(prepareMermaidSource(src)).toContain('B{Product?}');
  });

  it('does not corrupt edge labels', () => {
    const src = 'flowchart TD\n  A --> B\n  B -->|No| C\n  B -->|Yes| D';
    const out = prepareMermaidSource(src);
    expect(out).toContain('-->|No|');
    expect(out).toContain('-->|Yes|');
  });
});

describe('mermaidLabelNeedsQuotes', () => {
  it('flags parentheses only', () => {
    expect(mermaidLabelNeedsQuotes('g(x) ≥ 0?')).toBe(true);
    expect(mermaidLabelNeedsQuotes('Product of functions?')).toBe(false);
  });
});
