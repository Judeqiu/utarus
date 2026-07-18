import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  saveAttachment,
  loadAttachment,
  deleteAttachments,
  ATTACHMENT_MAX_BYTES,
} from '../src/webapp/chat/attachments.js';

// 1x1 red pixel PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_BYTES = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'binary');
const GIF_BYTES = Buffer.from('GIF89a\x01\x00\x01\x00', 'binary');

let tmp: string;
let prevDataRoot: string | undefined;

beforeEach(() => {
  prevDataRoot = process.env.UTARUS_DATA_ROOT;
  tmp = mkdtempSync(join(tmpdir(), 'utarus-attach-test-'));
  process.env.UTARUS_DATA_ROOT = tmp;
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.UTARUS_DATA_ROOT;
  else process.env.UTARUS_DATA_ROOT = prevDataRoot;
  rmSync(tmp, { recursive: true, force: true });
});

function dirFor(slug: string): string {
  return join(tmp, 'chats', slug, 'attachments');
}

describe('saveAttachment', () => {
  it('stores a valid image and returns a ref; loadAttachment round-trips the bytes', () => {
    const ref = saveAttachment('jude-qiu', {
      name: 'essay-page1.png',
      mimeType: 'image/png',
      data: PNG_B64,
    });
    expect(ref.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ref.name).toBe('essay-page1.png');
    expect(ref.mimeType).toBe('image/png');
    expect(ref.size).toBe(Buffer.from(PNG_B64, 'base64').length);
    expect(readdirSync(dirFor('jude-qiu'))).toEqual([`${ref.id}.png`]);

    const loaded = loadAttachment('jude-qiu', ref.id);
    expect(loaded.mimeType).toBe('image/png');
    expect(loaded.bytes.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true);
  });

  it.each([
    ['image/jpeg', JPEG_BYTES, 'jpg'],
    ['image/webp', WEBP_BYTES, 'webp'],
    ['image/gif', GIF_BYTES, 'gif'],
  ] as const)('accepts %s with matching magic bytes', (mime, bytes, ext) => {
    const ref = saveAttachment('jude-qiu', { name: 'p', mimeType: mime, data: bytes.toString('base64') });
    expect(ref.mimeType).toBe(mime);
    expect(readdirSync(dirFor('jude-qiu'))).toEqual([`${ref.id}.${ext}`]);
  });

  it('rejects an unsupported mime type naming the allowlist', () => {
    expect(() =>
      saveAttachment('jude-qiu', { name: 'x.svg', mimeType: 'image/svg+xml', data: PNG_B64 }),
    ).toThrow(/Unsupported attachment type.*image\/jpeg, image\/png, image\/webp, image\/gif/);
  });

  it('rejects content that does not match the declared mime type', () => {
    expect(() =>
      saveAttachment('jude-qiu', { name: 'fake.jpg', mimeType: 'image/jpeg', data: PNG_B64 }),
    ).toThrow(/not a valid image\/jpeg/);
  });

  it('rejects oversized attachments with the size in the message', () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0);
    expect(() =>
      saveAttachment('jude-qiu', { name: 'big.jpg', mimeType: 'image/jpeg', data: big.toString('base64') }),
    ).toThrow(/too large.*5 MB/);
  });

  it('rejects empty and missing data', () => {
    expect(() => saveAttachment('jude-qiu', { name: 'x', mimeType: 'image/png', data: '' })).toThrow(
      /non-empty base64/,
    );
    expect(() => saveAttachment('jude-qiu', { name: 'x', mimeType: 'image/png' })).toThrow(
      /non-empty base64/,
    );
  });

  it('rejects invalid slugs', () => {
    for (const slug of ['', '../etc', 'UPPER', 'a/b']) {
      expect(() =>
        saveAttachment(slug, { name: 'x', mimeType: 'image/png', data: PNG_B64 }),
      ).toThrow(/Invalid chat slug/);
    }
  });

  it('sanitises the display name', () => {
    const ref = saveAttachment('jude-qiu', {
      name: '../../etc/passwd',
      mimeType: 'image/png',
      data: PNG_B64,
    });
    expect(ref.name).toBe('passwd');
    const unnamed = saveAttachment('jude-qiu', { mimeType: 'image/png', data: PNG_B64 });
    expect(unnamed.name).toBe('photo');
  });
});

describe('loadAttachment', () => {
  it('rejects a malformed id (path traversal safe)', () => {
    expect(() => loadAttachment('jude-qiu', '../../index')).toThrow(/Invalid attachment id/);
  });

  it('throws a clear error for a missing attachment', () => {
    expect(() => loadAttachment('jude-qiu', '123e4567-e89b-42d3-a456-426614174000')).toThrow(
      /Attachment not found/,
    );
  });
});

describe('deleteAttachments', () => {
  it('deletes existing files and ignores missing or malformed ids', () => {
    const ref = saveAttachment('jude-qiu', { name: 'x', mimeType: 'image/png', data: PNG_B64 });
    expect(existsSync(join(dirFor('jude-qiu'), `${ref.id}.png`))).toBe(true);
    deleteAttachments('jude-qiu', [ref.id, 'not-an-id', '123e4567-e89b-42d3-a456-426614174000']);
    expect(existsSync(join(dirFor('jude-qiu'), `${ref.id}.png`))).toBe(false);
  });
});
