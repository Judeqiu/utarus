import { describe, expect, it } from 'vitest';
import {
  parseMarkdownBlocks,
  parseInline,
  safeExportBasename,
  spansToPlain,
} from '../web/src/widgets/export/markdown-blocks.js';

describe('parseInline', () => {
  it('parses bold italic code link', () => {
    const spans = parseInline('Hi **bold** and *i* and `c` and [t](https://x.com)');
    expect(spans.some((s) => s.kind === 'bold' && s.text === 'bold')).toBe(true);
    expect(spans.some((s) => s.kind === 'italic' && s.text === 'i')).toBe(true);
    expect(spans.some((s) => s.kind === 'code' && s.text === 'c')).toBe(true);
    expect(
      spans.some((s) => s.kind === 'link' && s.text === 't' && s.href === 'https://x.com'),
    ).toBe(true);
  });
});

describe('parseMarkdownBlocks', () => {
  it('parses headings lists code hr', () => {
    const md = [
      '# Title',
      '',
      'Para **one**',
      '',
      '- a',
      '- b',
      '',
      '1. first',
      '',
      '> quote',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '---',
    ].join('\n');
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.find((b) => b.type === 'heading' && b.level === 1)).toBeTruthy();
    expect(blocks.filter((b) => b.type === 'bullet')).toHaveLength(2);
    expect(blocks.find((b) => b.type === 'ordered')).toBeTruthy();
    expect(blocks.find((b) => b.type === 'blockquote')).toBeTruthy();
    expect(blocks.find((b) => b.type === 'code' && b.lang === 'ts')).toBeTruthy();
    expect(blocks.find((b) => b.type === 'hr')).toBeTruthy();
    const para = blocks.find((b) => b.type === 'paragraph');
    expect(para && spansToPlain(para.spans)).toContain('one');
  });

  it('rejects control characters', () => {
    expect(() => parseMarkdownBlocks('a\x00b')).toThrow(/control/);
  });
});

describe('safeExportBasename', () => {
  it('sanitizes title', () => {
    expect(safeExportBasename('  My Notes!!  ')).toBe('My-Notes');
    expect(safeExportBasename('')).toBe('document');
  });
});
