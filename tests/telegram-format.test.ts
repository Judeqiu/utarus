import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  convertMarkdownTables,
  markdownToTelegramHtml,
  splitTelegramHtml,
} from '../src/interfaces/telegram-format.js';

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});

describe('convertMarkdownTables', () => {
  it('converts a GFM table into bullet key/value rows', () => {
    const md = [
      '| Metric | Value |',
      '| --- | --- |',
      '| Revenue | $10k |',
      '| Margin | 22% |',
      '',
      'After table',
    ].join('\n');
    const out = convertMarkdownTables(md);
    expect(out).toContain('• Metric: Revenue  ·  Value: $10k');
    expect(out).toContain('• Metric: Margin  ·  Value: 22%');
    expect(out).toContain('After table');
    expect(out).not.toContain('| ---');
  });
});

describe('markdownToTelegramHtml', () => {
  it('renders bold, italic, and inline code', () => {
    expect(markdownToTelegramHtml('hi **boss** _there_ `code`')).toBe(
      'hi <b>boss</b> <i>there</i> <code>code</code>',
    );
  });

  it('renders links as Telegram-safe HTML anchors', () => {
    expect(markdownToTelegramHtml('see [docs](https://example.com)')).toBe(
      'see <a href="https://example.com">docs</a>',
    );
  });

  it('escapes raw HTML from the model', () => {
    expect(markdownToTelegramHtml('<b>nope</b>')).toBe('&lt;b&gt;nope&lt;/b&gt;');
  });

  it('renders fenced code blocks', () => {
    expect(markdownToTelegramHtml('```js\nconst x = 1;\n```')).toBe(
      '<pre><code>const x = 1;</code></pre>',
    );
  });

  it('flattens headings to bold', () => {
    expect(markdownToTelegramHtml('## Title')).toBe('<b>Title</b>');
  });

  it('converts list markers to bullets', () => {
    expect(markdownToTelegramHtml('- one\n- two')).toBe('• one\n• two');
  });

  it('converts tables into readable bullets', () => {
    const html = markdownToTelegramHtml(
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
    );
    expect(html).toContain('• A: 1  ·  B: 2');
    expect(html).not.toContain('|');
  });

  it('renders blockquotes', () => {
    const html = markdownToTelegramHtml('> note one\n> note two');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('note one');
    expect(html).toContain('note two');
    expect(html).toContain('</blockquote>');
  });

  it('nests bold around a link', () => {
    expect(markdownToTelegramHtml('**[link](https://example.com) rest**')).toBe(
      '<b><a href="https://example.com">link</a> rest</b>',
    );
  });

  it('does not italicize snake_case identifiers', () => {
    expect(markdownToTelegramHtml('use contact_email field')).toBe(
      'use contact_email field',
    );
  });
});

describe('splitTelegramHtml', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitTelegramHtml('hello', 100)).toEqual(['hello']);
  });

  it('splits on paragraph boundaries', () => {
    const a = 'a'.repeat(50);
    const b = 'b'.repeat(50);
    const chunks = splitTelegramHtml(`${a}\n\n${b}`, 60);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('a');
    expect(chunks.join('')).toContain('b');
  });
});
