/**
 * Persist WebUI chat photo attachments under data/chats/<slug>/attachments/.
 *
 * Uploads arrive as base64-in-JSON (the codebase deliberately avoids
 * multipart middleware; the SPA downscales photos before upload). Validation
 * is hard fail: mime allowlist + magic-byte sniff + size cap — the client
 * supplied mimeType is never trusted on its own. Writes are atomic
 * (temp file + rename), matching conversation-store.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { resolveDataRoot } from '../../config.js';

/** Max decoded bytes per attachment. The SPA downscales before upload. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Max attachments per chat message. */
export const ATTACHMENTS_PER_MESSAGE_MAX = 4;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface MimeSpec {
  ext: string;
  sniff: (b: Buffer) => boolean;
}

const ALLOWED: Record<string, MimeSpec> = {
  'image/jpeg': {
    ext: 'jpg',
    sniff: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/png': {
    ext: 'png',
    sniff: b => b.length > 4 && b.readUInt32BE(0) === 0x89504e47,
  },
  'image/webp': {
    ext: 'webp',
    sniff: b =>
      b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  },
  'image/gif': {
    ext: 'gif',
    sniff: b => {
      const h = b.toString('ascii', 0, 6);
      return b.length > 6 && (h === 'GIF87a' || h === 'GIF89a');
    },
  },
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(ALLOWED).map(([mime, spec]) => [spec.ext, mime]),
);

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface AttachmentFile {
  id: string;
  mimeType: string;
  bytes: Buffer;
}

function attachmentsDir(slug: string): string {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid chat slug: ${JSON.stringify(slug)}`);
  }
  return join(resolveDataRoot(), 'chats', slug, 'attachments');
}

function attachmentPath(slug: string, id: string): { path: string; mimeType: string } {
  if (!ID_RE.test(id)) {
    throw new Error(`Invalid attachment id: ${JSON.stringify(id)}`);
  }
  const dir = attachmentsDir(slug);
  const ext = (() => {
    if (!existsSync(dir)) throw new Error(`Attachment not found: ${id}`);
    for (const e of Object.keys(EXT_TO_MIME)) {
      if (existsSync(join(dir, `${id}.${e}`))) return e;
    }
    throw new Error(`Attachment not found: ${id}`);
  })();
  return { path: join(dir, `${id}.${ext}`), mimeType: EXT_TO_MIME[ext] };
}

function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') return 'photo';
  const base = name.split(/[\\/]/).pop() ?? '';
  const trimmed = base.trim().slice(0, 120);
  return trimmed.length > 0 ? trimmed : 'photo';
}

/** Display-name sanitiser shared by the upload route and message persistence. */
export const sanitizeAttachmentName = sanitizeName;

/**
 * Validate and store an uploaded photo. Throws with a precise message on
 * unsupported type, content/type mismatch, or oversize — no silent fixes.
 */
export function saveAttachment(
  slug: string,
  input: { name?: unknown; mimeType?: unknown; data?: unknown },
): AttachmentRef {
  const mimeType = input.mimeType;
  if (typeof mimeType !== 'string' || !ALLOWED[mimeType]) {
    throw new Error(
      `Unsupported attachment type ${JSON.stringify(mimeType)}. ` +
        `Allowed: ${Object.keys(ALLOWED).join(', ')}.`,
    );
  }
  if (typeof input.data !== 'string' || input.data.length === 0) {
    throw new Error('Attachment data must be a non-empty base64 string.');
  }
  const spec = ALLOWED[mimeType];
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length === 0) {
    throw new Error('Attachment data is not valid base64.');
  }
  if (bytes.length > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `Attachment too large: ${(bytes.length / 1024 / 1024).toFixed(1)} MB ` +
        `(max ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB).`,
    );
  }
  if (!spec.sniff(bytes)) {
    throw new Error(`Attachment content is not a valid ${mimeType} image.`);
  }

  const id = randomUUID();
  const dir = attachmentsDir(slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = join(dir, `${id}.${spec.ext}`);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path);

  return { id, name: sanitizeName(input.name), mimeType, size: bytes.length };
}

/** Load an attachment for serving or for building an agent image part. */
export function loadAttachment(slug: string, id: string): AttachmentFile {
  const { path, mimeType } = attachmentPath(slug, id);
  return { id, mimeType, bytes: readFileSync(path) };
}

/** Delete attachments by id; missing files are ignored. */
export function deleteAttachments(slug: string, ids: string[]): void {
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    try {
      const { path } = attachmentPath(slug, id);
      unlinkSync(path);
    } catch {
      // Already gone — deletion is best-effort.
    }
  }
}
