/**
 * Parse rich-document Markdown subset into structured blocks for export.
 * Mirrors the editor's supported features (no tables/images/HTML).
 */

export type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; spans: InlineSpan[] }
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'bullet'; spans: InlineSpan[] }
  | { type: 'ordered'; index: number; spans: InlineSpan[] }
  | { type: 'blockquote'; spans: InlineSpan[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'hr' };

const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // Order: code, links, bold, italic
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      spans.push({ kind: 'text', text: text.slice(last, m.index) });
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      spans.push({ kind: 'code', text: tok.slice(1, -1) });
    } else if (tok.startsWith('**')) {
      spans.push({ kind: 'bold', text: tok.slice(2, -2) });
    } else if (tok.startsWith('*')) {
      spans.push({ kind: 'italic', text: tok.slice(1, -1) });
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (lm) spans.push({ kind: 'link', text: lm[1], href: lm[2] });
      else spans.push({ kind: 'text', text: tok });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) {
    spans.push({ kind: 'text', text: text.slice(last) });
  }
  if (spans.length === 0) spans.push({ kind: 'text', text: '' });
  return spans;
}

export function parseMarkdownBlocks(markdown: string): MdBlock[] {
  if (CONTROL.test(markdown)) {
    throw new Error('markdown contains control characters');
  }
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, spans: parseInline(heading[2].trim()) });
      i += 1;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: 'bullet', spans: parseInline(bullet[1]) });
      i += 1;
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)$/);
    if (ordered) {
      blocks.push({
        type: 'ordered',
        index: parseInt(ordered[1], 10),
        spans: parseInline(ordered[2]),
      });
      i += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'blockquote', spans: parseInline(quote[1]) });
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // paragraph: merge consecutive non-empty non-special lines
    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const n = lines[i];
      if (
        n.trim() === '' ||
        /^```/.test(n) ||
        /^#{1,6}\s/.test(n) ||
        /^[-*]\s+/.test(n) ||
        /^\d+\.\s+/.test(n) ||
        /^>\s?/.test(n) ||
        /^---+\s*$/.test(n)
      ) {
        break;
      }
      para.push(n);
      i += 1;
    }
    blocks.push({ type: 'paragraph', spans: parseInline(para.join(' ')) });
  }
  return blocks;
}

export function spansToPlain(spans: InlineSpan[]): string {
  return spans
    .map((s) => {
      if (s.kind === 'link') return `${s.text} (${s.href})`;
      return s.text;
    })
    .join('');
}

/** Safe download basename from panel title. */
export function safeExportBasename(title: string): string {
  const t = title.trim().replace(/[^\w\s.-]+/g, '').replace(/\s+/g, '-').slice(0, 80);
  return t || 'document';
}
