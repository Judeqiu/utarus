/**
 * Slack interface — Marie-parity UX.
 *
 * Per query the agent:
 *   1. Acks the user's message with an `eyes` reaction.
 *   2. Swaps to `gear` and posts a `🤔 … is thinking…` placeholder.
 *   3. Streams partial text + active tool status into the placeholder (throttled).
 *   4. Final delivery: replaces placeholder with the full response (or uploads
 *      an HTML file for >LONG_RESPONSE_THRESHOLD chars), swaps reaction to
 *      `✅`. On error, swaps to `❌` and surfaces an error message.
 *
 * If the agent is already streaming for this user, the inbound message is
 * queued via `agent.steer()` so the user doesn't lose it.
 *
 * Identical event/reaction/delivery flow as misc/marie/src/slack/app.ts.
 */

import { readFileSync } from 'fs';
import Bolt from '@slack/bolt';
const { App } = Bolt;
import { WebClient } from '@slack/web-api';
import { config } from '../../config.js';
import type { FrameworkHandle } from '../../framework.js';
import { clearAgentContext } from '../../agent.js';
import {
  listUserSlugs,
  loadState,
  resolveUserBySlackUser,
  createInviteCode,
  listInviteCodes,
  createAdminOnboardCode,
  listAdminOnboardCodes,
  revokeAdminOnboardCode,
} from '../../state/index.js';
import { checkLlmCap, loadUsage, formatUsageReport } from '../../usage/index.js';
import {
  isBillingEnabled,
  buildUpgradeUrl,
  getEntitlement,
} from '../../billing/index.js';
import { getAgentRunTimeoutMs } from '../../webapp/chat/run-agent.js';
import {
  formatMarkdownForSlack,
  splitSlackText,
  SLACK_MAX_TEXT_LENGTH,
} from './deliver-text.js';
import { markdownToHtml, wrapHtmlReport } from './markdown-to-html.js';
import { runWithContext, resolveReplyThreadTs, getRunContext } from './run-context.js';
import { wantsHtmlDelivery, publishHtmlReport } from '../../report/html-delivery.js';

export interface SlackOptions {
  handle: FrameworkHandle;
}

function isAdminFromSlackId(userId: string): boolean {
  const adminIds = process.env.SLACK_ADMIN_IDS
    ? process.env.SLACK_ADMIN_IDS.split(',').map(id => id.trim())
    : [];
  return adminIds.includes(userId);
}

/**
 * Framework-owned access gate + optional domain enrichMessage.
 * Instant INV- redeem lives in onboarding/ — domains must not re-implement it.
 */
async function resolveEnrichedText(
  handle: FrameworkHandle,
  ctx: {
    linkedUser: ReturnType<typeof resolveUserBySlackUser>;
    slackUserId: string;
    isAdmin: boolean;
    userSlug: string;
    text: string;
    channelDisplayName?: string;
  },
): Promise<{ kind: 'reply'; text: string } | { kind: 'agent'; text: string }> {
  const { resolveInboundMessage } = await import('../../onboarding/access-gate.js');
  return resolveInboundMessage({
    text: ctx.text,
    linkedUser: ctx.linkedUser,
    isAdmin: ctx.isAdmin,
    slackUserId: ctx.slackUserId,
    channelDisplayName: ctx.channelDisplayName,
    enrichMessage: handle.extension.enrichMessage,
  });
}

async function safeSay(say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>, text: string, threadTs?: string): Promise<void> {
  try {
    const payload: { text: string; thread_ts?: string } = { text };
    if (threadTs) payload.thread_ts = threadTs;
    await say(payload);
  } catch (error) {
    console.error('[Say Error]', error);
  }
}

async function postThinking(
  say: (msg: { text: string; thread_ts?: string }) => Promise<unknown>,
  threadTs?: string,
): Promise<string> {
  const name = config.agent.name ?? 'Agent';
  const payload: { text: string; thread_ts?: string } = { text: `🤔 ${name} is thinking...` };
  if (threadTs) payload.thread_ts = threadTs;
  const result = await say(payload) as { ts?: string };
  if (!result?.ts) {
    throw new Error('Failed to post thinking message: no ts returned');
  }
  return result.ts;
}

/**
 * Responses at or above this many characters are delivered as a styled HTML
 * file attachment instead of inline Slack text. Past this point Slack's inline
 * reading experience degrades badly (long scroll, hard to scan, tables wrap).
 */
const LONG_RESPONSE_THRESHOLD = 3_000;

function summarizeForTeaser(text: string): string {
  const firstPara = text.split(/\n{2,}/)[0] ?? text;
  const teaser = firstPara.length > 480 ? firstPara.slice(0, 480).trimEnd() + '…' : firstPara;
  return formatMarkdownForSlack(teaser);
}

/**
 * Upload any asset buffer to Slack as a native file attachment. Lightweight
 * port of marie/src/slack/video-post.ts uploadAssetToSlack — no bindrive
 * dependency, files.uploadV2 only.
 */
async function uploadAssetToSlack(
  assetBuffer: Buffer,
  filename: string,
  caption: string,
  channelId: string,
  threadTs?: string,
): Promise<void> {
  const token = config.slack.botToken;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN is not set — cannot upload file to Slack');
  }
  const web = new WebClient(token);
  const upload = threadTs
    ? await web.files.uploadV2({
        channel_id: channelId,
        file: assetBuffer,
        filename,
        title: filename,
        initial_comment: caption,
        thread_ts: threadTs,
      })
    : await web.files.uploadV2({
        channel_id: channelId,
        file: assetBuffer,
        filename,
        title: filename,
        initial_comment: caption,
      });

  const outer = (upload as { files?: Array<{ files?: Array<{ id?: string; permalink?: string }> }> })?.files?.[0];
  const inner = outer?.files?.[0];
  if (!inner?.id || !inner?.permalink) {
    throw new Error(`files.uploadV2 returned unexpected shape: ${JSON.stringify(upload).slice(0, 500)}`);
  }
}

/**
 * Long answers / explicit HTML requests:
 * 1. BinDrive signed /view URL (renders in phone browser)
 * 2. Slack .html file attachment (same as before — download/share)
 *
 * Opening the Slack attachment on mobile still shows source; prefer the link.
 */
async function deliverAsHtmlFile(
  client: Bolt.App['client'],
  channel: string,
  thinkingTs: string,
  text: string,
  userSlug: string,
  threadTs?: string,
): Promise<void> {
  const name = config.agent.name ?? 'Agent';
  const title = `${name} response · ` + new Date().toISOString().slice(0, 16).replace('T', ' ');
  const teaser = summarizeForTeaser(text);

  console.log(
    `[Deliver] html user=${userSlug} channel=${channel} textLen=${text.length} thread=${threadTs ?? 'none'}`,
  );

  let htmlBuffer: Buffer;
  let filename: string;
  let viewUrl: string | null = null;

  try {
    const published = publishHtmlReport({
      ownerSlug: userSlug,
      title,
      content: text,
      contentFormat: 'markdown',
      agentName: name,
    });
    filename = published.filename;
    viewUrl = published.viewUrl;
    // Same file as BinDrive — also attach to Slack for download/share
    htmlBuffer = readFileSync(published.absolutePath);
    console.log(
      `[Deliver] html user=${userSlug} published filename=${filename} bytes=${published.bytes} viewUrl=yes`,
    );
  } catch (err) {
    console.error(
      '[Deliver] publishHtmlReport failed; building HTML in-memory only:',
      err instanceof Error ? err.message : err,
    );
    const bodyHtml = markdownToHtml(text);
    const html = wrapHtmlReport(title, bodyHtml);
    filename = `${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-response-${Date.now()}.html`;
    htmlBuffer = Buffer.from(html, 'utf-8');
  }

  const linkBlock = viewUrl
    ? `\n\n📄 *Full report (open in browser — recommended on mobile):*\n${viewUrl}\n` +
      `_File also attached below. Slack’s in-app HTML preview shows source — use the link to render._`
    : '\n\n📄 _Full response attached as HTML. On mobile, open the file in an external browser if you see source code._';

  await client.chat.update({
    channel,
    ts: thinkingTs,
    text: teaser + linkBlock,
  });

  if (viewUrl) {
    try {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs ?? thinkingTs,
        text: `📄 <${viewUrl}|Open full HTML report in browser> (${text.length.toLocaleString('en-US')} chars)`,
        unfurl_links: false,
        unfurl_media: false,
      });
    } catch (err) {
      console.error('[Deliver] thread link post failed:', err instanceof Error ? err.message : err);
    }
  }

  // Always attach the .html file as well (previous behavior users expect).
  try {
    await uploadAssetToSlack(
      htmlBuffer,
      filename,
      viewUrl
        ? `📄 HTML file (${text.length.toLocaleString('en-US')} chars) — prefer the browser link above to render on mobile`
        : `📄 Full response (${text.length.toLocaleString('en-US')} chars) — open with external browser on mobile`,
      channel,
      threadTs,
    );
    console.log(`[Deliver] html user=${userSlug} slack file uploaded filename=${filename}`);
  } catch (err) {
    console.error(
      '[Deliver] Slack file upload failed (link may still work):',
      err instanceof Error ? err.message : err,
    );
    if (!viewUrl) throw err;
  }
}

async function deliverToSlack(
  client: Bolt.App['client'],
  channel: string,
  thinkingTs: string,
  text: string,
  userSlug: string,
  threadTs?: string,
): Promise<void> {
  const preferHtml = getRunContext()?.preferHtmlDelivery === true;
  if (preferHtml || text.length > LONG_RESPONSE_THRESHOLD) {
    console.log(
      `[Deliver] branch=html user=${userSlug} textLen=${text.length} ` +
        `preferHtml=${preferHtml} threshold=${LONG_RESPONSE_THRESHOLD} thread=${threadTs ?? 'none'}`,
    );
    await deliverAsHtmlFile(client, channel, thinkingTs, text, userSlug, threadTs);
    return;
  }

  const formatted = formatMarkdownForSlack(text);
  const chunks = splitSlackText(formatted);
  console.log(
    `[Deliver] branch=inline user=${userSlug} textLen=${text.length} mrkdwnLen=${formatted.length} ` +
      `chunks=${chunks.length} thread=${threadTs ?? 'none'}`,
  );

  await client.chat.update({ channel, ts: thinkingTs, text: chunks[0] });

  for (let i = 1; i < chunks.length; i++) {
    const body: { channel: string; text: string; thread_ts?: string } = {
      channel,
      text: `_(continued, ${i}/${chunks.length - 1})_\n\n${chunks[i]}`,
    };
    if (threadTs) body.thread_ts = threadTs;
    await client.chat.postMessage(body);
  }
}

async function ackWithEyes(client: Bolt.App['client'], channel: string, ts: string): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp: ts, name: 'eyes' });
  } catch (error) {
    console.error('[Ack reaction]', error);
  }
}

async function swapReaction(client: Bolt.App['client'], channel: string, ts: string, fromEmoji: string, toEmoji: string): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp: ts, name: fromEmoji });
  } catch (error) {
    console.error('[Remove reaction]', error);
  }
  try {
    await client.reactions.add({ channel, timestamp: ts, name: toEmoji });
  } catch (error) {
    console.error('[Add reaction]', error);
  }
}

/**
 * Last-resort error delivery. Surfaces something visible on failure — never
 * leaves the gear emoji spinning silently. Wrapped so this function itself
 * never throws.
 */
async function failWith(
  client: Bolt.App['client'],
  channel: string,
  thinkingTs: string | null,
  userMsgTs: string,
  msg: string,
): Promise<void> {
  try {
    if (thinkingTs) {
      await client.chat.update({ channel, ts: thinkingTs, text: msg });
    } else {
      await client.chat.postMessage({ channel, text: msg });
    }
  } catch (err) {
    console.error('[failWith] could not deliver error message to Slack:', err);
  }
  try {
    await swapReaction(client, channel, userMsgTs, 'gear', 'x');
  } catch (err) {
    console.error('[failWith] could not swap reaction:', err);
  }
}

function createThrottledUpdater(client: Bolt.App['client'], channel: string, ts: string, intervalMs: number) {
  let latestText = '';
  let lastSentText = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;

  const send = async () => {
    timer = null;
    lastFlushAt = Date.now();
    if (latestText === lastSentText) return;
    let textToSend = formatMarkdownForSlack(latestText);
    if (textToSend.length > SLACK_MAX_TEXT_LENGTH) {
      textToSend =
        textToSend.slice(0, SLACK_MAX_TEXT_LENGTH - 30) +
        '\n\n_...typing (full response coming soon)_';
    }
    try {
      await client.chat.update({ channel, ts, text: textToSend });
      lastSentText = latestText;
    } catch (error) {
      console.error('[stream update]', error);
    }
  };

  return {
    update(text: string) {
      latestText = text;
      if (timer) return;
      const elapsed = Date.now() - lastFlushAt;
      const delay = Math.max(0, intervalMs - elapsed);
      timer = setTimeout(() => { void send(); }, delay);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await send();
    },
  };
}

function createRunMonitor(updater: ReturnType<typeof createThrottledUpdater>) {
  const startTime = Date.now();
  const activeTools = new Map<string, { name: string; startedAt: number }>();
  let currentText = '';

  const fmtDuration = (ms: number) => `${Math.floor(ms / 1000)}s`;
  const name = config.agent.name ?? 'Agent';

  const compose = (): string => {
    const lines: string[] = [];
    if (currentText) lines.push(currentText);
    for (const [, t] of activeTools) {
      lines.push(`🔧 \`${t.name}\` running... (${fmtDuration(Date.now() - t.startedAt)})`);
    }
    if (lines.length === 0) {
      return `🤔 ${name} is working... (${fmtDuration(Date.now() - startTime)})`;
    }
    return lines.join('\n\n');
  };

  return {
    setText(text: string) {
      currentText = text;
      updater.update(compose());
    },
    onToolStart(toolCallId: string, name: string) {
      activeTools.set(toolCallId, { name, startedAt: Date.now() });
      updater.update(compose());
    },
    onToolEnd(toolCallId: string) {
      activeTools.delete(toolCallId);
      updater.update(compose());
    },
    beat() {
      updater.update(compose());
    },
  };
}

/**
 * Hard cap on a single agent run (see getAgentRunTimeoutMs).
 * Tools can run for several minutes — set UTARUS_AGENT_RUN_TIMEOUT_MS=0 to disable.
 */
async function getAgentResponse(
  handle: FrameworkHandle,
  userSlug: string,
  isAdmin: boolean,
  message: string,
  onToken?: (cumulativeText: string) => void,
  onToolStart?: (toolCallId: string, name: string) => void,
  onToolEnd?: (toolCallId: string) => void,
): Promise<string> {
  const agent = handle.getOrCreateAgent(userSlug, isAdmin);
  const startedAt = Date.now();
  let fullResponse = '';
  let aborted = false;
  let lastStopReason: string | undefined;
  const activeTools = new Map<string, { name: string; startedAt: number }>();
  const completedTools: Array<{ name: string; durMs: number; ok: boolean }> = [];
  const timeoutMs = getAgentRunTimeoutMs();

  const unsubscribe = agent.subscribe((event: any) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      fullResponse += event.assistantMessageEvent.delta;
      onToken?.(fullResponse);
    } else if (event.type === 'message_end' && event.message?.stopReason) {
      lastStopReason = event.message.stopReason;
      if (event.message.stopReason === 'aborted') {
        aborted = true;
      } else if (event.message.stopReason === 'length') {
        console.warn(`[Agent] user=${userSlug} hit max_tokens. Response truncated at ${fullResponse.length} chars.`);
      } else if (event.message.stopReason !== 'stop' && event.message.stopReason !== 'toolUse') {
        console.warn(`[Agent] user=${userSlug} unexpected stopReason: ${event.message.stopReason}`);
      }
    } else if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
      activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
      console.log(`[Tool] user=${userSlug} start name=${event.toolName} id=${event.toolCallId}`);
      onToolStart?.(event.toolCallId, event.toolName);
    } else if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      const entry = activeTools.get(event.toolCallId);
      const durMs = entry ? Date.now() - entry.startedAt : -1;
      const name = entry?.name ?? 'unknown';
      const ok = !event.isError;
      completedTools.push({ name, durMs, ok });
      console.log(
        `[Tool] user=${userSlug} end   name=${name} id=${event.toolCallId} dur=${durMs}ms ok=${ok}` +
          `${ok ? '' : ' error=' + JSON.stringify(event.error ?? event.result).slice(0, 200)}`,
      );
      onToolEnd?.(event.toolCallId);
    }
  });

  const watchdog =
    timeoutMs > 0
      ? setTimeout(() => {
          const hungTools = Array.from(activeTools.values()).map(
            (t) => `${t.name}(${Math.round((Date.now() - t.startedAt) / 1000)}s)`,
          );
          console.error(
            `[Agent] user=${userSlug} watchdog: aborting after ${timeoutMs}ms. ` +
              `textLen=${fullResponse.length} activeTools=[${hungTools.join(', ')}] completedTools=${completedTools.length}`,
          );
          agent.abort();
        }, timeoutMs)
      : null;

  console.log(
    `[Agent] user=${userSlug} start msgLen=${message.length}` +
      (timeoutMs > 0 ? ` timeoutMs=${timeoutMs}` : ' timeout=disabled'),
  );

  try {
    agent.prompt(message);
    await agent.waitForIdle();
  } finally {
    if (watchdog) clearTimeout(watchdog);
    unsubscribe();
  }

  const totalMs = Date.now() - startedAt;
  console.log(
    `[Agent] user=${userSlug} done stopReason=${lastStopReason ?? 'none'} ` +
      `textLen=${fullResponse.length} tools=${completedTools.length} dur=${totalMs}ms`,
  );

  if (agent.state.errorMessage) {
    console.error(
      `[Agent] user=${userSlug} errorMessage="${agent.state.errorMessage}" ` +
        `textLen=${fullResponse.length} tools=${completedTools.length} dur=${totalMs}ms`,
    );
    throw new Error(`Agent error: ${agent.state.errorMessage}`);
  }

  if (aborted) {
    throw new Error(
      timeoutMs > 0
        ? `Agent run timed out after ${Math.round(timeoutMs / 1000)}s`
        : 'Agent run was aborted',
    );
  }

  return fullResponse || 'Sorry, I could not generate a response.';
}

function helpText(handle?: { extension: { slackCommands?: Array<{ name: string; description: string; adminOnly: boolean }> } }): string {
  const name = config.agent.name ?? 'Agent';
  const lines = [
    `*${name}*`,
    '',
    'Commands:',
    '/list — list all users (admin)',
    '/get `<slug>` — show user record (admin)',
    '/clear — clear your conversation context',
    '/usage — show your LLM + tool usage',
    '/help — show this help',
    '',
    'Admin commands:',
    // /invite is reserved by Slack; custom apps must use /invitecode
    '/invitecode [comment] — issue invite code',
    '/invites [all|unused|used] — list invite codes',
    '/admincode [comment] — issue admin onboard code',
    '/admincodes [all|unused|used] — list admin onboard codes',
    '/revoke `<code>` — revoke an unused admin code',
    '/demomode on|off|status — open access without invite (auto-create profiles)',
  ];
  const domain = handle?.extension?.slackCommands;
  if (domain?.length) {
    lines.push('', 'Domain commands:');
    for (const cmd of domain) {
      lines.push(`/${cmd.name} — ${cmd.description}${cmd.adminOnly ? ' (admin)' : ''}`);
    }
  }
  lines.push('', 'Or send a message in plain text.');
  return lines.join('\n');
}

export async function startSlack(opts: SlackOptions): Promise<void> {
  const { handle } = opts;
  if (!config.slack.botToken || !config.slack.appToken || !config.slack.signingSecret) {
    throw new Error('SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET are required to start Slack interface');
  }

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  const client = app.client;

  app.error(async (error) => {
    console.error('[Slack Error]:', error);
  });

  // /help command
  app.command('/help', async ({ ack, respond }) => {
    await ack();
    await respond({ response_type: 'ephemeral', text: helpText(handle) });
  });

  // /demomode on|off|status — admin only; open access without invite
  app.command('/demomode', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const {
      parseDemoModeArgs,
      setDemoMode,
      getDemoModeState,
      formatDemoModeStatus,
    } = await import('../../onboarding/demo-mode.js');
    try {
      const action = parseDemoModeArgs(command.text ?? '');
      if (action === 'status') {
        await respond({
          response_type: 'ephemeral',
          text: formatDemoModeStatus(getDemoModeState()),
        });
        return;
      }
      const state = setDemoMode({
        enabled: action === 'on',
        updatedBySlack: command.user_id,
      });
      console.log(`[Demo mode] ${action} by Slack ${command.user_id}`);
      await respond({
        response_type: 'ephemeral',
        text: formatDemoModeStatus(state),
      });
    } catch (e) {
      await respond({
        response_type: 'ephemeral',
        text: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // /clear command
  app.command('/clear', async ({ ack, command, respond }) => {
    await ack();
    const slackUserId = command.user_id;
    const user = resolveUserBySlackUser(slackUserId);
    const key = user ? user.user.slug : `slack-${slackUserId}`;
    clearAgentContext(key);
    await respond({ response_type: 'ephemeral', text: '✅ Context cleared. Starting fresh conversation.' });
  });

  // /usage command — the caller's own LLM + tool usage for this month
  app.command('/usage', async ({ ack, command, respond }) => {
    await ack();
    const slackUserId = command.user_id;
    const user = resolveUserBySlackUser(slackUserId);
    const slug = user ? user.user.slug : `slack-${slackUserId}`;
    try {
      let report = formatUsageReport(loadUsage(slug));
      if (isBillingEnabled() && user) {
        try {
          const ent = getEntitlement(slug);
          report += `\n\n**Plan:** ${ent.display_name} (\`${ent.plan_id}\`, ${ent.status})`;
        } catch {
          /* ignore */
        }
      }
      await respond({
        response_type: 'ephemeral',
        text: formatMarkdownForSlack(report),
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /upgrade — magic enter link into WebUI billing
  app.command('/upgrade', async ({ ack, command, respond }) => {
    await ack();
    const user = resolveUserBySlackUser(command.user_id);
    if (!user) {
      await respond({
        response_type: 'ephemeral',
        text: 'Link your account first (invite code), then try /upgrade again.',
      });
      return;
    }
    if (!isBillingEnabled()) {
      await respond({
        response_type: 'ephemeral',
        text: 'Billing is not enabled on this agent.',
      });
      return;
    }
    try {
      const url = buildUpgradeUrl(user.user.slug, 'slack', {
        displayName: user.profile.display_name,
      });
      if (!url) {
        await respond({
          response_type: 'ephemeral',
          text: 'Billing is enabled but UTARUS_PUBLIC_BASE_URL is not set. Open the WebUI Billing page to upgrade.',
        });
        return;
      }
      await respond({
        response_type: 'ephemeral',
        text: `Upgrade / manage billing: ${url}`,
      });
    } catch (e) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ ${e instanceof Error ? e.message : e}`,
      });
    }
  });

  // /list command (admin only)
  app.command('/list', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const slugs = listUserSlugs();
    if (slugs.length === 0) {
      await respond({ response_type: 'ephemeral', text: 'No users yet.' });
      return;
    }
    const lines: string[] = ['Users:'];
    for (const slug of slugs) {
      try {
        const s = loadState(slug);
        lines.push(`• \`${slug}\` — ${s.profile.display_name} (created ${s.user.created_at})`);
      } catch (e) {
        lines.push(`• \`${slug}\` — ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /get command (admin only)
  app.command('/get', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const slug = command.text?.trim();
    if (!slug) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /get <slug>' });
      return;
    }
    try {
      const state = loadState(slug);
      const text = handle.extension.buildSessionAnnouncement
        ? handle.extension.buildSessionAnnouncement(state)
        : `User "${state.user.slug}" — ${state.profile.display_name}\n` +
          `Created ${state.user.created_at}. Contact: ${state.profile.contact_email}\n` +
          `${state.user.telegram_user_ids?.length ?? 0} Telegram account(s) linked.`;
      await respond({ response_type: 'ephemeral', text });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /invitecode — Slack reserves built-in /invite
  app.command('/invitecode', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const comment = command.text?.trim() || undefined;
    try {
      const entry = createInviteCode({ createdBy: 0, createdBySlack: command.user_id, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await respond({
        response_type: 'ephemeral',
        text: `✅ Invite code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /invites command (admin only)
  app.command('/invites', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const filter = (command.text?.trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /invites [all|unused|used]' });
      return;
    }
    const invites = listInviteCodes(filter);
    if (invites.length === 0) {
      await respond({ response_type: 'ephemeral', text: `No ${filter === 'all' ? '' : filter + ' '}invite codes.` });
      return;
    }
    const lines = [`*${invites.length} invite code${invites.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`];
    for (const inv of invites) {
      const status = inv.used_by ? `✅ used by ${inv.used_by} → ${inv.slug ?? '?'} on ${inv.used_at}` : '⏳ unused';
      lines.push(`• \`${inv.code}\` — ${inv.created_at} by ${inv.created_by} — ${status}`);
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /admincode command (admin only)
  app.command('/admincode', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const comment = command.text?.trim() || undefined;
    try {
      const entry = createAdminOnboardCode({ createdBy: 0, createdBySlack: command.user_id, comment });
      const commentLine = entry.comment ? `\nComment: ${entry.comment}` : '';
      await respond({
        response_type: 'ephemeral',
        text: `✅ Admin onboard code created: \`${entry.code}\`${commentLine}\n\nShare this code with the user.`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // /admincodes command (admin only)
  app.command('/admincodes', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const filter = (command.text?.trim() || 'all') as 'all' | 'unused' | 'used';
    if (!['all', 'unused', 'used'].includes(filter)) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /admincodes [all|unused|used]' });
      return;
    }
    const codes = listAdminOnboardCodes(filter);
    if (codes.length === 0) {
      await respond({ response_type: 'ephemeral', text: `No ${filter === 'all' ? '' : filter + ' '}admin onboard codes.` });
      return;
    }
    const lines = [`*${codes.length} admin onboard code${codes.length === 1 ? '' : 's'}${filter !== 'all' ? ` (${filter})` : ''}:*`];
    for (const c of codes) {
      let status: string;
      if (c.revoked) status = '🚫 REVOKED';
      else if (c.used_by) status = `✅ used by ${c.used_by} on ${c.used_at}`;
      else status = '⏳ unused';
      const comment = c.comment ? ` — _${c.comment}_` : '';
      lines.push(`• \`${c.code}\`${comment} — ${c.created_at} by ${c.created_by} — ${status}`);
    }
    await respond({ response_type: 'ephemeral', text: lines.join('\n') });
  });

  // /revoke command (admin only)
  app.command('/revoke', async ({ ack, command, respond }) => {
    await ack();
    if (!isAdminFromSlackId(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
      return;
    }
    const code = command.text?.trim();
    if (!code) {
      await respond({ response_type: 'ephemeral', text: 'Usage: /revoke <code>' });
      return;
    }
    try {
      const entry = revokeAdminOnboardCode(code);
      await respond({
        response_type: 'ephemeral',
        text: `✅ Admin code \`${entry.code}\` revoked.${entry.comment ? ` Comment was: _${entry.comment}_` : ''}`,
      });
    } catch (e) {
      await respond({ response_type: 'ephemeral', text: `❌ ${e instanceof Error ? e.message : e}` });
    }
  });

  // Domain-specific slash commands (e.g. Invester /guidance)
  for (const cmd of handle.extension.slackCommands ?? []) {
    const slash = cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`;
    app.command(slash, async ({ ack, command, respond }) => {
      await ack();
      const isAdmin = isAdminFromSlackId(command.user_id);
      if (cmd.adminOnly && !isAdmin) {
        await respond({ response_type: 'ephemeral', text: '⛔ Admin only.' });
        return;
      }
      try {
        const args = (command.text ?? '').trim();
        const reply = await Promise.resolve(
          cmd.handler({ args, slackUserId: command.user_id, isAdmin }),
        );
        await respond({ response_type: 'ephemeral', text: reply });
      } catch (e) {
        await respond({
          response_type: 'ephemeral',
          text: `❌ ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  }

  // ── Direct messages ───────────────────────────────────────────────────
  app.message(async ({ message, say }) => {
    const channelType = (message as { channel_type?: string }).channel_type;
    if (channelType && channelType !== 'im' && channelType !== 'mpim') return;

    if (!('text' in message) || !message.text) return;

    const slackUserId = message.user ?? 'unknown';
    const userMessage = message.text;
    const channel = message.channel;
    const userMsgTs = message.ts;
    const threadTs = resolveReplyThreadTs(message as { ts?: string; thread_ts?: string });

    let linkedUser = resolveUserBySlackUser(slackUserId);
    let userSlug = linkedUser ? linkedUser.user.slug : `slack-${slackUserId}`;
    const admin = isAdminFromSlackId(slackUserId);

    if (userMessage.toLowerCase() === '/clear' || userMessage.toLowerCase() === 'clear context') {
      clearAgentContext(userSlug);
      await safeSay(say, '✅ Context cleared. Starting fresh conversation.', threadTs);
      return;
    }

    console.log(`[Slack DM] ${slackUserId}: ${userMessage}`);

    await ackWithEyes(client, channel, userMsgTs);

    let enriched: { kind: 'reply'; text: string } | { kind: 'agent'; text: string };
    try {
      enriched = await resolveEnrichedText(handle, {
        linkedUser,
        slackUserId,
        isAdmin: admin,
        userSlug,
        text: userMessage,
      });
    } catch (error) {
      console.error('[Enrich error]', error);
      await failWith(client, channel, null, userMsgTs, '⚠️ Could not prepare your message. Please try again.');
      return;
    }

    // Instant invite may have just created the user — switch agent key to real slug.
    const afterLink = resolveUserBySlackUser(slackUserId);
    if (afterLink) {
      linkedUser = afterLink;
      userSlug = afterLink.user.slug;
    }

    if (enriched.kind === 'reply') {
      await safeSay(say, formatMarkdownForSlack(enriched.text), threadTs);
      await swapReaction(client, channel, userMsgTs, 'eyes', 'white_check_mark');
      return;
    }

    const agent = handle.getOrCreateAgent(userSlug, admin);

    // If agent is busy, queue via steer() — eyes reaction stays as the ack.
    if (agent.state.isStreaming) {
      console.log(`[Run] user=${userSlug} surface=dm phase=steer_queued msgLen=${userMessage.length}`);
      agent.steer({ role: 'user', content: enriched.text, timestamp: Date.now() });
      await safeSay(say, '⏳ Queued behind your current run — I will pick this up next.', threadTs);
      return;
    }

    await swapReaction(client, channel, userMsgTs, 'eyes', 'gear');

    // From here on, ANY failure must surface to the user — otherwise the gear
    // emoji spins forever.
    let thinkingTs: string | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      const capMsg = checkLlmCap(userSlug, admin, { channel: 'slack' });
      if (capMsg) {
        console.log(`[Run] user=${userSlug} surface=dm phase=cap_hit`);
        await safeSay(say, capMsg, threadTs);
        await swapReaction(client, channel, userMsgTs, 'gear', 'x');
        return;
      }

      const preferHtml = wantsHtmlDelivery(userMessage) || wantsHtmlDelivery(enriched.text);
      let agentInput = enriched.text;
      if (preferHtml) {
        agentInput =
          `[Delivery: User requested an HTML / browser report. Produce a complete, well-structured answer ` +
          `(headings, bullets, numbers with sources). You may also call post_html_report for a custom page. ` +
          `The platform will publish your final answer as a viewable HTML page with a link.]\n\n` +
          enriched.text;
      }

      await runWithContext(
        {
          userSlug,
          slackUserId,
          channelId: channel,
          threadTs,
          surface: 'dm',
          preferHtmlDelivery: preferHtml,
        },
        async () => {
          thinkingTs = await postThinking(say, threadTs);
          console.log(
            `[Run] user=${userSlug} surface=dm phase=thinking_posted ts=${thinkingTs} preferHtml=${preferHtml}`,
          );
          const updater = createThrottledUpdater(client, channel, thinkingTs, 800);
          const monitor = createRunMonitor(updater);
          heartbeat = setInterval(() => monitor.beat(), 3000);

          const text = await getAgentResponse(
            handle,
            userSlug,
            admin,
            agentInput,
            (partial) => monitor.setText(partial),
            (id, name) => monitor.onToolStart(id, name),
            (id) => monitor.onToolEnd(id),
          );
          console.log(`[Run] user=${userSlug} surface=dm phase=agent_done textLen=${text.length}`);
          await updater.flush();
          await deliverToSlack(client, channel, thinkingTs, text, userSlug, threadTs);
          await swapReaction(client, channel, userMsgTs, 'gear', 'white_check_mark');
          console.log(`[Run] user=${userSlug} surface=dm phase=complete`);
        },
      );
    } catch (error) {
      const phase = thinkingTs ? 'after_thinking' : 'before_thinking';
      console.error(
        `[Run] user=${userSlug} surface=dm phase=error phase_at_failure=${phase} ` +
          `errMsg="${error instanceof Error ? error.message : String(error)}" ` +
          `stack=${error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : 'none'}`,
      );
      await failWith(
        client,
        channel,
        thinkingTs,
        userMsgTs,
        '⚠️ Something went wrong while generating this response. Please try again.',
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  // ── Channel mentions ──────────────────────────────────────────────────
  app.event('app_mention', async ({ event, say }) => {
    if (!('text' in event) || !event.text) return;

    const userMessage = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const channel = event.channel ?? 'unknown';
    const userMsgTs = event.ts;
    const threadTs = resolveReplyThreadTs(event as { ts?: string; thread_ts?: string });

    if (!userMessage) {
      const name = config.agent.name ?? 'Agent';
      await safeSay(say, `👋 Hey! I'm ${name}. How can I help you today?`, threadTs);
      return;
    }

    const slackUserId = event.user ?? 'unknown';

    let linkedUser = resolveUserBySlackUser(slackUserId);
    let userSlug = linkedUser ? linkedUser.user.slug : `slack-${slackUserId}`;
    const admin = isAdminFromSlackId(slackUserId);

    if (userMessage.toLowerCase() === '/clear' || userMessage.toLowerCase() === 'clear context') {
      clearAgentContext(userSlug);
      await safeSay(say, '✅ Context cleared. Starting fresh conversation.', threadTs);
      return;
    }

    console.log(`[Slack Mention] channel=${channel} user=${slackUserId} thread=${threadTs}: ${userMessage}`);

    await ackWithEyes(client, channel, userMsgTs);

    let enriched: { kind: 'reply'; text: string } | { kind: 'agent'; text: string };
    try {
      enriched = await resolveEnrichedText(handle, {
        linkedUser,
        slackUserId,
        isAdmin: admin,
        userSlug,
        text: userMessage,
      });
    } catch (error) {
      console.error('[Enrich error]', error);
      await failWith(client, channel, null, userMsgTs, '⚠️ Could not prepare your message. Please try again.');
      return;
    }

    const afterLink = resolveUserBySlackUser(slackUserId);
    if (afterLink) {
      linkedUser = afterLink;
      userSlug = afterLink.user.slug;
    }

    if (enriched.kind === 'reply') {
      await safeSay(say, formatMarkdownForSlack(enriched.text), threadTs);
      await swapReaction(client, channel, userMsgTs, 'eyes', 'white_check_mark');
      return;
    }

    const agent = handle.getOrCreateAgent(userSlug, admin);

    if (agent.state.isStreaming) {
      console.log(`[Run] user=${userSlug} surface=mention phase=steer_queued msgLen=${userMessage.length}`);
      agent.steer({ role: 'user', content: enriched.text, timestamp: Date.now() });
      await safeSay(say, '⏳ Queued behind your current run — I will pick this up next.', threadTs);
      return;
    }

    await swapReaction(client, channel, userMsgTs, 'eyes', 'gear');

    let thinkingTs: string | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    try {
      const capMsg = checkLlmCap(userSlug, admin, { channel: 'slack' });
      if (capMsg) {
        console.log(`[Run] user=${userSlug} surface=mention phase=cap_hit`);
        await safeSay(say, capMsg, threadTs);
        await swapReaction(client, channel, userMsgTs, 'gear', 'x');
        return;
      }

      const preferHtml = wantsHtmlDelivery(userMessage) || wantsHtmlDelivery(enriched.text);
      let agentInput = enriched.text;
      if (preferHtml) {
        agentInput =
          `[Delivery: User requested an HTML / browser report. Produce a complete, well-structured answer ` +
          `(headings, bullets, numbers with sources). You may also call post_html_report for a custom page. ` +
          `The platform will publish your final answer as a viewable HTML page with a link.]\n\n` +
          enriched.text;
      }

      await runWithContext(
        {
          userSlug,
          slackUserId,
          channelId: channel,
          threadTs,
          surface: 'mention',
          preferHtmlDelivery: preferHtml,
        },
        async () => {
          thinkingTs = await postThinking(say, threadTs);
          console.log(
            `[Run] user=${userSlug} surface=mention phase=thinking_posted ts=${thinkingTs} preferHtml=${preferHtml}`,
          );
          const updater = createThrottledUpdater(client, channel, thinkingTs, 800);
          const monitor = createRunMonitor(updater);
          heartbeat = setInterval(() => monitor.beat(), 3000);

          const text = await getAgentResponse(
            handle,
            userSlug,
            admin,
            agentInput,
            (partial) => monitor.setText(partial),
            (id, name) => monitor.onToolStart(id, name),
            (id) => monitor.onToolEnd(id),
          );
          console.log(`[Run] user=${userSlug} surface=mention phase=agent_done textLen=${text.length}`);
          await updater.flush();
          await deliverToSlack(client, channel, thinkingTs, text, userSlug, threadTs);
          await swapReaction(client, channel, userMsgTs, 'gear', 'white_check_mark');
          console.log(`[Run] user=${userSlug} surface=mention phase=complete`);
        },
      );
    } catch (error) {
      const phase = thinkingTs ? 'after_thinking' : 'before_thinking';
      console.error(
        `[Run] user=${userSlug} surface=mention phase=error phase_at_failure=${phase} ` +
          `errMsg="${error instanceof Error ? error.message : String(error)}" ` +
          `stack=${error instanceof Error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : 'none'}`,
      );
      await failWith(
        client,
        channel,
        thinkingTs,
        userMsgTs,
        '⚠️ Something went wrong while generating this response. Please try again.',
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  await app.start();
  const name = config.agent.name ?? 'Agent';
  console.log(`${name} Slack bot is running.`);

  const handleSignal = (sig: string) => {
    console.log(`\nReceived ${sig}, stopping Slack bot...`);
    process.exit(0);
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}
