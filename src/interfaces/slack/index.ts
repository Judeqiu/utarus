/**
 * Slack interface — public re-exports.
 *
 * Implementation lives in app.ts; helpers in deliver-text.ts,
 * markdown-to-mrkdwn.ts, markdown-to-html.ts, run-context.ts.
 */

export { startSlack } from './app.js';
export type { SlackOptions } from './app.js';
export { resolveReplyThreadTs, runWithContext, getRunContext } from './run-context.js';
export type { RunContext } from './run-context.js';
