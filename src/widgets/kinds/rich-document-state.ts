/**
 * Pure validators for platform kind `rich-document`.
 * Mirror: web/src/widgets/kinds/rich-document-state.ts (keep in lockstep).
 */

export const RICH_DOCUMENT_FORMAT = 'utarus-rich-document-v1' as const;

export const RICH_DOCUMENT_COMMENTS_MAX = 50;
export const RICH_DOCUMENT_COMMENT_BODY_MAX = 2000;
export const RICH_DOCUMENT_COMMENT_QUOTE_MAX = 2000;

/**
 * Comment ids: any 8-4-4-4-12 hex UUID shape (not RFC version/variant bits).
 * Agents often mint random hex UUIDs that fail the strict v4 nibble checks.
 */
const COMMENT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RichDocumentCommentAuthor = 'agent' | 'user';

/** Annotation on the document — does not modify markdown. */
export interface RichDocumentComment {
  id: string;
  body: string;
  /** Optional plain-text anchor into the document (user quote / agent target). */
  quote?: string;
  author: RichDocumentCommentAuthor;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export interface RichDocumentStateV1 {
  format: typeof RICH_DOCUMENT_FORMAT;
  markdown: string;
  /** Optional review comments; omit or [] means no comments. */
  comments?: RichDocumentComment[];
}

export type RichDocumentProps = {
  mode?: 'edit' | 'view';
  placeholder?: string;
};

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateComment(
  raw: unknown,
  index: number,
): ValidateResult<RichDocumentComment> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `rich-document comments[${index}] must be a plain object` };
  }
  const allowed = new Set(['id', 'body', 'quote', 'author', 'createdAt']);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      return {
        ok: false,
        error: `rich-document comments[${index}] unknown field: ${k}`,
      };
    }
  }
  if (typeof raw.id !== 'string' || !COMMENT_ID_RE.test(raw.id)) {
    return {
      ok: false,
      error: `rich-document comments[${index}].id must be a UUID (8-4-4-4-12 hex, e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890)`,
    };
  }
  if (typeof raw.body !== 'string') {
    return {
      ok: false,
      error: `rich-document comments[${index}].body must be a string`,
    };
  }
  const body = raw.body.trim();
  if (!body) {
    return {
      ok: false,
      error: `rich-document comments[${index}].body must be non-empty`,
    };
  }
  if (body.length > RICH_DOCUMENT_COMMENT_BODY_MAX) {
    return {
      ok: false,
      error: `rich-document comments[${index}].body exceeds ${RICH_DOCUMENT_COMMENT_BODY_MAX} characters`,
    };
  }
  if (CONTROL_CHARS.test(body)) {
    return {
      ok: false,
      error: `rich-document comments[${index}].body contains control characters`,
    };
  }
  if (raw.author !== 'agent' && raw.author !== 'user') {
    return {
      ok: false,
      error: `rich-document comments[${index}].author must be 'agent' or 'user'`,
    };
  }
  if (typeof raw.createdAt !== 'string' || !raw.createdAt.trim()) {
    return {
      ok: false,
      error: `rich-document comments[${index}].createdAt must be a non-empty string`,
    };
  }
  if (CONTROL_CHARS.test(raw.createdAt)) {
    return {
      ok: false,
      error: `rich-document comments[${index}].createdAt contains control characters`,
    };
  }
  // Fail-fast if not parseable as a date (still store original string)
  if (Number.isNaN(Date.parse(raw.createdAt))) {
    return {
      ok: false,
      error: `rich-document comments[${index}].createdAt must be a valid ISO-8601 datetime`,
    };
  }

  let quote: string | undefined;
  if (raw.quote !== undefined) {
    if (typeof raw.quote !== 'string') {
      return {
        ok: false,
        error: `rich-document comments[${index}].quote must be a string when present`,
      };
    }
    const q = raw.quote.trim();
    if (!q) {
      return {
        ok: false,
        error: `rich-document comments[${index}].quote must be non-empty when present`,
      };
    }
    if (q.length > RICH_DOCUMENT_COMMENT_QUOTE_MAX) {
      return {
        ok: false,
        error: `rich-document comments[${index}].quote exceeds ${RICH_DOCUMENT_COMMENT_QUOTE_MAX} characters`,
      };
    }
    if (CONTROL_CHARS.test(q)) {
      return {
        ok: false,
        error: `rich-document comments[${index}].quote contains control characters`,
      };
    }
    quote = q;
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      body,
      author: raw.author,
      createdAt: raw.createdAt.trim(),
      ...(quote !== undefined ? { quote } : {}),
    },
  };
}

export function validateRichDocumentState(
  data: unknown,
): ValidateResult<RichDocumentStateV1> {
  if (!isPlainObject(data)) {
    return { ok: false, error: 'rich-document state must be a plain object' };
  }
  const o = data;
  const allowed = new Set(['format', 'markdown', 'comments']);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `rich-document state unknown field: ${k}` };
    }
  }
  if (o.format !== RICH_DOCUMENT_FORMAT) {
    return {
      ok: false,
      error: `rich-document state format must be ${RICH_DOCUMENT_FORMAT}, got ${String(o.format)}`,
    };
  }
  if (typeof o.markdown !== 'string') {
    return { ok: false, error: 'rich-document state.markdown must be a string' };
  }
  if (CONTROL_CHARS.test(o.markdown)) {
    return { ok: false, error: 'rich-document state.markdown contains control characters' };
  }

  let comments: RichDocumentComment[] | undefined;
  if (o.comments !== undefined) {
    if (!Array.isArray(o.comments)) {
      return { ok: false, error: 'rich-document state.comments must be an array when present' };
    }
    if (o.comments.length > RICH_DOCUMENT_COMMENTS_MAX) {
      return {
        ok: false,
        error: `rich-document state.comments exceeds max ${RICH_DOCUMENT_COMMENTS_MAX}`,
      };
    }
    const seen = new Set<string>();
    const parsed: RichDocumentComment[] = [];
    for (let i = 0; i < o.comments.length; i++) {
      const cr = validateComment(o.comments[i], i);
      if (!cr.ok) return cr;
      if (seen.has(cr.value.id)) {
        return {
          ok: false,
          error: `rich-document state.comments duplicate id: ${cr.value.id}`,
        };
      }
      seen.add(cr.value.id);
      parsed.push(cr.value);
    }
    // Empty array normalizes to omit (cleaner durable docs)
    if (parsed.length > 0) comments = parsed;
  }

  return {
    ok: true,
    value: {
      format: RICH_DOCUMENT_FORMAT,
      markdown: o.markdown,
      ...(comments !== undefined ? { comments } : {}),
    },
  };
}

export function validateRichDocumentProps(
  props: unknown,
): ValidateResult<RichDocumentProps> {
  if (!isPlainObject(props)) {
    return { ok: false, error: 'rich-document props must be a plain object' };
  }
  const o = props;
  const allowed = new Set(['mode', 'placeholder']);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) {
      if (
        k === 'markdown' ||
        k === 'content' ||
        k === 'html' ||
        k === 'format' ||
        k === 'comments'
      ) {
        return {
          ok: false,
          error: `rich-document props must not include '${k}' — put document body/comments in state`,
        };
      }
      return { ok: false, error: `rich-document props unknown field: ${k}` };
    }
  }
  if (o.mode !== undefined) {
    if (o.mode !== 'edit' && o.mode !== 'view') {
      return {
        ok: false,
        error: `rich-document props.mode must be 'edit' or 'view', got ${String(o.mode)}`,
      };
    }
  }
  if (o.placeholder !== undefined) {
    if (typeof o.placeholder !== 'string') {
      return { ok: false, error: 'rich-document props.placeholder must be a string' };
    }
    if (o.placeholder.length > 200) {
      return { ok: false, error: 'rich-document props.placeholder exceeds 200 characters' };
    }
    if (CONTROL_CHARS.test(o.placeholder)) {
      return { ok: false, error: 'rich-document props.placeholder contains control characters' };
    }
  }
  return {
    ok: true,
    value: {
      ...(o.mode !== undefined ? { mode: o.mode as 'edit' | 'view' } : {}),
      ...(typeof o.placeholder === 'string' ? { placeholder: o.placeholder } : {}),
    },
  };
}

/** External URL validation for open_external (host authoritative). */
export function validateExternalOpenUrl(
  url: unknown,
): ValidateResult<string> {
  if (typeof url !== 'string') {
    return { ok: false, error: 'open_external url must be a string' };
  }
  if (url.length > 2048) {
    return { ok: false, error: 'open_external url exceeds 2048 characters' };
  }
  if (/[\s\x00-\x1F\x7F]/.test(url)) {
    return { ok: false, error: 'open_external url contains whitespace or control characters' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'open_external url is not a valid absolute URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `open_external url scheme must be http or https, got ${parsed.protocol}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'open_external url must not include userinfo' };
  }
  return { ok: true, value: url };
}
