/**
 * Convert common Markdown (LLM output) into Telegram HTML parse_mode markup.
 *
 * Telegram does not render Markdown tables, raw **bold**, or GitHub-flavored
 * markdown. HTML mode is the most reliable: escape text, then re-apply a small
 * set of supported tags.
 */

const TELEGRAM_MAX_MESSAGE = 4096;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.includes('|', 1);
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  // |---|:---:|---|
  if (!t.includes('-')) return false;
  return /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(t) && /-/.test(t);
}

function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** Turn GFM tables into bullet key/value rows Telegram can show cleanly. */
export function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(lines[i]);
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const cells = splitTableRow(lines[i]);
        const parts: string[] = [];
        for (let c = 0; c < headers.length; c++) {
          const h = headers[c] || `Col ${c + 1}`;
          const v = cells[c] ?? '';
          if (h || v) parts.push(`${h}: ${v}`);
        }
        out.push(parts.length ? `• ${parts.join('  ·  ')}` : '•');
        i++;
      }
      // Keep a blank line after a table block when the next line isn't blank.
      if (i < lines.length && lines[i].trim() !== '') out.push('');
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/**
 * Markdown → Telegram HTML.
 * Supports: bold, italic, strike, inline code, fenced code, links, headings,
 * blockquotes, unordered lists, tables (→ bullets).
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  let s = markdown.replace(/\r\n/g, '\n');

  // 1) Protect fenced code blocks
  const fences: string[] = [];
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    const body = String(code).replace(/\n$/, '');
    const i = fences.length;
    fences.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });

  // 2) Protect inline code
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = codes.length;
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${i}\u0000`;
  });

  // 3) Tables → bullets (before escaping)
  s = convertMarkdownTables(s);

  // 4) Protect links [label](url)
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    const i = links.length;
    links.push(`<a href="${escapeHtmlAttr(url)}">${escapeHtml(label)}</a>`);
    return `\u0000LINK${i}\u0000`;
  });

  // 5) Headings → bold lines
  s = s.replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => {
    return `\u0000BOLD${escapeHtml(title.trim())}\u0000`;
  });

  // 6) Blockquotes (contiguous > lines → one blockquote)
  s = s.replace(/(?:^> ?.*(?:\n|$))+?/gm, (block) => {
    const inner = block
      .split('\n')
      .map((line) => line.replace(/^> ?/, ''))
      .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
      .join('\n');
    return `\u0000QUOTE${escapeHtml(inner)}\u0000\n`;
  });

  // 7) Escape remaining plain text (placeholders use \u0000 which is fine)
  s = escapeHtml(s);

  // 8) Bold / italic / strike on escaped text
  // Order: bold first so ** doesn't get eaten by italic *
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(.+?)__/g, '<b>$1</b>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Single *italic* — require non-space after/before * so list markers stay put
  s = s.replace(/(?<!\*)\*(?!\s|\*)(.+?)(?<!\s|\*)\*(?!\*)/g, '<i>$1</i>');
  // Single _italic_ only at word edges — avoids mangling snake_case like contact_email
  s = s.replace(/(?<=^|[\s(])_(?!\s|_)(.+?)(?<!\s|_)_(?=$|[\s).,!?:;])/g, '<i>$1</i>');

  // 9) Unordered list markers (- / *) at line start → bullet
  s = s.replace(/^[\t ]*[-*][\t ]+/gm, '• ');

  // 10) Restore protected segments
  s = s.replace(/\u0000BOLD(.*?)\u0000/g, '<b>$1</b>');
  s = s.replace(/\u0000QUOTE(.*?)\u0000/gs, '<blockquote>$1</blockquote>');
  s = s.replace(/\u0000LINK(\d+)\u0000/g, (_m, i) => links[Number(i)] ?? '');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codes[Number(i)] ?? '');
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? '');

  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Split a Telegram HTML message without breaking tags mid-chunk. */
export function splitTelegramHtml(html: string, maxLen = TELEGRAM_MAX_MESSAGE): string[] {
  if (html.length <= maxLen) return [html];

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;

    // Prefer not to cut inside an open HTML tag
    const slice = remaining.slice(0, cut);
    const lastLt = slice.lastIndexOf('<');
    const lastGt = slice.lastIndexOf('>');
    if (lastLt > lastGt) {
      // Inside a tag — cut before the '<'
      cut = lastLt > 0 ? lastLt : cut;
    }

    const part = remaining.slice(0, cut).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [html.slice(0, maxLen)];
}
