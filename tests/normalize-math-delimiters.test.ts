import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from '../web/src/lib/normalize-math-delimiters.js';

describe('normalizeMathDelimiters', () => {
  it('is a no-op when no LaTeX bracket delimiters are present', () => {
    const md = 'Market cap is $1.675T and **$14.7B**. Also $$E=mc^2$$.';
    expect(normalizeMathDelimiters(md)).toBe(md);
  });

  it('converts display \\[…\\] to $$ block math', () => {
    const input = [
      '**Step 1 — position vector of A:**',
      '\\[',
      '\\mathbf{a} = \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix}',
      '\\]',
    ].join('\n');
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('$$');
    expect(out).not.toContain('\\[');
    expect(out).not.toContain('\\]');
    expect(out).toContain('\\mathbf{a} = \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix}');
    expect(out).toMatch(/\$\$\n\\mathbf\{a\}/);
  });

  it('converts the nolex02 vector micro-example steps', () => {
    // Exact delimiter shape from mathteacher chat on nolex02
    // (705a0fb5-1ec0-4e55-b9a9-ef28016f8100.json).
    const input = [
      '**Step 1 — position vector of A:**',
      '\\[',
      '\\mathbf{a} = \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix}',
      '\\]',
      '',
      '**Step 2 — direction vector from A to B:**',
      '\\[',
      '\\overrightarrow{AB} = \\mathbf{b} - \\mathbf{a} = \\begin{pmatrix}4\\\\6\\\\8\\end{pmatrix} - \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix} = \\begin{pmatrix}3\\\\4\\\\5\\end{pmatrix}',
      '\\]',
      '',
      '**Step 3 — the line:**',
      '\\[',
      '\\mathbf{r} = \\begin{pmatrix}1\\\\2\\\\3\\end{pmatrix} + \\lambda\\begin{pmatrix}3\\\\4\\\\5\\end{pmatrix}, \\quad \\lambda \\in \\mathbb{R}',
      '\\]',
    ].join('\n');

    const out = normalizeMathDelimiters(input);
    expect(out.match(/\$\$/g)?.length).toBe(6); // 3 open + 3 close
    expect(out).not.toMatch(/\\[\[\]]/);
    expect(out).toContain('\\overrightarrow{AB}');
    expect(out).toContain('\\lambda \\in \\mathbb{R}');
  });

  it('converts inline \\(…\\) to same-line $$', () => {
    const input = 'See \\(\\mathbf{r} = \\mathbf{a} + \\lambda\\mathbf{d}\\) please.';
    const out = normalizeMathDelimiters(input);
    expect(out).toBe(
      'See $$\\mathbf{r} = \\mathbf{a} + \\lambda\\mathbf{d}$$ please.',
    );
  });

  it('leaves single-dollar currency and non-math $ alone', () => {
    const input =
      'Price $1.675T and not math $x^2$ plus real \\[a+b\\] and \\(c\\).';
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('$1.675T');
    expect(out).toContain('$x^2$');
    expect(out).toContain('$$\na+b\n$$');
    expect(out).toContain('$$c$$');
  });

  it('does not rewrite delimiters inside fenced code blocks', () => {
    const input = [
      'Prose \\(x\\) ok.',
      '',
      '```tex',
      '\\[',
      'a = b',
      '\\]',
      '```',
      '',
      'After \\[c\\]',
    ].join('\n');
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('$$x$$');
    // Fence body preserved with original \[ \]
    expect(out).toMatch(/```tex\n\\\[\na = b\n\\\]\n```/);
    expect(out).toContain('$$\nc\n$$');
  });

  it('does not rewrite delimiters inside inline code', () => {
    const input = 'Use `\\[x\\]` in docs, not \\[x\\] bare.';
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('`\\[x\\]`');
    expect(out).toContain('$$\nx\n$$');
  });

  it('leaves incomplete pairs unchanged (streaming)', () => {
    const openOnly = 'Working:\n\\[\n\\mathbf{a} =';
    expect(normalizeMathDelimiters(openOnly)).toBe(openOnly);

    const openParen = 'See \\(a+b';
    expect(normalizeMathDelimiters(openParen)).toBe(openParen);
  });

  it('handles multiple inline and display mixes', () => {
    const input = 'Inline \\(a\\) then\n\n\\[\n\\frac{1}{2}\n\\]\n\nand \\(b\\).';
    const out = normalizeMathDelimiters(input);
    expect(out).toBe(
      'Inline $$a$$ then\n\n$$\n\\frac{1}{2}\n$$\n\nand $$b$$.',
    );
  });

  it('protects unclosed fenced code for the rest of the string', () => {
    const input = 'Before \\(a\\)\n\n```js\nconst x = "\\[not math\\]";\n';
    const out = normalizeMathDelimiters(input);
    expect(out.startsWith('Before $$a$$\n\n```js\n')).toBe(true);
    expect(out).toContain('\\[not math\\]');
  });
});
