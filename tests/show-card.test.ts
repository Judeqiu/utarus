/**
 * show_card tool execute paths.
 */
import { describe, it, expect } from 'vitest';
import { createShowCardTool } from '../src/tools/show-card.js';

describe('createShowCardTool', () => {
  const tool = createShowCardTool();

  it('emits summary + WEB ONLY fence for single title', async () => {
    const result = await tool.execute('1', { title: 'Hello', subtitle: 'World' });
    const text = result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('[Cards — use on all channels]');
    expect(text).toContain('1. Hello — World');
    expect(text).toContain('```card');
    expect(text).toContain('version: 1');
    expect(text).toContain('layout: stack');
    expect(result.details).toMatchObject({ cardCount: 1 });
  });

  it('accepts cards array', async () => {
    const result = await tool.execute('1', {
      cards: [{ title: 'A' }, { title: 'B', body: '**ok**' }],
    });
    const text = result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toContain('1. A');
    expect(text).toContain('2. B');
    expect(result.details).toMatchObject({ cardCount: 2 });
  });

  it('fails when both cards and title provided', async () => {
    const result = await tool.execute('1', {
      cards: [{ title: 'A' }],
      title: 'B',
    });
    const text = result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/not both/);
    expect(result.details).toBeNull();
  });

  it('fails without cards or title', async () => {
    const result = await tool.execute('1', {});
    const text = result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/cards or title is required/);
  });

  it('fails invalid body HTML', async () => {
    const result = await tool.execute('1', { title: 'T', body: '<b>x</b>' });
    const text = result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text).toMatch(/Invalid card/);
  });
});
