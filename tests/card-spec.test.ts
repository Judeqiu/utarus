/**
 * card-spec pure grammar + summary fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCardFenceBody,
  validateCardDeckSpec,
  validateCardBodyMarkdown,
  toFence,
  toPlainSummary,
  CARD_ICON_ALLOWLIST,
  CARD_DECK_MAX_CARDS,
} from '../src/cards/card-spec.js';

const unit12 = {
  title: 'Unit 12B',
  subtitle: 'Riverfront Tower',
  badges: [{ label: 'Available', tone: 'success' as const }],
  fields: [
    { label: 'Price', value: '$1.2M' },
    { label: 'Area', value: '1,240 sqft' },
  ],
  accent: '#0ea5e9',
  icon: 'home' as const,
  footer: 'Updated today',
};

describe('validateCardBodyMarkdown', () => {
  it('accepts bold, italic, inline code, links', () => {
    const r = validateCardBodyMarkdown(
      'Lower risk, **stable** yield with *soft* note and `code` and [memo](https://example.com/m).',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts price < 100 and N<3', () => {
    expect(validateCardBodyMarkdown('price < 100').ok).toBe(true);
    expect(validateCardBodyMarkdown('N<3').ok).toBe(true);
    expect(validateCardBodyMarkdown('x <= y').ok).toBe(true);
  });

  it('rejects a<b and HTML tags', () => {
    expect(validateCardBodyMarkdown('a<b').ok).toBe(false);
    expect(validateCardBodyMarkdown('<b>x</b>').ok).toBe(false);
    expect(validateCardBodyMarkdown('<!-- -->').ok).toBe(false);
  });

  it('rejects headings lists images javascript links', () => {
    expect(validateCardBodyMarkdown('# Heading').ok).toBe(false);
    expect(validateCardBodyMarkdown('- item').ok).toBe(false);
    expect(validateCardBodyMarkdown('![x](https://x.com/a.png)').ok).toBe(false);
    expect(validateCardBodyMarkdown('[x](javascript:alert(1))').ok).toBe(false);
    expect(validateCardBodyMarkdown('```\ncode\n```').ok).toBe(false);
  });

  it('rejects empty body', () => {
    expect(validateCardBodyMarkdown('   ').ok).toBe(false);
  });
});

describe('validateCardDeckSpec', () => {
  it('accepts single card deck', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [{ title: 'Hello' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.cards).toHaveLength(1);
  });

  it('rejects empty cards', () => {
    const r = validateCardDeckSpec({ version: 1, layout: 'stack', cards: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects too many cards', () => {
    const cards = Array.from({ length: CARD_DECK_MAX_CARDS + 1 }, (_, i) => ({
      title: `C${i}`,
    }));
    const r = validateCardDeckSpec({ version: 1, layout: 'stack', cards });
    expect(r.ok).toBe(false);
  });

  it('rejects empty fields array', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [{ title: 'T', fields: [] }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown icon', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [{ title: 'T', icon: 'chart' }],
    });
    expect(r.ok).toBe(false);
  });

  it('accepts every allowlisted icon', () => {
    for (const icon of CARD_ICON_ALLOWLIST) {
      const r = validateCardDeckSpec({
        version: 1,
        layout: 'stack',
        cards: [{ title: 'T', icon }],
      });
      expect(r.ok).toBe(true);
    }
  });

  it('rejects bad accent', () => {
    expect(
      validateCardDeckSpec({
        version: 1,
        layout: 'stack',
        cards: [{ title: 'T', accent: '#ffff' }],
      }).ok,
    ).toBe(false);
    expect(
      validateCardDeckSpec({
        version: 1,
        layout: 'stack',
        cards: [{ title: 'T', accent: 'red' }],
      }).ok,
    ).toBe(false);
  });

  it('rejects unknown card keys', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [{ title: 'T', foo: 1 }],
    });
    expect(r.ok).toBe(false);
  });

  it('omitted badge tone stays absent', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [{ title: 'T', badges: [{ label: 'X' }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.cards[0]!.badges![0]!).toEqual({ label: 'X' });
      expect('tone' in r.spec.cards[0]!.badges![0]!).toBe(false);
    }
  });
});

describe('parseCardFenceBody', () => {
  it('parses tool-shaped fence', () => {
    const deck = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [unit12],
    });
    expect(deck.ok).toBe(true);
    if (!deck.ok) return;
    const body = toFence(deck.spec);
    const parsed = parseCardFenceBody(body);
    expect(parsed).toEqual(deck);
  });

  it('rejects fields after cards', () => {
    const r = parseCardFenceBody(
      'version: 1\nlayout: stack\ncards: [{"title":"A"}]\nlayout: stack',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fields after cards/);
  });

  it('rejects multi-line cards value continuation', () => {
    const r = parseCardFenceBody(
      'version: 1\nlayout: stack\ncards: [{"title":"A"}\n,{"title":"B"}]',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const r = parseCardFenceBody(
      'version: 1\nversion: 1\nlayout: stack\ncards: [{"title":"A"}]',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects unknown fence keys', () => {
    const r = parseCardFenceBody(
      'version: 1\nlayout: stack\nfoo: bar\ncards: [{"title":"A"}]',
    );
    expect(r.ok).toBe(false);
  });
});

describe('toPlainSummary', () => {
  it('matches golden two-card shape', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [
        {
          title: 'Unit 12B',
          subtitle: 'Riverfront Tower',
          fields: [
            { label: 'Price', value: '$1.2M' },
            { label: 'Area', value: '1,240 sqft' },
          ],
          badges: [{ label: 'Available', tone: 'success' }],
        },
        {
          title: 'Unit 8A',
          subtitle: 'Riverfront Tower',
          fields: [{ label: 'Price', value: '$980K' }],
          badges: [{ label: 'Waitlist' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(toPlainSummary(r.spec)).toBe(
      [
        '1. Unit 12B — Riverfront Tower',
        '  Price: $1.2M',
        '  Area: 1,240 sqft',
        '  [Available]',
        '',
        '2. Unit 8A — Riverfront Tower',
        '  Price: $980K',
        '  [Waitlist]',
      ].join('\n'),
    );
  });

  it('strips body markdown in summary', () => {
    const r = validateCardDeckSpec({
      version: 1,
      layout: 'stack',
      cards: [
        {
          title: 'Option A',
          body: 'Lower risk, **stable** yield. See [memo](https://example.com/m).',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(toPlainSummary(r.spec)).toBe(
      '1. Option A\n  Lower risk, stable yield. See memo.',
    );
  });
});
