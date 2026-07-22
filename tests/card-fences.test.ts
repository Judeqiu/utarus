import { describe, it, expect } from 'vitest';
import {
  cardFenceKey,
  ensureCardFencesInText,
  fenceBodyFromCardToolResult,
  stripBrokenCardFences,
  validCardFenceBodiesInText,
} from '../src/webapp/chat/card-fences.js';

const DECK_A = [
  'version: 1',
  'layout: stack',
  'cards: [{"title":"Jude\'s Company — Books Created","fields":[{"label":"Framework","value":"MPERS"},{"label":"Currency","value":"MYR"}],"footer":"Double-entry ready","accent":"#1a56db","icon":"building"}]',
].join('\n');

const DECK_B = [
  'version: 1',
  'layout: stack',
  'cards: [{"title":"Other card","fields":[{"label":"A","value":"1"}]}]',
].join('\n');

describe('validCardFenceBodiesInText', () => {
  it('returns empty for prose without fences', () => {
    expect(validCardFenceBodiesInText('Your books are live.')).toEqual([]);
  });

  it('extracts a valid card fence body', () => {
    const text = `hello\n\n\`\`\`card\n${DECK_A}\n\`\`\`\n`;
    const bodies = validCardFenceBodiesInText(text);
    expect(bodies).toHaveLength(1);
    expect(cardFenceKey(bodies[0]!)).toBe(cardFenceKey(DECK_A));
  });

  it('ignores closed card fences that fail parse', () => {
    const text = '```card\nnot-valid\n```\n';
    expect(validCardFenceBodiesInText(text)).toEqual([]);
  });
});

describe('stripBrokenCardFences', () => {
  it('removes invalid closed card fences', () => {
    const text = `intro\n\n\`\`\`card\nbogus\n\`\`\`\n\noutro`;
    const out = stripBrokenCardFences(text);
    expect(out).not.toContain('```card');
    expect(out).toContain('intro');
    expect(out).toContain('outro');
  });

  it('keeps valid closed card fences', () => {
    const text = `note\n\n\`\`\`card\n${DECK_A}\n\`\`\`\n`;
    expect(stripBrokenCardFences(text)).toBe(text);
  });

  it('strips mid-line collapsed paste (screenshot regression)', () => {
    // Model glued ```card onto prose without a line break — not a CommonMark fence.
    const mangled =
      'Here\'s a summary:```card version: 1 layout: stack cards: [{"title":"Jude\'s Company — Books Created","fields":[{"label":"Framework","value":"MPERS"}]}]';
    const out = stripBrokenCardFences(mangled);
    expect(out).toContain("Here's a summary:");
    expect(out).not.toContain('```card');
    expect(out).not.toContain('Books Created');
  });

  it('strips line-start single-line collapsed fence', () => {
    const text =
      '```card version: 1 layout: stack cards: [{"title":"X"}]```\n\nNext steps';
    const out = stripBrokenCardFences(text);
    expect(out).not.toContain('```card');
    expect(out).toContain('Next steps');
  });
});

describe('ensureCardFencesInText', () => {
  it('appends missing fence when model forgot to paste', () => {
    const text = 'Your books are live.';
    const out = ensureCardFencesInText(text, [DECK_A]);
    expect(out).toContain('Your books are live.');
    expect(out).toContain('```card');
    expect(out).toContain('version: 1');
    expect(out).toContain('layout: stack');
    expect(out).toContain("Jude's Company");
  });

  it('does not duplicate when a matching fence is already present', () => {
    const text = `note\n\n\`\`\`card\n${DECK_A}\n\`\`\`\n`;
    const out = ensureCardFencesInText(text, [DECK_A]);
    expect(out).toBe(text);
    expect((out.match(/```card/g) ?? []).length).toBe(1);
  });

  it('injects only decks missing from text', () => {
    const text = `have one\n\n\`\`\`card\n${DECK_A}\n\`\`\`\n`;
    const out = ensureCardFencesInText(text, [DECK_A, DECK_B]);
    expect(out).toContain('Other card');
    expect((out.match(/```card/g) ?? []).length).toBe(2);
  });

  it('strips mangled paste and injects the tool fence (end-to-end regression)', () => {
    const mangled =
      'Let\'s get your company set up. Here\'s a summary:```card version: 1 layout: stack cards: [{"title":"Jude\'s Company — Books Created","fields":[{"label":"Framework","value":"MPERS"}]}]\n\n### What\'s next?\nPost opening balances.';
    const out = ensureCardFencesInText(mangled, [DECK_A]);
    expect(out).toContain("Let's get your company set up");
    expect(out).toContain("What's next?");
    // One valid multi-line fence only
    expect((out.match(/```card\n/g) ?? []).length).toBe(1);
    expect(out).toContain('version: 1\nlayout: stack\n');
    // Mid-line garbage gone
    expect(out).not.toMatch(/summary:```card/);
  });

  it('throws on invalid fence body (fail-fast)', () => {
    expect(() => ensureCardFencesInText('x', ['not-a-fence'])).toThrow(
      /invalid fence/,
    );
  });
});

describe('fenceBodyFromCardToolResult', () => {
  it('returns fence from tool details', () => {
    const body = fenceBodyFromCardToolResult('show_card', {
      content: [{ type: 'text', text: 'ok' }],
      details: { fence: DECK_A, cardCount: 1 },
    });
    expect(body).toBe(DECK_A);
  });

  it('throws when details.fence missing', () => {
    expect(() =>
      fenceBodyFromCardToolResult('show_card', {
        content: [],
        details: { cardCount: 1 },
      }),
    ).toThrow(/without details\.fence/);
  });
});
