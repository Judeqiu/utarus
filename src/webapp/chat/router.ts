/**
 * WebUI chat router — mounted at /api/chat.
 *
 * Conversations (Claude-style multi-chat, server-persisted):
 *   GET    /conversations
 *   POST   /conversations
 *   GET    /conversations/:id
 *   PATCH  /conversations/:id
 *   DELETE /conversations/:id
 *
 * Messaging (requires conversationId):
 *   POST   /messages             → { kind, messageId?, conversationId }
 *   GET    /stream/:messageId
 *   POST   /clear                body: { conversationId }
 *   POST   /abort                body: { conversationId? }
 *   GET    /agent                → status + version
 *   GET    /commands             → framework + domain slash commands for /help
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import { UTARUS_VERSION } from '../../version.js';
import { requireAuth, type AuthUser } from '../auth.js';
import { resolveInboundMessage } from '../../onboarding/access-gate.js';
import { loadState } from '../../state/index.js';
import { loadUsage, getCap } from '../../usage/index.js';
import type { Framework } from '../../framework.js';
import { runAgent } from './run-agent.js';
import { sendSSEEvent, sendSSEComment, setSSEHeaders } from './sse.js';
import {
  register,
  get as getRun,
  attachSubscriber,
  detachSubscriber,
  emit,
  replay,
} from './stream-registry.js';
import type { ChatEvent, RunState } from './types.js';
import {
  listConversations,
  createConversation,
  getConversation,
  getConversationForClient,
  renameConversation,
  deleteConversation,
  appendMessage,
  clearConversationMessages,
  needsAiTitle,
  renameConversation as setConversationTitle,
} from './conversation-store.js';
import { hydrateAgentFromStoredMessages } from './hydrate-agent.js';
import { summarizeChatTitle } from './title-chat.js';
import {
  dispatchWebCommand,
  listWebCommandCatalog,
} from './web-commands.js';

const WEB_CHANNEL_HINT =
  '[Channel: web — render full GFM markdown. Tables are welcome. Code blocks use fenced syntax.\n' +
  'For BinDrive assets, write standard markdown links/images using the URLs your tools returned.\n' +
  'Keep total length reasonable.]';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CreateChatRouterDeps {
  framework: Framework;
}

function requireSlug(user: AuthUser, res: Response): string | null {
  if (!user.slug) {
    res.status(400).json({ error: 'no_user_slug', message: 'No user slug for this session.' });
    return null;
  }
  return user.slug;
}

function parseConversationId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return null;
  return raw;
}

export function createChatRouter(deps: CreateChatRouterDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // ── GET /conversations ──────────────────────────────────────────────
  router.get('/conversations', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    try {
      const conversations = listConversations(slug);
      res.json({ conversations });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── POST /conversations ─────────────────────────────────────────────
  router.post('/conversations', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const title =
      typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    try {
      const conv = createConversation(slug, title ? { title } : undefined);
      res.status(201).json(conv);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── GET /conversations/:id ──────────────────────────────────────────
  router.get('/conversations/:id', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const id = parseConversationId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'invalid_conversation_id' });
      return;
    }
    try {
      // Hydrate agent from raw stored turns (may include legacy enrich prefixes).
      const raw = getConversation(slug, id);
      const agent = deps.framework.getOrCreateAgent(
        slug,
        user.type === 'admin',
        'web',
        id,
      );
      if (!agent.state.messages?.length && raw.messages.length > 0) {
        hydrateAgentFromStoredMessages(agent, raw.messages);
      }
      // Client gets cleaned user-visible text only.
      res.json(getConversationForClient(slug, id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ── PATCH /conversations/:id ────────────────────────────────────────
  router.patch('/conversations/:id', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const id = parseConversationId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'invalid_conversation_id' });
      return;
    }
    if (typeof req.body?.title !== 'string') {
      res.status(400).json({ error: 'title required' });
      return;
    }
    try {
      const conv = renameConversation(slug, id, req.body.title);
      res.json(conv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ── DELETE /conversations/:id ───────────────────────────────────────
  router.delete('/conversations/:id', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const id = parseConversationId(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'invalid_conversation_id' });
      return;
    }
    try {
      deleteConversation(slug, id);
      deps.framework.clearAgentContext(slug, 'web', id);
      res.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ── GET /commands ───────────────────────────────────────────────────
  // Catalog for WebUI /help — framework + domain webCommands.
  router.get('/commands', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const isAdmin = user.type === 'admin';
    res.json({
      commands: listWebCommandCatalog(deps.framework.extension, { isAdmin }),
    });
  });

  // ── POST /messages ──────────────────────────────────────────────────
  router.post('/messages', async (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const body = req.body as {
      text?: unknown;
      queue?: unknown;
      conversationId?: unknown;
    };
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const text = body.text;
    const queueFlag = body.queue === true;
    const isAdmin = user.type === 'admin';

    let conversationId = parseConversationId(body.conversationId);

    // Domain webCommands — same idea as Telegram/Slack slash commands:
    // `/name args` is handled without the LLM.
    try {
      const cmdResult = await dispatchWebCommand({
        text,
        extension: deps.framework.extension,
        userSlug: user.slug ?? '',
        isAdmin,
        conversationId,
      });
      if (cmdResult.kind === 'forbidden' || cmdResult.kind === 'handled') {
        res.json({ kind: 'reply', text: cmdResult.text });
        return;
      }
    } catch (e) {
      res.status(500).json({
        error: 'command_failed',
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    let linkedUser = null;
    if (user.type === 'user' && user.slug) {
      try {
        linkedUser = loadState(user.slug);
      } catch (e) {
        res.status(401).json({ error: 'session_invalid', message: (e as Error).message });
        return;
      }
    } else if (user.type === 'admin') {
      try {
        if (user.slug && user.slug !== 'admin') {
          linkedUser = loadState(user.slug);
        }
      } catch {
        // Admin without state file is allowed.
      }
    }

    let inbound;
    try {
      inbound = await resolveInboundMessage({
        text,
        linkedUser,
        isAdmin,
        channelDisplayName: user.displayName,
        enrichMessage: deps.framework.extension.enrichMessage,
      });
    } catch (e) {
      res.status(500).json({ error: 'gate_failed', message: (e as Error).message });
      return;
    }

    if (inbound.kind === 'reply') {
      res.json({ kind: 'reply', text: inbound.text });
      return;
    }

    const capMsg = checkLlmCap(user.slug || '', isAdmin);
    if (capMsg) {
      res.status(429).json({ error: 'cap_exceeded', message: capMsg });
      return;
    }

    const effectiveSlug = linkedUser?.user.slug ?? user.slug;
    if (!effectiveSlug) {
      res.status(400).json({
        error: 'no_user_slug',
        message: 'No user slug resolved for this session.',
      });
      return;
    }

    // Create conversation on first message if client did not pass one.
    try {
      if (!conversationId) {
        const conv = createConversation(effectiveSlug);
        conversationId = conv.id;
      } else {
        // Verify ownership / existence
        getConversation(effectiveSlug, conversationId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
      return;
    }

    const agent = deps.framework.getOrCreateAgent(
      effectiveSlug,
      isAdmin,
      'web',
      conversationId,
    );

    // Hydrate agent from disk if this process just created the agent empty
    // while the conversation already has history (e.g. after restart).
    try {
      const existing = getConversation(effectiveSlug, conversationId);
      if (!agent.state.messages?.length && existing.messages.length > 0) {
        hydrateAgentFromStoredMessages(agent, existing.messages);
      }
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Persist the *user-visible* text only. inbound.text may include
    // domain enrichMessage context (playbook, portfolio) for the agent —
    // that must never appear in the chat bubble on reload.
    const userVisibleText = text.trim();
    const userMsgId = randomUUID();
    try {
      appendMessage(effectiveSlug, conversationId, {
        id: userMsgId,
        role: 'user',
        text: userVisibleText,
      });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (agent.state.isStreaming) {
      if (!queueFlag) {
        res.status(409).json({
          error: 'busy',
          message: 'Agent is still working on your last message.',
          conversationId,
        });
        return;
      }
      // Agent still receives the enriched prompt text.
      agent.steer({ role: 'user', content: inbound.text, timestamp: Date.now() });
      res.json({ kind: 'queued', conversationId });
      return;
    }

    const messageId = randomUUID();
    const assistantMsgId = randomUUID();
    const runState: RunState = {
      messageId,
      userSlug: effectiveSlug,
      isAdmin,
      agent,
      startedAt: Date.now(),
      bufferedEvents: [],
      subscriber: null,
      ended: false,
    };
    register(runState);
    emit(messageId, {
      type: 'ack',
      messageId,
      slug: effectiveSlug,
      agentName: config.agent.name ?? 'Agent',
    });

    const convId = conversationId;
    const promptText = `${WEB_CHANNEL_HINT}\n\n${inbound.text}`;
    runAgent({
      messageId,
      userSlug: effectiveSlug,
      agent,
      message: promptText,
      onComplete: async (result) => {
        try {
          if (result.error && !result.text) {
            appendMessage(effectiveSlug, convId, {
              id: assistantMsgId,
              role: 'assistant',
              text: '',
              error: result.error,
              stopReason: result.stopReason,
            });
          } else {
            appendMessage(effectiveSlug, convId, {
              id: assistantMsgId,
              role: 'assistant',
              text: result.text,
              error: result.error,
              stopReason: result.stopReason,
            });
          }
        } catch (e) {
          console.error(
            `[chat/persist] conversation=${convId} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // After first successful reply, AI-summarize sidebar + browser tab title.
        if (result.text && !result.error) {
          await maybeEmitAiTitle(
            messageId,
            effectiveSlug,
            convId,
            userVisibleText,
            result.text,
          );
        }
      },
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[chat/run] messageId=${messageId} threw post-respond: ${msg}`);
      emit(messageId, { type: 'error', message: `Agent error: ${msg}`, phase: 'during_run' });
      emit(messageId, { type: 'end' });
    });

    res.json({
      kind: 'run',
      messageId,
      conversationId,
      userMessageId: userMsgId,
      assistantMessageId: assistantMsgId,
    });
  });

  // ── GET /stream/:messageId ──────────────────────────────────────────
  router.get('/stream/:messageId', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const messageId = req.params.messageId as string;
    const run = getRun(messageId);
    if (!run) {
      res.status(404).json({
        error: 'run_lost',
        message: 'This run is no longer in memory. Resend your message.',
      });
      return;
    }
    if (run.userSlug !== user.slug && user.type !== 'admin') {
      res.status(403).json({
        error: 'forbidden',
        message: 'Stream does not belong to this session.',
      });
      return;
    }

    setSSEHeaders(res);

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : undefined;
    const replayList = replay(
      messageId,
      Number.isFinite(lastEventId) ? lastEventId : undefined,
    );

    if (replayList === null) {
      sendSSEEvent(res, {
        type: 'error',
        message: 'Run evicted from memory before reconnect. Resend your message.',
        phase: 'disconnected',
      });
      sendSSEEvent(res, { type: 'end' });
      res.end();
      return;
    }

    let counter = 0;
    for (const ev of replayList) {
      sendSSEEvent(res, ev, counter++);
    }

    if (run.ended) {
      res.end();
      return;
    }

    let liveId = counter;
    const subscriber = (event: ChatEvent) => {
      sendSSEEvent(res, event, liveId++);
      if (event.type === 'end') {
        try {
          res.end();
        } catch {
          // client already gone
        }
      }
    };
    attachSubscriber(messageId, subscriber);

    const keepalive = setInterval(
      () => sendSSEComment(res, `keepalive ${Date.now()}`),
      15000,
    );

    req.on('close', () => {
      clearInterval(keepalive);
      detachSubscriber(messageId);
    });
  });

  // ── POST /clear ─────────────────────────────────────────────────────
  // Clears messages in a conversation (keeps the conversation id) and drops agent cache.
  router.post('/clear', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const conversationId = parseConversationId(req.body?.conversationId);
    if (!conversationId) {
      res.status(400).json({ error: 'conversationId required' });
      return;
    }
    try {
      clearConversationMessages(slug, conversationId);
      deps.framework.clearAgentContext(slug, 'web', conversationId);
      res.json({ ok: true, conversationId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ── GET /agent ──────────────────────────────────────────────────────
  router.get('/agent', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    if (!user.slug) {
      res.json({
        slug: '',
        displayName: user.displayName,
        agentName: config.agent.name ?? 'Agent',
        version: UTARUS_VERSION,
        isStreaming: false,
        hasContext: false,
      });
      return;
    }
    const conversationId = parseConversationId(req.query.conversationId);
    const agent = deps.framework.getOrCreateAgent(
      user.slug,
      user.type === 'admin',
      'web',
      conversationId ?? undefined,
    );
    res.json({
      slug: user.slug,
      displayName: user.displayName,
      agentName: config.agent.name ?? 'Agent',
      version: UTARUS_VERSION,
      isStreaming: !!agent.state.isStreaming,
      hasContext: !!agent.state.messages?.length,
      conversationId: conversationId ?? null,
    });
  });

  // ── POST /abort ─────────────────────────────────────────────────────
  router.post('/abort', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    const conversationId = parseConversationId(req.body?.conversationId) ?? undefined;
    const agent = deps.framework.getOrCreateAgent(
      slug,
      user.type === 'admin',
      'web',
      conversationId,
    );
    if (!agent.state.isStreaming) {
      res.status(409).json({
        error: 'not_running',
        message: 'Agent is not currently running.',
      });
      return;
    }
    agent.abort();
    res.json({ ok: true });
  });

  return router;
}

async function maybeEmitAiTitle(
  messageId: string,
  slug: string,
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    if (!needsAiTitle(slug, conversationId)) return;
    const title = await summarizeChatTitle(userText, assistantText);
    setConversationTitle(slug, conversationId, title, 'ai');
    emit(messageId, { type: 'title', conversationId, title });
  } catch (e) {
    // Title is best-effort for UX; do not fail the chat turn.
    console.warn(
      `[chat/title] conversation=${conversationId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function checkLlmCap(userSlug: string, isAdmin: boolean): string | null {
  if (!userSlug) return null;
  try {
    if (isAdmin) return null;
    const cap = getCap(userSlug, 'llm_total_tokens');
    if (cap === undefined) return null;
    const usage = loadUsage(userSlug);
    const current = usage.period_llm.total_tokens;
    if (current >= cap) {
      return `You've hit your monthly LLM token cap (${current.toLocaleString('en-US')}/${cap.toLocaleString('en-US')} tokens). Contact an admin to raise it.`;
    }
    return null;
  } catch (e) {
    console.warn(
      `[chat/cap] check failed for slug=${userSlug}: ${(e as Error).message}`,
    );
    return null;
  }
}
