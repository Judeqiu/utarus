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
    // Mid-line \[…\] cannot be block math — degrades to inline $$…$$.
    expect(out).toContain('$$a+b$$');
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
    // 'After \[c\]' is mid-line → inline math.
    expect(out).toContain('After $$c$$');
  });

  it('does not rewrite delimiters inside inline code', () => {
    const input = 'Use `\\[x\\]` in docs, not \\[x\\] bare.';
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('`\\[x\\]`');
    // Mid-line \[…\] degrades to inline math (see currency test).
    expect(out).toContain('$$x$$');
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

  it('keeps the closing $$ fence inside a list item (nolex02 hint bug)', () => {
    // Exact shape from mathteacher chat on nolex02
    // (8651253f-aeb4-4e0c-a530-a9b139decc5a.json): display math inside a
    // list item. The closing fence used to land at column 0, break out of
    // the list, and shift $$ pairing for the rest of the message — all
    // later text rendered as raw red KaTeX-error output.
    const input = [
      '- Section formula (internal division): ',
      '  \\[',
      '  P = \\frac{2 \\cdot \\mathbf{a} + 1 \\cdot \\mathbf{b}}{3}',
      '  \\]',
      '  — weight the **opposite** endpoint. So \\(P\\) closer to \\(A\\).',
    ].join('\n');
    const out = normalizeMathDelimiters(input);
    // Closing fence must carry the list-item indent, not column 0.
    expect(out).toContain('\n  $$\n');
    expect(out).not.toMatch(/\n\$\$\n/);
    // Total $$ count stays balanced: 2 for the block + 2 inline pairs.
    expect(out.match(/\$\$/g)?.length).toBe(6);
    expect(out).toContain('$$P$$');
    expect(out).toContain('$$A$$');
  });

  it('keeps the closing $$ fence inside a blockquote', () => {
    const input = '> hint:\n> \\[\n> x = 1\n> \\]\n> after \\(y\\) text';
    const out = normalizeMathDelimiters(input);
    expect(out).toContain('> $$\n> x = 1\n> $$');
    expect(out).toContain('$$y$$');
  });

  it('degrades mid-line \\[…\\] to inline math instead of a broken block', () => {
    const input = 'The formula \\[a^2 + b^2 = c^2\\] holds here.';
    const out = normalizeMathDelimiters(input);
    expect(out).toBe('The formula $$a^2 + b^2 = c^2$$ holds here.');
  });

  it('collapses newlines when a mid-line \\[…\\] spans lines', () => {
    const input = 'text \\[a +\nb\\] more';
    const out = normalizeMathDelimiters(input);
    expect(out).toBe('text $$a + b$$ more');
  });
});
