/**
 * Single chokepoint for posting free-form text to Slack.
 *
 * All agent / LLM markdown MUST go through formatMarkdownForSlack so bold,
 * tables, links, and headings render as Slack mrkdwn everywhere — DMs,
 * mentions, tool posts.
 */

import { markdownToMrkdwn } from './markdown-to-mrkdwn.js';

export const SLACK_MAX_TEXT_LENGTH = 39_000;

export function formatMarkdownForSlack(text: string): string {
  return markdownToMrkdwn(text);
}

export function formatMarkdownForSlackSection(text: string, maxLen = 2900): string {
  const formatted = markdownToMrkdwn(text);
  if (formatted.length <= maxLen) return formatted;
  return formatted.slice(0, maxLen - 1).trimEnd() + '…';
}

export function splitSlackText(text: string, limit = SLACK_MAX_TEXT_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = -1;
    let inCodeBlock = false;

    for (let i = 0; i < Math.min(remaining.length, limit); i++) {
      if (remaining[i] === '`' && remaining.slice(i, i + 3) === '```') {
        inCodeBlock = !inCodeBlock;
        i += 2;
        continue;
      }
      if (inCodeBlock) continue;

      const ch = remaining[i];
      const slice = remaining.slice(i);

      if (ch === '\n' && slice.startsWith('\n\n')) {
        const searchEnd = remaining.indexOf('```', i + 2);
        if (searchEnd === -1 || searchEnd > limit) {
          splitAt = i + 2;
          break;
        }
      }
      if (ch === '\n' && !slice.startsWith('\n\n')) {
        const searchEnd = remaining.indexOf('```', i + 1);
        if (searchEnd === -1 || searchEnd > limit) {
          splitAt = i + 1;
          break;
        }
      }
    }

    if (splitAt === -1) {
      const lastSpace = remaining.lastIndexOf(' ', limit);
      splitAt = lastSpace > limit * 0.5 ? lastSpace + 1 : limit;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
