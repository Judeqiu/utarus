/**
 * Normalize common LaTeX math delimiters to forms that remark-math understands
 * with `singleDollarTextMath: false` (only `$$…$$`).
 *
 * Why: LLMs and math tutors default to `\[…\]` / `\(…\)` (standard LaTeX).
 * CommonMark treats `\[` as a literal `[`, so equations show as raw TeX.
 * Currency agents still need bare `$1.2M` to stay text — single `$` is never
 * enabled here.
 *
 * Converts (outside fenced / inline code only):
 *   \[ … \]  →  $$\n…\n$$   (display)
 *   \( … \)  →  $$…$$       (inline; same-line $$ is inline under remark-math)
 *
 * Display-math indentation matters: when `\[…\]` sits inside a container
 * (list item, blockquote), the closing `$$` fence must carry the same line
 * prefix. A closing fence emitted at column 0 breaks out of the container,
 * becomes a NEW math opener, and shifts `$$` pairing for the rest of the
 * message — every later paragraph renders as raw red KaTeX-error text.
 * A `\[…\]` that starts mid-line cannot be block math at all; it degrades
 * to same-line `$$…$$` (inline) instead of a broken block.
 *
 * Incomplete pairs (streaming) are left unchanged.
 */

export function normalizeMathDelimiters(md: string): string {
  if (!md.includes('\\[') && !md.includes('\\(')) {
    return md;
  }

  const segments = splitPreservingCode(md);
  let out = '';
  for (const seg of segments) {
    out += seg.kind === 'code' ? seg.value : transformMathInText(seg.value);
  }
  return out;
}

type Segment = { kind: 'code' | 'text'; value: string };

/** True when index is at the start of the string or immediately after `\n`. */
function isLineStart(s: string, i: number): boolean {
  return i === 0 || s[i - 1] === '\n';
}

/**
 * Split markdown into code vs text segments so math rewrite cannot touch
 * fenced blocks or inline code (where `\[` may appear as examples).
 */
function splitPreservingCode(md: string): Segment[] {
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
    // Fenced code: ``` or ~~~ at line start (GFM).
    if (isLineStart(md, i) && (md.startsWith('```', i) || md.startsWith('~~~', i))) {
      flushText();
      const fenceChar = md[i]!;
      let openLen = 0;
      while (i + openLen < md.length && md[i + openLen] === fenceChar) {
        openLen++;
      }
      // Consume opening fence line through newline (or EOS).
      let j = i + openLen;
      while (j < md.length && md[j] !== '\n') j++;
      if (j < md.length && md[j] === '\n') j++;

      // Find closing fence of at least openLen same chars on its own line.
      let closed = false;
      while (j < md.length) {
        if (isLineStart(md, j)) {
          let k = 0;
          while (j + k < md.length && md[j + k] === fenceChar) k++;
          if (k >= openLen) {
            let end = j + k;
            while (end < md.length && md[end] !== '\n' && /\s/.test(md[end]!)) {
              end++;
            }
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
        // Unclosed fence (streaming): protect rest as code so we do not rewrite.
        segs.push({ kind: 'code', value: md.slice(i) });
        return segs;
      }
      continue;
    }

    // Inline code: one or more backticks (CommonMark codespan).
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

function transformMathInText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('\\[', i)) {
      const end = indexOfUnescapedClose(text, i + 2, '\\]');
      if (end === -1) {
        out += text.slice(i);
        break;
      }
      const body = text.slice(i + 2, end);
      out += wrapDisplay(body, linePrefixOf(out));
      i = end + 2;
      continue;
    }
    if (text.startsWith('\\(', i)) {
      const end = indexOfUnescapedClose(text, i + 2, '\\)');
      if (end === -1) {
        out += text.slice(i);
        break;
      }
      const body = text.slice(i + 2, end);
      out += wrapInline(body);
      i = end + 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Find `\\]` or `\\)` that is not preceded by an odd extra backslash run. */
function indexOfUnescapedClose(s: string, from: number, close: '\\]' | '\\)'): number {
  let i = from;
  while (i < s.length) {
    const at = s.indexOf(close, i);
    if (at === -1) return -1;
    // Count consecutive backslashes immediately before the close marker's `\`.
    // close is two chars: `\` + `]`/`)`. We want the LaTeX closer `\]`, not `\\]`.
    let bs = 0;
    let k = at - 1;
    while (k >= from && s[k] === '\\') {
      bs++;
      k--;
    }
    // `at` points at `\`. If there is an even number of extra `\` before that
    // delimiter backslash (bs===0,2,4…), the delimiter is active.
    // Example: `\]` → bs=0 active; `\\]` → one `\` before `\]`'s `\` → bs=1, escaped.
    // Wait: for `\]`, at is index of `\`, chars before are not `\`, bs=0 → active. Good.
    // For `\\]`, the string is `\` `\` `]`. indexOf `\]` finds the second `\` + `]`,
    // bs counts first `\` → bs=1 → escaped. Good.
    if (bs % 2 === 0) return at;
    i = at + 1;
  }
  return -1;
}

/**
 * Line prefix (indent / blockquote markers) already emitted for the line the
 * `\[…\]` opener sits on. Only whitespace and `>` count — anything else means
 * the opener is mid-line and cannot start block math.
 */
function linePrefixOf(emitted: string): string | null {
  const lineStart = emitted.lastIndexOf('\n') + 1;
  const prefix = emitted.slice(lineStart);
  return /^[ \t>]*$/.test(prefix) ? prefix : null;
}

function wrapDisplay(body: string, linePrefix: string | null): string {
  if (linePrefix === null) {
    // Mid-line \[…\]: block math is impossible here. Degrade to same-line
    // inline $$…$$ so no stray block fence can corrupt later $$ pairing.
    return `$$${body.trim().replace(/\s+/g, ' ')}$$`;
  }
  // Strip trailing whitespace-only lines (and a lone trailing blockquote
  // marker) so the closing fence is not pushed onto an over-indented line;
  // keep content-line indentation intact.
  const trimmed = body
    .replace(/^\n+/, '')
    .replace(/[ \t\n]+$/, '')
    .replace(/\n[ \t>]*$/, '');
  // The opener `$$` follows the already-emitted prefix; the closing fence
  // must repeat it to stay inside the same list/blockquote container.
  return `$$\n${trimmed}\n${linePrefix}$$`;
}

function wrapInline(body: string): string {
  return `$$${body.trim()}$$`;
}
