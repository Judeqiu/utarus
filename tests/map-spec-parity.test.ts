/**
 * Dual map-spec copies (server + web) must stay in lockstep.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import * as server from '../src/maps/map-spec.js';
import * as web from '../web/src/maps/map-spec.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURES: Array<{ name: string; body?: string; input?: unknown }> = [
  { name: 'place full', body: 'mode: place\nquery: HQ\nzoom: 14\nlabel: L' },
  { name: 'query omit mode', body: 'query: Cupertino' },
  { name: 'view coords', body: 'lat: 1.5\nlng: -2.5\nzoom: 0' },
  { name: 'bad zoom', body: 'query: x\nzoom: 22' },
  { name: 'https query', body: 'query: https://x.com' },
  { name: 'place_id', body: 'query: place_id:ChIJ' },
  { name: 'dup', body: 'query: a\nquery: b' },
  { name: 'unknown', body: 'query: a\nfoo: 1' },
  { name: 'lat only', body: 'lat: 1' },
  { name: 'view mode object', input: { mode: 'view', lat: 10, lng: 20 } },
  { name: 'place mode object', input: { mode: 'place', query: 'A' } },
  { name: 'empty', body: '' },
];

describe('map-spec parity server vs web', () => {
  it('export key sets match', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(web).sort());
  });

  it('source files are byte-identical (ignore trailing newline drift only)', () => {
    const a = readFileSync(join(root, 'src/maps/map-spec.ts'), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(join(root, 'web/src/maps/map-spec.ts'), 'utf8').replace(/\r\n/g, '\n');
    // Header comment differs (mirror path). Strip first 4 lines for comparison.
    const stripHeader = (s: string) => s.split('\n').slice(4).join('\n');
    expect(stripHeader(a)).toBe(stripHeader(b));
  });

  for (const f of FIXTURES) {
    it(`fixture: ${f.name}`, () => {
      const sr =
        f.body !== undefined
          ? server.parseMapFenceBody(f.body)
          : server.validateMapSpec(f.input);
      const wr =
        f.body !== undefined ? web.parseMapFenceBody(f.body) : web.validateMapSpec(f.input);
      expect(wr).toEqual(sr);
      if (sr.ok) {
        expect(web.toFence(wr.ok ? wr.spec : sr.spec)).toBe(server.toFence(sr.spec));
        expect(web.toOpenUrl(sr.spec)).toBe(server.toOpenUrl(sr.spec));
        const key = 'parity-key';
        expect(web.buildGoogleEmbedUrl(sr.spec, key)).toBe(
          server.buildGoogleEmbedUrl(sr.spec, key),
        );
      }
    });
  }
});
