/**
 * AI-generated conversation titles (Claude-style short summaries).
 * Uses a single completeSimple call — not the agent pool.
 */

import { completeSimple } from '@earendil-works/pi-ai';
import { getDeepSeekModel } from '../../llm/index.js';

const TITLE_MAX = 60;

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: string }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

function sanitizeTitle(raw: string): string {
  let t = raw.replace(/\s+/g, ' ').trim();
  // Drop surrounding quotes / markdown bold
  t = t.replace(/^["'`*]+|["'`*]+$/g, '').trim();
  // Drop trailing sentence punctuation
  t = t.replace(/[.!?]+$/g, '').trim();
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  return t;
}

/**
 * Produce a 3–7 word chat title from the first user turn (+ optional assistant excerpt).
 * Fails fast if the model returns nothing usable.
 */
export async function summarizeChatTitle(
  userText: string,
  assistantText?: string,
): Promise<string> {
  const user = userText.trim();
  if (!user) {
    throw new Error('summarizeChatTitle: userText is empty');
  }

  const model = getDeepSeekModel();
  const assistantClip = (assistantText ?? '').trim().slice(0, 400);
  const prompt =
    `User message:\n${user.slice(0, 600)}\n\n` +
    (assistantClip ? `Assistant excerpt:\n${assistantClip}\n\n` : '') +
    `Write a short chat title (3–7 words) that captures the user's intent. ` +
    `Output ONLY the title — no quotes, no trailing period, no labels.`;

  const response = await completeSimple(model, {
    systemPrompt:
      'You name chat conversations for a browser tab and sidebar. ' +
      'Be specific and concise (e.g. "Undervalued high-tech report", "AAPL valuation check"). ' +
      'Never invent tickers the user did not mention. Never refuse — always return a title.',
    messages: [
      {
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  });

  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(
      `summarizeChatTitle failed: ${response.errorMessage ?? response.stopReason}`,
    );
  }

  const title = sanitizeTitle(extractText(response.content));
  if (!title || title.length < 2) {
    throw new Error('summarizeChatTitle: model returned empty title');
  }
  return title;
}
