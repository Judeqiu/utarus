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

describe('show_map tool', () => {
  it('fails when maps not enabled', async () => {
    const { createShowMapTool } = await import('../src/tools/show-map.js');
    const tool = createShowMapTool();
    const result = await tool.execute('1', { query: 'Paris' });
    expect(result.details).toBeNull();
    const text = result.content[0];
    expect(text.type).toBe('text');
    if (text.type === 'text') {
      expect(text.text).toMatch(/not enabled/i);
    }
  });

  it('returns link-first text and WEB ONLY fence', async () => {
    process.env.UTARUS_MAPS_ENABLED = 'true';
    process.env.GOOGLE_MAPS_EMBED_API_KEY = 'AIza-test';
    const { createShowMapTool } = await import('../src/tools/show-map.js');
    const tool = createShowMapTool();
    const result = await tool.execute('1', {
      query: 'TSMC HQ',
      label: 'TSMC',
      zoom: 14,
    });
    expect(result.details).not.toBeNull();
    const text = result.content[0];
    expect(text.type).toBe('text');
    if (text.type !== 'text') return;
    expect(text.text).toContain('[Map link — use on all channels]');
    expect(text.text).toContain('WEB ONLY');
    expect(text.text).toContain('```map');
    expect(text.text).toContain('mode: place');
    expect(text.text).toContain('query: TSMC HQ');
    expect(text.text).toContain('https://www.google.com/maps/search/');
    expect(text.text).not.toContain('AIza-test');
  });

  it('fails validation for incomplete coords', async () => {
    process.env.UTARUS_MAPS_ENABLED = 'true';
    process.env.GOOGLE_MAPS_EMBED_API_KEY = 'AIza-test';
    const { createShowMapTool } = await import('../src/tools/show-map.js');
    const tool = createShowMapTool();
    const result = await tool.execute('1', { lat: 1 });
    expect(result.details).toBeNull();
    const text = result.content[0];
    if (text.type === 'text') {
      expect(text.text).toMatch(/Invalid map/);
    }
  });
});
