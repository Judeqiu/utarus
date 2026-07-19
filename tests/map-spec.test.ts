import { describe, it, expect } from 'vitest';
import {
  parseMapFenceBody,
  validateMapSpec,
  toFence,
  toOpenUrl,
  buildGoogleEmbedUrl,
  isAllowedMapEmbedUrl,
} from '../src/maps/map-spec.js';

const KEY = 'test-embed-key';

describe('parseMapFenceBody / validateMapSpec', () => {
  it('parses place fence with mode', () => {
    const r = parseMapFenceBody(
      'mode: place\nquery: TSMC HQ Hsinchu\nzoom: 14\nlabel: TSMC',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec).toEqual({
      mode: 'place',
      query: 'TSMC HQ Hsinchu',
      zoom: 14,
      label: 'TSMC',
    });
  });

  it('omitted mode with query resolves to place', () => {
    const r = parseMapFenceBody('query: Cupertino, CA');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toBe('place');
    expect(r.spec.query).toBe('Cupertino, CA');
  });

  it('omitted mode with lat+lng resolves to view', () => {
    const r = parseMapFenceBody('lat: 24.77\nlng: 120.99\nzoom: 12');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toBe('view');
    expect(r.spec.lat).toBe(24.77);
    expect(r.spec.lng).toBe(120.99);
    expect(r.spec.zoom).toBe(12);
  });

  it('rejects mode place without query', () => {
    const r = validateMapSpec({ mode: 'place', lat: 1, lng: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/query/);
  });

  it('rejects mode view without coords', () => {
    const r = validateMapSpec({ mode: 'view', query: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/lat/);
  });

  it('rejects incomplete coords', () => {
    const r = parseMapFenceBody('lat: 1');
    expect(r.ok).toBe(false);
  });

  it('rejects unknown keys', () => {
    const r = parseMapFenceBody('query: a\nfoo: bar');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/unknown/);
  });

  it('rejects duplicate keys', () => {
    const r = parseMapFenceBody('query: a\nquery: b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/duplicate/);
  });

  it('rejects zoom out of range', () => {
    expect(validateMapSpec({ query: 'x', zoom: 22 }).ok).toBe(false);
    expect(validateMapSpec({ query: 'x', zoom: -1 }).ok).toBe(false);
  });

  it('accepts zoom 0 and 21', () => {
    expect(validateMapSpec({ query: 'x', zoom: 0 }).ok).toBe(true);
    expect(validateMapSpec({ query: 'x', zoom: 21 }).ok).toBe(true);
  });

  it('rejects https query scheme; allows place_id:', () => {
    expect(validateMapSpec({ query: 'https://evil.example' }).ok).toBe(false);
    const ok = validateMapSpec({ query: 'place_id:ChIJxxx' });
    expect(ok.ok).toBe(true);
  });

  it('rejects string zoom (no coercion from tool path objects)', () => {
    // fence path coerces integer strings; object path used by tool does not
    expect(validateMapSpec({ query: 'x', zoom: '14' as unknown as number }).ok).toBe(false);
  });

  it('tool-like object without mode still works', () => {
    const r = validateMapSpec({ query: 'Paris, France' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.mode).toBe('place');
  });
});

describe('toFence / toOpenUrl / buildGoogleEmbedUrl', () => {
  it('toFence always includes mode', () => {
    const fence = toFence({ mode: 'place', query: 'A' });
    expect(fence).toBe('mode: place\nquery: A');
  });

  it('toOpenUrl uses search API', () => {
    expect(toOpenUrl({ mode: 'place', query: 'A B' })).toBe(
      'https://www.google.com/maps/search/?api=1&query=A%20B',
    );
    expect(toOpenUrl({ mode: 'view', lat: 1.5, lng: 2.5 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=1.5%2C2.5',
    );
  });

  it('buildGoogleEmbedUrl place and view', () => {
    const place = buildGoogleEmbedUrl({ mode: 'place', query: 'HQ', zoom: 14 }, KEY);
    expect(place.startsWith('https://www.google.com/maps/embed/v1/place?')).toBe(true);
    expect(place).toContain('key=test-embed-key');
    expect(place).toContain('q=HQ');
    expect(place).toContain('zoom=14');
    expect(isAllowedMapEmbedUrl(place)).toBe(true);

    const view = buildGoogleEmbedUrl({ mode: 'view', lat: 1, lng: 2 }, KEY);
    expect(view).toContain('/maps/embed/v1/view?');
    expect(view).toContain('center=1%2C2');
    expect(view).not.toContain('zoom=');
    expect(isAllowedMapEmbedUrl(view)).toBe(true);
  });

  it('buildGoogleEmbedUrl fails on empty key', () => {
    expect(() =>
      buildGoogleEmbedUrl({ mode: 'place', query: 'x' }, '  '),
    ).toThrow(/empty/);
  });

  it('isAllowedMapEmbedUrl rejects bad hosts', () => {
    expect(isAllowedMapEmbedUrl('https://evil.com/maps/embed/v1/place?key=x')).toBe(false);
    expect(isAllowedMapEmbedUrl('https://maps.google.com/maps/embed/v1/place?key=x')).toBe(
      false,
    );
    expect(isAllowedMapEmbedUrl('https://www.google.com/maps/embed/v1/directions?key=x')).toBe(
      false,
    );
  });
});
