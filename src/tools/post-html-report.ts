/**
 * post_html_report — generic tool: publish markdown/HTML as a browser-viewable
 * BinDrive page and return the signed URL (for Slack/Telegram to share).
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { config } from '../config.js';
import { publishHtmlReport } from '../report/html-delivery.js';
import { getRunContext } from '../interfaces/slack/run-context.js';

function ok<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text' as const, text }], details };
}
function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}

export function createPostHtmlReportTool(): AgentTool {
  return {
    name: 'post_html_report',
    label: 'Post HTML Report',
    description: `Publish a browser-viewable HTML report and return a signed link.

Use when the user asks for an HTML report, HTML page, full written report as a file, or "post HTML". Pass markdown (default) or raw HTML. Saves to BinDrive under owner_slug and returns a /view URL that renders on mobile (do NOT rely on Slack file attachments for HTML).

Always include the returned viewUrl verbatim in your reply so the user can open it.`,
    parameters: Type.Object({
      owner_slug: Type.String({
        description: 'User slug for BinDrive folder (data/drive/<owner_slug>/). From get_user / session context.',
      }),
      title: Type.String({ description: 'Report title shown in the HTML header.' }),
      content: Type.String({
        description: 'Report body as markdown (default) or HTML. Prefer structured markdown with headings and bullets.',
      }),
      content_format: Type.Optional(
        Type.Union([Type.Literal('markdown'), Type.Literal('html')], {
          description: 'markdown (default) or html',
        }),
      ),
      filename: Type.Optional(
        Type.String({ description: 'Optional filename ending in .html' }),
      ),
    }),
    async execute(_id, raw) {
      const p = raw as {
        owner_slug: string;
        title: string;
        content: string;
        content_format?: 'markdown' | 'html';
        filename?: string;
      };
      try {
        // Prefer run-context slug when agent omits or mismatches (fail closed on empty)
        const ctx = getRunContext();
        const owner = (p.owner_slug || ctx?.userSlug || '').trim();
        if (!owner) {
          return fail('owner_slug is required (user slug for BinDrive).');
        }

        const result = publishHtmlReport({
          ownerSlug: owner,
          title: p.title,
          content: p.content,
          contentFormat: p.content_format ?? 'markdown',
          filename: p.filename,
          agentName: config.agent.name ?? 'Agent',
        });

        const ttlMin = Math.round(result.expiresInMs / 60000);
        return ok(
          [
            `HTML report published: ${result.filename}`,
            `Size: ${result.bytes} bytes`,
            `View (opens in browser, renders on mobile): ${result.viewUrl}`,
            `Link valid ~${ttlMin} minutes.`,
            '',
            'YOU MUST paste the View URL verbatim in your reply to the user.',
          ].join('\n'),
          result,
        );
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  };
}
