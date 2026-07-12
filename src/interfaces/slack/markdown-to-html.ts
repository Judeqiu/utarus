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

export function wrapHtmlReport(title: string, bodyHtml: string, generatedAt: Date = new Date()): string {
  const ts = generatedAt.toLocaleString();
  const agentName = config.agent.name ?? 'Agent';
  const styles = [
    ':root {',
    '  --fg: #1a1a1a;',
    '  --fg-muted: #57606a;',
    '  --border: #d0d7de;',
    '  --bg-soft: #f6f8fa;',
    '  --accent: #0969da;',
    '  --header-from: #667eea;',
    '  --header-to: #764ba2;',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    '    --fg: #e6edf3;',
    '    --fg-muted: #8b949e;',
    '    --border: #30363d;',
    '    --bg-soft: #161b22;',
    '    --accent: #58a6ff;',
    '  }',
    '}',
    '* { box-sizing: border-box; }',
    'body {',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;',
    '  max-width: 820px;',
    '  margin: 2rem auto;',
    '  padding: 0 1.25rem;',
    '  color: var(--fg);',
    '  line-height: 1.6;',
    '}',
    '.agent-header {',
    '  background: linear-gradient(135deg, var(--header-from) 0%, var(--header-to) 100%);',
    '  color: white;',
    '  padding: 1.5rem 1.75rem;',
    '  border-radius: 10px;',
    '  margin-bottom: 1.75rem;',
    '}',
    '.agent-header h1 { margin: 0; font-size: 1.4rem; color: white; border: none; padding: 0; }',
    '.agent-header .meta { font-size: 0.85rem; opacity: 0.85; margin-top: 0.35rem; }',
    'h1, h2, h3, h4 { color: var(--fg); margin-top: 1.6em; margin-bottom: 0.6em; line-height: 1.25; }',
    'h1 { font-size: 1.5rem; border-bottom: 2px solid var(--border); padding-bottom: 0.3em; }',
    'h2 { font-size: 1.3rem; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }',
    'h3 { font-size: 1.15rem; }',
    'h4 { font-size: 1rem; }',
    'p { margin: 0.75em 0; }',
    'code {',
    '  background: var(--bg-soft);',
    '  padding: 0.15em 0.4em;',
    '  border-radius: 4px;',
    '  font-family: "SF Mono", ui-monospace, Consolas, "Liberation Mono", monospace;',
    '  font-size: 0.88em;',
    '}',
    'pre {',
    '  background: var(--bg-soft);',
    '  padding: 1rem;',
    '  border-radius: 8px;',
    '  overflow-x: auto;',
    '  border: 1px solid var(--border);',
    '}',
    'pre code { padding: 0; background: none; font-size: 0.85rem; }',
    'table {',
    '  border-collapse: collapse;',
    '  width: 100%;',
    '  margin: 1em 0;',
    '  font-size: 0.92rem;',
    '}',
    'th, td {',
    '  border: 1px solid var(--border);',
    '  padding: 0.5em 0.75em;',
    '  text-align: left;',
    '  vertical-align: top;',
    '}',
    'th { background: var(--bg-soft); font-weight: 600; }',
    'hr { border: none; border-top: 1px solid var(--border); margin: 1.75em 0; }',
    'a { color: var(--accent); text-decoration: none; }',
    'a:hover { text-decoration: underline; }',
    'ul, ol { padding-left: 1.5em; }',
    'li { margin: 0.25em 0; }',
    'blockquote {',
    '  margin: 1em 0;',
    '  padding: 0.5em 1em;',
    '  border-left: 3px solid var(--border);',
    '  color: var(--fg-muted);',
    '}',
    'strong { font-weight: 600; }',
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>',
    styles,
    '</style>',
    '</head>',
    '<body>',
    '<div class="agent-header">',
    '  <h1>' + escapeHtml(agentName) + '</h1>',
    '  <div class="meta">' + escapeHtml(title) + ' &middot; ' + escapeHtml(ts) + '</div>',
    '</div>',
    bodyHtml,
    '</body>',
    '</html>',
  ].join('\n');
}
