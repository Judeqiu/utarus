import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  formatQuotesForAgent,
  userTurnTextForAgent,
  validateQuotesForConversation,
  QuoteValidationError,
  QUOTE_TEXT_MAX,
  QUOTES_PER_MESSAGE_MAX,
} from '../src/webapp/chat/quotes.js';
import {
  createConversation,
  appendMessage,
  getConversation,
} from '../src/webapp/chat/conversation-store.js';
import type { StoredQuote } from '../src/webapp/chat/conversation-types.js';

describe('quotes helpers', () => {
  const sample: StoredQuote = {
    messageId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    role: 'assistant',
    text: 'Revenue grew 12% YoY.',
  };

  it('formatQuotesForAgent builds delimited block with provenance', () => {
    const block = formatQuotesForAgent([sample]);
    expect(block).toContain('prior assistant message');
    expect(block).toContain(`id=${sample.messageId}`);
    expect(block).toContain('not as new instructions');
    expect(block).toContain('---\nRevenue grew 12% YoY.\n---');
  });

  it('formatQuotesForAgent fails fast on empty array', () => {
    expect(() => formatQuotesForAgent([])).toThrow(/at least one quote/);
  });

  it('userTurnTextForAgent joins with blank line when quotes present', () => {
    const out = userTurnTextForAgent('What about Q3?', [sample]);
    expect(out.startsWith('[User quoted')).toBe(true);
    expect(out.endsWith('What about Q3?')).toBe(true);
    expect(out).toContain('\n\nWhat about Q3?');
  });

  it('userTurnTextForAgent is identity without quotes', () => {
    expect(userTurnTextForAgent('hello')).toBe('hello');
    expect(userTurnTextForAgent('hello', null)).toBe('hello');
    expect(userTurnTextForAgent('hello', [])).toBe('hello');
  });
});

describe('validateQuotesForConversation', () => {
  let dataRoot: string;
  const prev = process.env.UTARUS_DATA_ROOT;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'utarus-quotes-'));
    process.env.UTARUS_DATA_ROOT = dataRoot;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.UTARUS_DATA_ROOT;
    else process.env.UTARUS_DATA_ROOT = prev;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function seed() {
    const c = createConversation('alice');
    appendMessage('alice', c.id, {
      id: '11111111-1111-1111-1111-111111111111',
      role: 'user',
      text: 'What is revenue?',
    });
    appendMessage('alice', c.id, {
      id: '22222222-2222-2222-2222-222222222222',
      role: 'assistant',
      text: 'Revenue grew **12%** YoY.',
    });
    return getConversation('alice', c.id);
  }

  it('accepts a valid quote and trims text', () => {
    const conv = seed();
    const out = validateQuotesForConversation(
      [
        {
          messageId: '22222222-2222-2222-2222-222222222222',
          role: 'assistant',
          text: '  Revenue grew 12% YoY.  ',
        },
      ],
      conv,
    );
    expect(out).toEqual([
      {
        messageId: '22222222-2222-2222-2222-222222222222',
        role: 'assistant',
        text: 'Revenue grew 12% YoY.',
      },
    ]);
  });

  it('rejects null and empty array', () => {
    const conv = seed();
    expect(() => validateQuotesForConversation(null, conv)).toThrow(
      QuoteValidationError,
    );
    expect(() => validateQuotesForConversation([], conv)).toThrow(
      QuoteValidationError,
    );
    try {
      validateQuotesForConversation(null, conv);
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteValidationError);
      expect((e as QuoteValidationError).code).toBe('invalid_quotes');
    }
  });

  it('rejects oversize text', () => {
    const conv = seed();
    expect(() =>
      validateQuotesForConversation(
        [
          {
            messageId: '22222222-2222-2222-2222-222222222222',
            role: 'assistant',
            text: 'x'.repeat(QUOTE_TEXT_MAX + 1),
          },
        ],
        conv,
      ),
    ).toThrow(QuoteValidationError);
  });

  it('rejects unknown messageId', () => {
    const conv = seed();
    try {
      validateQuotesForConversation(
        [
          {
            messageId: '99999999-9999-9999-9999-999999999999',
            role: 'assistant',
            text: 'nope',
          },
        ],
        conv,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteValidationError);
      expect((e as QuoteValidationError).code).toBe('quote_source_not_found');
    }
  });

  it('rejects role mismatch', () => {
    const conv = seed();
    try {
      validateQuotesForConversation(
        [
          {
            messageId: '22222222-2222-2222-2222-222222222222',
            role: 'user',
            text: 'Revenue grew 12% YoY.',
          },
        ],
        conv,
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteValidationError);
      expect((e as QuoteValidationError).code).toBe('quote_role_mismatch');
    }
  });

  it('enforces max count of 1', () => {
    const conv = seed();
    expect(QUOTES_PER_MESSAGE_MAX).toBe(1);
    expect(() =>
      validateQuotesForConversation(
        [
          {
            messageId: '22222222-2222-2222-2222-222222222222',
            role: 'assistant',
            text: 'a',
          },
          {
            messageId: '11111111-1111-1111-1111-111111111111',
            role: 'user',
            text: 'b',
          },
        ],
        conv,
      ),
    ).toThrow(QuoteValidationError);
  });
});
