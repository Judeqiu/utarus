import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const savedEnabled = process.env.UTARUS_MAPS_ENABLED;
const savedKey = process.env.GOOGLE_MAPS_EMBED_API_KEY;

beforeEach(() => {
  delete process.env.UTARUS_MAPS_ENABLED;
  delete process.env.GOOGLE_MAPS_EMBED_API_KEY;
});

afterEach(() => {
  if (savedEnabled === undefined) delete process.env.UTARUS_MAPS_ENABLED;
  else process.env.UTARUS_MAPS_ENABLED = savedEnabled;
  if (savedKey === undefined) delete process.env.GOOGLE_MAPS_EMBED_API_KEY;
  else process.env.GOOGLE_MAPS_EMBED_API_KEY = savedKey;
});

describe('maps config', () => {
  it('disabled when flag unset', async () => {
    const { isMapsEnabled, resolveMapsHttpConfig } = await import('../src/maps/config.js');
    process.env.GOOGLE_MAPS_EMBED_API_KEY = 'AIza-test';
    expect(isMapsEnabled()).toBe(false);
    expect(resolveMapsHttpConfig()).toEqual({ kind: 'disabled' });
  });

  it('disabled when flag not exactly true', async () => {
    const { isMapsEnabled, resolveMapsHttpConfig } = await import('../src/maps/config.js');
    process.env.UTARUS_MAPS_ENABLED = '1';
    process.env.GOOGLE_MAPS_EMBED_API_KEY = 'AIza-test';
    expect(isMapsEnabled()).toBe(false);
    expect(resolveMapsHttpConfig()).toEqual({ kind: 'disabled' });
  });

  it('misconfigured when flag true and key empty', async () => {
    const { isMapsEnabled, resolveMapsHttpConfig, getEmbedApiKeyOrThrow } = await import(
      '../src/maps/config.js'
    );
    process.env.UTARUS_MAPS_ENABLED = 'true';
    process.env.GOOGLE_MAPS_EMBED_API_KEY = '   ';
    expect(isMapsEnabled()).toBe(false);
    const r = resolveMapsHttpConfig();
    expect(r.kind).toBe('misconfigured');
    expect(() => getEmbedApiKeyOrThrow()).toThrow(/misconfigured|empty/i);
  });

  it('ok when flag true and key set', async () => {
    const { isMapsEnabled, resolveMapsHttpConfig, getEmbedApiKeyOrThrow } = await import(
      '../src/maps/config.js'
    );
    process.env.UTARUS_MAPS_ENABLED = 'true';
    process.env.GOOGLE_MAPS_EMBED_API_KEY = '  AIza-ok  ';
    expect(isMapsEnabled()).toBe(true);
    expect(resolveMapsHttpConfig()).toEqual({ kind: 'ok', embedApiKey: 'AIza-ok' });
    expect(getEmbedApiKeyOrThrow()).toBe('AIza-ok');
  });
});
