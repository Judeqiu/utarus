/**
 * Dual card-spec copies (server + web) must stay in lockstep (widget pattern).
 */
import { describe, it, expect } from 'vitest';
import * as server from '../src/cards/card-spec.js';
import * as web from '../web/src/cards/card-spec.js';

const FIXTURES: Array<{ name: string; body?: string; input?: unknown }> = [
  {
    name: 'single title',
    input: { version: 1, layout: 'stack', cards: [{ title: 'Hello' }] },
  },
  {
    name: 'full card',
    input: {
      version: 1,
      layout: 'stack',
      cards: [
        {
          title: 'Unit 12B',
          subtitle: 'River',
          body: 'See **details** and [x](https://example.com).',
          fields: [{ label: 'Price', value: '$1' }],
          badges: [{ label: 'Ok', tone: 'success' }],
          footer: 'f',
          accent: '#0ea5e9',
          icon: 'home',
        },
      ],
    },
  },
  {
    name: 'fence roundtrip body',
    body: 'version: 1\nlayout: stack\ncards: [{"title":"A","body":"hi"}]',
  },
  { name: 'bad version', body: 'version: 2\nlayout: stack\ncards: [{"title":"A"}]' },
  { name: 'fields after cards', body: 'version: 1\nlayout: stack\ncards: [{"title":"A"}]\nx: 1' },
  { name: 'html body', input: { version: 1, layout: 'stack', cards: [{ title: 'T', body: '<b>x</b>' }] } },
  { name: 'a<b body', input: { version: 1, layout: 'stack', cards: [{ title: 'T', body: 'a<b' }] } },
  { name: 'price ok', input: { version: 1, layout: 'stack', cards: [{ title: 'T', body: 'price < 100' }] } },
  { name: 'empty', body: '' },
  { name: 'unknown icon', input: { version: 1, layout: 'stack', cards: [{ title: 'T', icon: 'nope' }] } },
];

describe('card-spec parity server vs web', () => {
  it('export key sets match', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(web).sort());
  });

  for (const f of FIXTURES) {
    it(`fixture: ${f.name}`, () => {
      const sr =
        f.body !== undefined
          ? server.parseCardFenceBody(f.body)
          : server.validateCardDeckSpec(f.input);
      const wr =
        f.body !== undefined
          ? web.parseCardFenceBody(f.body)
          : web.validateCardDeckSpec(f.input);
      expect(wr).toEqual(sr);
      if (sr.ok && wr.ok) {
        expect(web.toFence(wr.spec)).toBe(server.toFence(sr.spec));
        expect(web.toPlainSummary(wr.spec)).toBe(server.toPlainSummary(sr.spec));
      }
    });
  }

  it('body markdown validators match', () => {
    const samples = [
      '**bold** and *i*',
      'a<b',
      'price < 100',
      '[x](https://ok.com)',
      '[x](javascript:1)',
      '# no',
    ];
    for (const s of samples) {
      expect(web.validateCardBodyMarkdown(s)).toEqual(server.validateCardBodyMarkdown(s));
    }
  });
});
