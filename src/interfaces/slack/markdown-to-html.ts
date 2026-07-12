/**
 * Markdown to HTML converter for long responses.
 *
 * Used when a Slack response would be too long to read comfortably inline.
 * The output is a self-contained HTML document with styling, suitable for
 * uploading as a Slack file attachment.
 */

import { config } from '../../config.js';

const CODEBLOCK_PLACEHOLDER_PREFIX = 'XCODEBLOCKX';
const CODEBLOCK_PLACEHOLDER_REGEX = new RegExp('^' + CODEBLOCK_PLACEHOLDER_PREFIX + '(\\d+)X$');

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function applyInline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(c => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every(c => /^:?-+:?$/.test(c));
}

function renderTable(rows: string[][]): string {
  const header = rows[0];
  const bodyStart = rows.length > 1 && isSeparatorRow(rows[1]) ? 2 : 1;
  const body = rows.slice(bodyStart);
  const thead = '<thead><tr>' + header.map(h => '<th>' + applyInline(h) + '</th>').join('') + '</tr></thead>';
  const tbody = body.length > 0
    ? '<tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + applyInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>'
    : '';
  return '<table>' + thead + tbody + '</table>';
}

export function markdownToHtml(text: string): string {
  const codeBlocks: string[] = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const withPlaceholders = text.replace(codeBlockRegex, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    return CODEBLOCK_PLACEHOLDER_PREFIX + idx + 'X';
  });

  const lines = withPlaceholders.split('\n');
  const out: string[] = [];
  let inUl = false;
  let inOl = false;
  let tableRows: string[][] = [];

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  const flushTable = () => {
    if (tableRows.length > 0) {
      out.push(renderTable(tableRows));
      tableRows = [];
    }
  };

  for (const line of lines) {
    const cbMatch = line.match(CODEBLOCK_PLACEHOLDER_REGEX);
    if (cbMatch) {
      closeLists();
      flushTable();
      out.push(codeBlocks[parseInt(cbMatch[1], 10)]);
      continue;
    }

    if (line.trim() === '') {
      closeLists();
      flushTable();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      closeLists();
      flushTable();
      out.push('<hr>');
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      closeLists();
      flushTable();
      const level = headingMatch[1].length;
      out.push('<h' + level + '>' + applyInline(headingMatch[2]) + '</h' + level + '>');
      continue;
    }

    if (line.trim().startsWith('|')) {
      closeLists();
      tableRows.push(parseTableRow(line));
      continue;
    } else {
      flushTable();
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
      out.push('<li>' + applyInline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>');
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
      out.push('<li>' + applyInline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>');
      continue;
    }

    if (/^>\s+/.test(line)) {
      closeLists();
      out.push('<blockquote><p>' + applyInline(line.replace(/^>\s+/, '')) + '</p></blockquote>');
      continue;
    }

    closeLists();
    out.push('<p>' + applyInline(line) + '</p>');
  }

  closeLists();
  flushTable();

  return out.join('\n');
}

/**
 * Simple fixed light theme for all devices.
 *
 * Avoids prefers-color-scheme: dark without pairing body background — on iOS
 * Safari that often yields light text on a light canvas (unreadable on phone,
 * fine on Mac if the Mac stays in light mode).
 */
export function wrapHtmlReport(title: string, bodyHtml: string, generatedAt: Date = new Date()): string {
  const ts = generatedAt.toLocaleString();
  const agentName = config.agent.name ?? 'Agent';
  const styles = [
    /* Force light rendering even when the phone OS is in dark mode */
    'html { color-scheme: light only; background: #ffffff; }',
    'body {',
    '  box-sizing: border-box;',
    '  margin: 0;',
    '  padding: 1.25rem 1rem 2.5rem;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
    '  font-size: 16px;',
    '  line-height: 1.55;',
    '  color: #111827;',
    '  background: #ffffff;',
    '  -webkit-text-size-adjust: 100%;',
    '}',
    '*, *::before, *::after { box-sizing: border-box; }',
    '.page {',
    '  max-width: 720px;',
    '  margin: 0 auto;',
    '}',
    '.agent-header {',
    '  background: #1f2937;',
    '  color: #ffffff;',
    '  padding: 1.1rem 1.25rem;',
    '  border-radius: 8px;',
    '  margin-bottom: 1.5rem;',
    '}',
    '.agent-header h1 {',
    '  margin: 0;',
    '  font-size: 1.25rem;',
    '  font-weight: 650;',
    '  color: #ffffff;',
    '  border: none;',
    '  padding: 0;',
    '}',
    '.agent-header .meta {',
    '  font-size: 0.8rem;',
    '  color: #e5e7eb;',
    '  margin-top: 0.35rem;',
    '  line-height: 1.4;',
    '}',
    'h1, h2, h3, h4 {',
    '  color: #111827;',
    '  margin: 1.4em 0 0.5em;',
    '  line-height: 1.3;',
    '  font-weight: 650;',
    '}',
    'h1 { font-size: 1.35rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.35em; }',
    'h2 { font-size: 1.15rem; border-bottom: 1px solid #f3f4f6; padding-bottom: 0.3em; }',
    'h3 { font-size: 1.05rem; }',
    'h4 { font-size: 1rem; }',
    'p { margin: 0.65em 0; color: #111827; }',
    'li { margin: 0.3em 0; color: #111827; }',
    'ul, ol { padding-left: 1.35em; margin: 0.65em 0; }',
    'a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 2px; }',
    'strong { font-weight: 650; color: #111827; }',
    'code {',
    '  background: #f3f4f6;',
    '  color: #111827;',
    '  padding: 0.12em 0.35em;',
    '  border-radius: 4px;',
    '  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;',
    '  font-size: 0.9em;',
    '}',
    'pre {',
    '  background: #f3f4f6;',
    '  color: #111827;',
    '  padding: 0.85rem 1rem;',
    '  border-radius: 8px;',
    '  overflow-x: auto;',
    '  border: 1px solid #e5e7eb;',
    '}',
    'pre code { padding: 0; background: transparent; color: inherit; }',
    'table {',
    '  border-collapse: collapse;',
    '  width: 100%;',
    '  margin: 1em 0;',
    '  font-size: 0.92rem;',
    '  color: #111827;',
    '}',
    'th, td {',
    '  border: 1px solid #e5e7eb;',
    '  padding: 0.5em 0.65em;',
    '  text-align: left;',
    '  vertical-align: top;',
    '  color: #111827;',
    '  background: #ffffff;',
    '}',
    'th { background: #f9fafb; font-weight: 650; }',
    'hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }',
    'blockquote {',
    '  margin: 1em 0;',
    '  padding: 0.5em 0 0.5em 1em;',
    '  border-left: 3px solid #d1d5db;',
    '  color: #374151;',
    '}',
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<meta name="color-scheme" content="light only">',
    '<meta name="supported-color-schemes" content="light">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>',
    styles,
    '</style>',
    '</head>',
    '<body>',
    '<div class="page">',
    '<div class="agent-header">',
    '  <h1>' + escapeHtml(agentName) + '</h1>',
    '  <div class="meta">' + escapeHtml(title) + ' &middot; ' + escapeHtml(ts) + '</div>',
    '</div>',
    bodyHtml,
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
