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
 *
 * Photo attachments (vision-capable models only):
 *   POST   /attachments          body: { name, mimeType, data(base64) } → ref + url
 *   GET    /attachments/:id      → image bytes (session-auth, slug-scoped)
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import { UTARUS_VERSION } from '../../version.js';
import { requireAuth, type AuthUser } from '../auth.js';
import { resolveInboundMessage } from '../../onboarding/access-gate.js';
import { loadState } from '../../state/index.js';
import { checkLlmCap } from '../../usage/index.js';
import type { Framework } from '../../framework.js';
import { getAgentLlmCapabilities } from '../../llm/index.js';
import { runAgent } from './run-agent.js';
import { sendSSEEvent, sendSSEComment, setSSEHeaders } from './sse.js';
import {
  saveAttachment,
  loadAttachment,
  deleteAttachments,
  sanitizeAttachmentName,
  ATTACHMENTS_PER_MESSAGE_MAX,
} from './attachments.js';
import {
  register,
  get as getRun,
  attachSubscriber,
  detachSubscriber,
  emit,
  replay,
  findActiveRunForConversation,
} from './stream-registry.js';
import type { ActiveRunInfo, ChatEvent, RunState, WebImageContent } from './types.js';
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
import {
  QuoteValidationError,
  userTurnTextForAgent,
  validateQuotesForConversation,
} from './quotes.js';
import type { StoredQuote } from './conversation-types.js';

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

/**
 * Photo uploads make sense only when the resolved model actually accepts
 * image input — pi-ai otherwise rewrites images to "(image omitted …)"
 * placeholder text, which is a silent failure we refuse to allow.
 * Evaluated lazily so router construction never throws on LLM misconfig.
 */
function visionEnabled(): boolean {
  try {
    return getAgentLlmCapabilities().imageInput;
  } catch {
    return false;
  }
}

const VISION_DISABLED_MESSAGE =
  'The configured LLM does not accept image input, so photo uploads are disabled. ' +
  'Use a vision-capable provider/model, or set UTARUS_LLM_IMAGE_INPUT=true to override.';

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
      // Client gets cleaned user-visible text only, plus activeRun so the SPA
      // can reattach SSE after switching chats or remounting mid-stream.
      const client = getConversationForClient(slug, id);
      const active = findActiveRunForConversation(slug, id);
      const activeRun: ActiveRunInfo | null = active
        ? {
            messageId: active.messageId,
            assistantMessageId: active.assistantMessageId,
            startedAt: active.startedAt,
          }
        : null;
      res.json({ ...client, activeRun });
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
      const conv = getConversation(slug, id);
      deleteAttachments(
        slug,
        conv.messages.flatMap(m => (m.attachments ?? []).map(a => a.id)),
      );
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

  // ── POST /attachments ───────────────────────────────────────────────
  // Upload a photo for a later /messages turn. base64-in-JSON, matching the
  // codebase's no-multipart convention; the SPA downscales before upload.
  router.post('/attachments', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    if (!visionEnabled()) {
      res.status(400).json({ error: 'vision_disabled', message: VISION_DISABLED_MESSAGE });
      return;
    }
    try {
      const ref = saveAttachment(slug, {
        name: req.body?.name,
        mimeType: req.body?.mimeType,
        data: req.body?.data,
      });
      res.status(201).json({ ...ref, url: `/api/chat/attachments/${ref.id}` });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── GET /attachments/:id ────────────────────────────────────────────
  router.get('/attachments/:id', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const slug = requireSlug(user, res);
    if (!slug) return;
    try {
      const file = loadAttachment(slug, String(req.params.id));
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(file.bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('not found') || msg.includes('Invalid') ? 404 : 500).json({
        error: msg,
      });
    }
  });

  // ── POST /messages ──────────────────────────────────────────────────
  router.post('/messages', async (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const body = req.body as {
      text?: unknown;
      queue?: unknown;
      conversationId?: unknown;
      attachments?: unknown;
      quotes?: unknown;
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

    // Resolve photo attachments: ids → stored files (agent image parts) +
    // display refs (persisted on the user message for reload rendering).
    let storedAttachments: Array<{ id: string; name: string; mimeType: string }> | undefined;
    let images: WebImageContent[] | undefined;
    if (body.attachments !== undefined) {
      if (
        !Array.isArray(body.attachments) ||
        body.attachments.length === 0 ||
        body.attachments.length > ATTACHMENTS_PER_MESSAGE_MAX ||
        body.attachments.some(
          (a: { id?: unknown } | null) =>
            !a || typeof a.id !== 'string' || !UUID_RE.test(a.id),
        )
      ) {
        res.status(400).json({
          error: 'invalid_attachments',
          message:
            `attachments must be an array of 1-${ATTACHMENTS_PER_MESSAGE_MAX} objects ` +
            'each with a valid attachment id.',
        });
        return;
      }
      if (!visionEnabled()) {
        res.status(400).json({ error: 'vision_disabled', message: VISION_DISABLED_MESSAGE });
        return;
      }
      try {
        const loaded = (body.attachments as Array<{ id: string; name?: unknown }>).map(a => ({
          a,
          file: loadAttachment(effectiveSlug, a.id),
        }));
        storedAttachments = loaded.map(({ a, file }) => ({
          id: a.id,
          name: sanitizeAttachmentName(a.name),
          mimeType: file.mimeType,
        }));
        images = loaded.map(({ file }) => ({
          type: 'image' as const,
          data: file.bytes.toString('base64'),
          mimeType: file.mimeType,
        }));
      } catch (e) {
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
        return;
      }
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

    // Validate quotes after conversation is resolved (membership checks need history).
    // Slash-command short-circuit above ignores quotes. Omit field = no quotes.
    let storedQuotes: StoredQuote[] | undefined;
    if (body.quotes !== undefined) {
      try {
        const convForQuotes = getConversation(effectiveSlug, conversationId);
        storedQuotes = validateQuotesForConversation(body.quotes, convForQuotes);
      } catch (e) {
        if (e instanceof QuoteValidationError) {
          res.status(400).json({ error: e.code, message: e.message });
          return;
        }
        res.status(500).json({
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
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
        hydrateAgentFromStoredMessages(agent, existing.messages, effectiveSlug);
      }
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Persist the *user-visible* text only. inbound.text may include
    // domain enrichMessage context (playbook, portfolio) for the agent —
    // that must never appear in the chat bubble on reload. Quotes are
    // stored as structured metadata (not inlined into text).
    const userVisibleText = text.trim();
    const userMsgId = randomUUID();
    try {
      appendMessage(effectiveSlug, conversationId, {
        id: userMsgId,
        role: 'user',
        text: userVisibleText,
        attachments: storedAttachments,
        quotes: storedQuotes,
      });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const userTurn = userTurnTextForAgent(inbound.text, storedQuotes);

    if (agent.state.isStreaming) {
      if (!queueFlag) {
        res.status(409).json({
          error: 'busy',
          message: 'Agent is still working on your last message.',
          conversationId,
        });
        return;
      }
      // Steer uses the same user-turn body as live (quote prefix + enriched text).
      // Pre-existing: no WEB_CHANNEL_HINT on steer.
      agent.steer({
        role: 'user',
        content: images?.length
          ? [{ type: 'text', text: userTurn }, ...images]
          : userTurn,
        timestamp: Date.now(),
      });
      res.json({ kind: 'queued', conversationId });
      return;
    }

    const messageId = randomUUID();
    const assistantMsgId = randomUUID();
    const runState: RunState = {
      messageId,
      conversationId,
      assistantMessageId: assistantMsgId,
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
    const promptText = `${WEB_CHANNEL_HINT}\n\n${userTurn}`;
    runAgent({
      messageId,
      userSlug: effectiveSlug,
      agent,
      message: promptText,
      images,
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
      const conv = getConversation(slug, conversationId);
      deleteAttachments(
        slug,
        conv.messages.flatMap(m => (m.attachments ?? []).map(a => a.id)),
      );
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
    // LLM capabilities — clients bind capability-gated UI (e.g. the photo
    // attach button) to this, never to provider/model ids.
    const capabilities = { imageInput: visionEnabled() };
    if (!user.slug) {
      res.json({
        slug: '',
        displayName: user.displayName,
        agentName: config.agent.name ?? 'Agent',
        version: UTARUS_VERSION,
        isStreaming: false,
        hasContext: false,
        capabilities,
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
      capabilities,
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
    const title = await summarizeChatTitle(userText, assistantText, slug);
    setConversationTitle(slug, conversationId, title, 'ai');
    emit(messageId, { type: 'title', conversationId, title });
  } catch (e) {
    // Title is best-effort for UX; do not fail the chat turn.
    console.warn(
      `[chat/title] conversation=${conversationId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
