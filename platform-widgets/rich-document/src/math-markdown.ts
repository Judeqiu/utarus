/**
 * Math in rich-document Markdown ↔ HTML for TipTap.
 *
 * Authoring contract (same as WebUI chat):
 *   $$…$$, \[…\], \(…\)  — math
 *   single $…$             — not math (currency-safe)
 *
 * HTML shape TipTap math nodes parse:
 *   <span data-type="math-inline" data-latex="…">
 *   <div data-type="math-display" data-latex="…">
 */

import { normalizeMathDelimiters } from '../../../web/src/lib/normalize-math-delimiters.ts';

export function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function unescapeHtmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** True when index is start of string or after newline. */
function isLineStart(s: string, i: number): boolean {
  return i === 0 || s[i - 1] === '\n';
}

type Segment = { kind: 'code' | 'text'; value: string };

/** Same code-protection split as normalizeMathDelimiters (fenced + inline). */
export function splitPreservingCode(md: string): Segment[] {
  const segs: Segment[] = [];
  let i = 0;
  let textBuf = '';

  const flushText = (): void => {
    if (textBuf.length > 0) {
      segs.push({ kind: 'text', value: textBuf });
      textBuf = '';
    }
  };

  while (i < md.length) {
    if (isLineStart(md, i) && (md.startsWith('```', i) || md.startsWith('~~~', i))) {
      flushText();
      const fenceChar = md[i]!;
      let openLen = 0;
      while (i + openLen < md.length && md[i + openLen] === fenceChar) openLen++;
      let j = i + openLen;
      while (j < md.length && md[j] !== '\n') j++;
      if (j < md.length && md[j] === '\n') j++;

      let closed = false;
      while (j < md.length) {
        if (isLineStart(md, j)) {
          let k = 0;
          while (j + k < md.length && md[j + k] === fenceChar) k++;
          if (k >= openLen) {
            let end = j + k;
            while (end < md.length && md[end] !== '\n' && /\s/.test(md[end]!)) end++;
            if (end >= md.length || md[end] === '\n') {
              if (end < md.length && md[end] === '\n') end++;
              segs.push({ kind: 'code', value: md.slice(i, end) });
              i = end;
              closed = true;
              break;
            }
          }
        }
        j++;
      }
      if (!closed) {
        segs.push({ kind: 'code', value: md.slice(i) });
        return segs;
      }
      continue;
    }

    if (md[i] === '`') {
      flushText();
      let openLen = 0;
      while (i + openLen < md.length && md[i + openLen] === '`') openLen++;
      const closer = '`'.repeat(openLen);
      const closeAt = md.indexOf(closer, i + openLen);
      if (closeAt === -1) {
        segs.push({ kind: 'code', value: md.slice(i) });
        return segs;
      }
      const end = closeAt + openLen;
      segs.push({ kind: 'code', value: md.slice(i, end) });
      i = end;
      continue;
    }

    textBuf += md[i];
    i++;
  }
  flushText();
  return segs;
}

function mathHtml(latex: string, display: boolean): string {
  const esc = escapeHtmlAttr(latex);
  if (display) {
    return `<div data-type="math-display" data-latex="${esc}" class="math-node math-display"></div>`;
  }
  return `<span data-type="math-inline" data-latex="${esc}" class="math-node math-inline"></span>`;
}

/**
 * Replace $$…$$ pairs in plain text with math HTML (outside code).
 * Body with a newline → display; single-line → inline.
 */
export function dollarsToMathHtml(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2);
      if (end === -1) {
        out += text.slice(i);
        break;
      }
      const body = text.slice(i + 2, end);
      const display = body.includes('\n');
      out += mathHtml(body.trim(), display);
      i = end + 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Markdown → HTML fragment with math nodes as data-type elements.
 * Call before marked.parse (or after: inject then parse so GFM still applies).
 *
 * Order: normalize \[ \( → $$ , then $$ → math HTML, then caller runs marked.
 * Math HTML is raw HTML; marked leaves it alone when present as HTML blocks/spans.
 */
export function prepareMarkdownForHtml(md: string): string {
  const normalized = normalizeMathDelimiters(md);
  const segs = splitPreservingCode(normalized);
  let out = '';
  for (const seg of segs) {
    out += seg.kind === 'code' ? seg.value : dollarsToMathHtml(seg.value);
  }
  return out;
}

/** Serialize math HTML element back to Markdown $$ delimiters. */
export function mathElementToMarkdown(
  tagName: string,
  dataType: string | null,
  dataLatex: string | null,
): string | null {
  if (!dataLatex && dataLatex !== '') return null;
  const latex = (dataLatex ?? '').trim();
  if (dataType === 'math-inline' || (tagName === 'SPAN' && dataType === 'math-inline')) {
    return `$$${latex}$$`;
  }
  if (dataType === 'math-display' || (tagName === 'DIV' && dataType === 'math-display')) {
    return `\n\n$$\n${latex}\n$$\n\n`;
  }
  return null;
}
