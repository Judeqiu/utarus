import { describe, expect, it } from 'vitest';
import {
  dollarsToMathHtml,
  escapeHtmlAttr,
  prepareMarkdownForHtml,
  unescapeHtmlAttr,
} from '../platform-widgets/rich-document/src/math-markdown.ts';

describe('escapeHtmlAttr / unescapeHtmlAttr', () => {
  it('round-trips special characters', () => {
    const raw = 'a < b & c > "d"';
    expect(unescapeHtmlAttr(escapeHtmlAttr(raw))).toBe(raw);
  });
});

describe('dollarsToMathHtml', () => {
  it('converts inline $$ to span', () => {
    const html = dollarsToMathHtml('See $$x^2$$ here');
    expect(html).toContain('data-type="math-inline"');
    expect(html).toContain('data-latex="x^2"');
    expect(html).toContain('See ');
    expect(html).toContain(' here');
  });

  it('converts multiline $$ to display div', () => {
    const html = dollarsToMathHtml('$$\n\\frac{a}{b}\n$$');
    expect(html).toContain('data-type="math-display"');
    expect(html).toContain(escapeHtmlAttr('\\frac{a}{b}'));
  });
});

describe('prepareMarkdownForHtml', () => {
  it('maps LaTeX \\[…\\] (nolex02-style) to display math HTML', () => {
    const md = [
      '**Step 1**',
      '\\[',
      '\\mathbf{a} = \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix}',
      '\\]',
    ].join('\n');
    const out = prepareMarkdownForHtml(md);
    expect(out).toContain('data-type="math-display"');
    expect(out).toContain('\\mathbf{a}');
    expect(out).not.toContain('\\[');
  });

  it('maps \\(…\\) to inline math HTML', () => {
    const out = prepareMarkdownForHtml(
      'Vector \\(\\mathbf{d}\\) and point.',
    );
    expect(out).toContain('data-type="math-inline"');
    expect(out).toContain('data-latex="\\mathbf{d}"');
  });

  it('leaves currency single-$ alone', () => {
    const out = prepareMarkdownForHtml('Price $1.675T and $x$ plain.');
    expect(out).toContain('$1.675T');
    expect(out).toContain('$x$');
    expect(out).not.toContain('data-type="math');
  });

  it('does not rewrite math delimiters inside fenced code', () => {
    const md = ['```tex', '\\[a=b\\]', '```', '', 'Live \\(c\\)'].join('\n');
    const out = prepareMarkdownForHtml(md);
    expect(out).toMatch(/```tex\n\\\[a=b\\\]\n```/);
    expect(out).toContain('data-type="math-inline"');
    expect(out).toContain('data-latex="c"');
  });

  it('handles the vectors drill seed pattern from the side panel', () => {
    const md = [
      'Relative to an origin, points have position vectors:',
      '\\[',
      '\\mathbf{a} = 2\\mathbf{i} - \\mathbf{j} + 3\\mathbf{k}, \\qquad \\mathbf{b} = 4\\mathbf{i} + 3\\mathbf{j} - \\mathbf{k}.',
      '\\]',
      '',
      'The point (Q) has position vector \\(\\mathbf{q} = 5\\mathbf{i} + \\mathbf{j} + 2\\mathbf{k}\\).',
    ].join('\n');
    const out = prepareMarkdownForHtml(md);
    expect(out.match(/data-type="math-display"/g)?.length).toBe(1);
    expect(out.match(/data-type="math-inline"/g)?.length).toBe(1);
    expect(out).toContain('\\mathbf{a}');
    expect(out).toContain('\\mathbf{q}');
  });
});
