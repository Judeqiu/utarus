/**
 * Convert GitHub-flavored markdown (the format the agent produces)
 * into Slack mrkdwn for inline delivery.
 *
 * Slack mrkdwn differs from markdown in important ways:
 * - Bold is *text*, not **text**
 * - Italic is _text_, not *text*
 * - Links are <url|label>, not [label](url)
 * - No native tables → monospace code blocks
 * - Headings become bold lines
 *
 * Code fences and inline code are protected so their contents are not
 * re-interpreted as formatting.
 */

const FENCE_PREFIX = 'XFENCEX';
const INLINE_CODE_PREFIX = 'XCODEX';

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(c => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function pipeCount(line: string): number {
  return (line.match(/\|/g) || []).length;
}

function isTableLine(line: string, inTable: boolean): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t) || t.startsWith('>') || t.startsWith('```')) return false;

  if (t.startsWith('|') || t.endsWith('|')) return true;

  const pipes = pipeCount(t);
  if (pipes < 1) return false;

  if (inTable) return true;

  const cells = parseTableRow(t);
  if (cells.length < 2) return false;
  if (isSeparatorRow(cells)) return true;
  if (cells.every(c => c.length <= 120) && t.length <= 200) return true;

  return false;
}

export function markdownTableToMrkdwn(tableLines: string[]): string {
  const rows = tableLines.map(parseTableRow);
  if (rows.length === 0) return '';

  if (rows.length === 1 && !isSeparatorRow(rows[0])) {
    return convertInline(tableLines[0]);
  }

  const bodyStart = rows.length > 1 && isSeparatorRow(rows[1]) ? 2 : 1;
  const dataRows = rows.slice(bodyStart).filter(r => !isSeparatorRow(r));
  const headers = rows[0].map(stripInlineMarkdown);
  const cleaned = dataRows.map(r => r.map(stripInlineMarkdown));

  const colCount = Math.max(headers.length, ...cleaned.map(r => r.length), 0);
  if (colCount === 0) return '';

  const colWidths = Array.from({ length: colCount }, (_, i) => {
    const headerW = (headers[i] || '').length;
    const dataW = cleaned.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
    return Math.max(headerW, dataW, 1);
  });

  const pad = (s: string, w: number) => s.padEnd(w);
  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h || '', colWidths[i])).join(' | '));
  lines.push(colWidths.map(w => '-'.repeat(w)).join(' + '));
  for (const row of cleaned) {
    lines.push(
      colWidths.map((_, i) => pad(row[i] || '', colWidths[i])).join(' | '),
    );
  }
  return '```\n' + lines.join('\n') + '\n```';
}

function convertInline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codes.length;
    codes.push('`' + code + '`');
    return INLINE_CODE_PREFIX + idx + 'X';
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>');
  out = out.replace(/~~([^~]+)~~/g, '~$1~');

  const bolds: string[] = [];
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner) => {
    const idx = bolds.length;
    bolds.push(inner);
    return 'XBOLDX' + idx + 'X';
  });
  out = out.replace(/__([^_]+)__/g, (_m, inner) => {
    const idx = bolds.length;
    bolds.push(inner);
    return 'XBOLDX' + idx + 'X';
  });

  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, (match, pre, inner) => {
    if (inner.startsWith(' ')) return match;
    return pre + '_' + inner + '_';
  });

  out = out.replace(/XBOLDX(\d+)X/g, (_m, i) => '*' + bolds[parseInt(i, 10)] + '*');

  while (/\*[^*\n]+\*\*[^*\n]+\*/.test(out)) {
    out = out.replace(/\*([^*\n]+)\*\*([^*\n]+)\*/g, '*$1*\n*$2*');
  }

  out = out.replace(new RegExp(INLINE_CODE_PREFIX + '(\\d+)X', 'g'), (_m, i) => codes[parseInt(i, 10)]);

  return out;
}

export function markdownToMrkdwn(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const fences: string[] = [];
  const withFences = normalized.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = fences.length;
    const body = String(code).replace(/\n$/, '');
    fences.push('```\n' + body + '\n```');
    return FENCE_PREFIX + idx + 'X';
  });

  const lines = withFences.split('\n');
  const out: string[] = [];
  let tableBuf: string[] = [];

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    out.push(markdownTableToMrkdwn(tableBuf));
    tableBuf = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(new RegExp('^' + FENCE_PREFIX + '(\\d+)X$'));
    if (fenceMatch) {
      flushTable();
      out.push(FENCE_PREFIX + fenceMatch[1] + 'X');
      continue;
    }

    if (isTableLine(line, tableBuf.length > 0)) {
      tableBuf.push(line);
      continue;
    }

    flushTable();

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      out.push('*' + convertInline(headingMatch[2].trim()) + '*');
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      out.push('———');
      continue;
    }

    const ulMatch = line.match(/^(\s*)[*+]\s+(.*)$/);
    if (ulMatch) {
      out.push(ulMatch[1] + '• ' + convertInline(ulMatch[2]));
      continue;
    }

    out.push(convertInline(line));
  }
  flushTable();

  let result = out.join('\n');
  result = result.replace(new RegExp(FENCE_PREFIX + '(\\d+)X', 'g'), (_m, i) => fences[parseInt(i, 10)]);
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}
