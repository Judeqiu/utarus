/**
 * User reporting tools — any user can file a report into the global
 * data/reporting.yaml file; admins can list entries for review.
 */

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { appendReport, listReports, reportingPath } from '../state/reporting.js';

function ok<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: 'text' as const, text }], details };
}
function fail(text: string): AgentToolResult<null> {
  return { content: [{ type: 'text' as const, text }], details: null };
}
function failFrom(error: unknown): AgentToolResult<null> {
  return fail(error instanceof Error ? error.message : String(error));
}

/**
 * @param userSlug  authenticated user — bound as reporter (LLM cannot spoof)
 * @param isAdmin   when true, includes list_reports
 */
export function createReportingTools(userSlug: string, isAdmin: boolean): AgentTool[] {
  const submit: AgentTool = {
    name: 'submit_report',
    label: 'Submit Report',
    description:
      'Save a user report / feedback / bug / abuse note to the global reporting file for admin review. ' +
      'Call this whenever the user says "report", wants to file feedback, report a problem, or flag content. ' +
      'Pass their report text (verbatim or lightly cleaned). Reporter is the current user — do not invent a different slug.',
    parameters: Type.Object({
      text: Type.String({
        description: 'The report body — what the user wants admins to see.',
      }),
      category: Type.Optional(
        Type.String({
          description: 'Optional category: feedback | bug | abuse | other (or free text).',
        }),
      ),
    }),
    async execute(_id, raw) {
      const p = raw as { text: string; category?: string };
      try {
        if (!userSlug) {
          return fail('Cannot submit report: no authenticated user slug in this session.');
        }
        const entry = appendReport({
          reporterSlug: userSlug,
          text: p.text,
          category: p.category,
        });
        return ok(
          `Report saved (id ${entry.id}). Admins can review it in the reporting log.`,
          { report: entry, path: reportingPath() },
        );
      } catch (e) {
        return failFrom(e);
      }
    },
  };

  const tools: AgentTool[] = [submit];

  if (isAdmin) {
    const list: AgentTool = {
      name: 'list_reports',
      label: 'List Reports',
      description:
        'List user-submitted reports from the global reporting file (newest first). Admin only. ' +
        'Use when an admin asks to see reports, feedback, or the reporting log.',
      parameters: Type.Object({
        reporter_slug: Type.Optional(
          Type.String({ description: 'Filter to reports from this user slug.' }),
        ),
        limit: Type.Optional(
          Type.Number({ description: 'Max number of reports to return (newest first).' }),
        ),
      }),
      async execute(_id, raw) {
        const p = raw as { reporter_slug?: string; limit?: number };
        try {
          const reports = listReports({
            reporterSlug: p.reporter_slug,
            limit: p.limit,
          });
          if (reports.length === 0) {
            return ok('No reports found.', { reports: [], path: reportingPath() });
          }
          const lines = [
            `Found ${reports.length} report${reports.length === 1 ? '' : 's'} (newest first):`,
            '',
            ...reports.map((r, i) => {
              const cat = r.category ? ` [${r.category}]` : '';
              const preview = r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text;
              return `${i + 1}. ${r.created_at} · \`${r.reporter_slug}\`${cat} · id ${r.id}\n   ${preview}`;
            }),
          ];
          return ok(lines.join('\n'), { reports, path: reportingPath() });
        } catch (e) {
          return failFrom(e);
        }
      },
    };
    tools.push(list);
  }

  return tools;
}
