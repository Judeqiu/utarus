/**
 * WebUI chat router — mounted at /api/chat on the BinDrive express app.
 *
 * Routes (see docs/webui-chat-design.md §7):
 *   POST   /messages             → { kind: 'run'|'queued'|'reply', messageId? }
 *   GET    /stream/:messageId    ← SSE (ack, tool_start, tool_end, delta, heartbeat, done|error|cap, end)
 *   POST   /clear                → { ok: true }
 *   GET    /agent                → { slug, displayName, isStreaming, hasContext }
 *   POST   /abort                → { ok: true }   (aborts the user's active web run, if any)
 *
 * Auth: requireAuth on every route (cookie / Bearer / ?t=).
 *
 * The router is created via createChatRouter(framework) so it can resolve
 * agents per user. The stream registry is a module-level singleton shared
 * across the process.
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

const WEB_CHANNEL_HINT =
  '[Channel: web — render full GFM markdown. Tables are welcome. Code blocks use fenced syntax.\n' +
  'For BinDrive assets, write standard markdown links/images using the URLs your tools returned.\n' +
  'Keep total length reasonable.]';

interface CreateChatRouterDeps {
  framework: Framework;
}

export function createChatRouter(deps: CreateChatRouterDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // ── POST /messages ──────────────────────────────────────────────────
  router.post('/messages', async (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const body = req.body as { text?: unknown; queue?: unknown };
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const text = body.text;
    const queueFlag = body.queue === true;
    const isAdmin = user.type === 'admin';

    // Resolve linked user (web users always have a slug; admins may not).
    let linkedUser = null;
    if (user.type === 'user' && user.slug) {
      try {
        linkedUser = loadState(user.slug);
      } catch (e) {
        res.status(401).json({ error: 'session_invalid', message: (e as Error).message });
        return;
      }
    } else if (user.type === 'admin') {
      // Admins may chat without a linked user file; the gate handles routing.
      try {
        if (user.slug && user.slug !== 'admin') {
          linkedUser = loadState(user.slug);
        }
      } catch {
        // Admin without a state file is allowed — they get the unfiltered prompt path.
      }
    }

    // Framework access gate (handles stray INV-/ADM- codes; demo mode).
    let inbound;
    try {
      inbound = await resolveInboundMessage({
        text,
        linkedUser,
        isAdmin,
        // Web has no chat-platform id; pass display name for any onboard path.
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

    // Cap check (admins bypass).
    const capMsg = checkLlmCap(user.slug || '', isAdmin);
    if (capMsg) {
      res.status(429).json({ error: 'cap_exceeded', message: capMsg });
      return;
    }

    // Resolve the slug for the agent call. Web users always have one;
    // admins may be chatting on behalf of a slug or in their own context.
    const effectiveSlug = linkedUser?.user.slug ?? user.slug;
    if (!effectiveSlug) {
      res.status(400).json({ error: 'no_user_slug', message: 'No user slug resolved for this session.' });
      return;
    }

    const agent = deps.framework.getOrCreateAgent(effectiveSlug, isAdmin, 'web');

    if (agent.state.isStreaming) {
      if (!queueFlag) {
        res.status(409).json({ error: 'busy', message: 'Agent is still working on your last message.' });
        return;
      }
      agent.steer({ role: 'user', content: inbound.text, timestamp: Date.now() });
      res.json({ kind: 'queued' });
      return;
    }

    const messageId = randomUUID();
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

    // Fire and forget; events land in the registry.
    const promptText = `${WEB_CHANNEL_HINT}\n\n${inbound.text}`;
    runAgent({ messageId, userSlug: effectiveSlug, agent, message: promptText }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[chat/run] messageId=${messageId} threw post-respond: ${msg}`);
      emit(messageId, { type: 'error', message: `Agent error: ${msg}`, phase: 'during_run' });
      emit(messageId, { type: 'end' });
    });

    res.json({ kind: 'run', messageId });
  });

  // ── GET /stream/:messageId ──────────────────────────────────────────
  router.get('/stream/:messageId', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    const messageId = req.params.messageId as string;
    const run = getRun(messageId);
    if (!run) {
      res.status(404).json({ error: 'run_lost', message: 'This run is no longer in memory. Resend your message.' });
      return;
    }
    if (run.userSlug !== user.slug && user.type !== 'admin') {
      res.status(403).json({ error: 'forbidden', message: 'Stream does not belong to this session.' });
      return;
    }

    setSSEHeaders(res);

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : undefined;
    const replayList = replay(messageId, Number.isFinite(lastEventId) ? lastEventId : undefined);

    // If we cannot satisfy a replay request, surface a 404 (kept simple — the
    // registry's buffer is finite and old events may be gone).
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

    // If the run already ended and we've replayed everything, close the stream.
    if (run.ended) {
      res.end();
      return;
    }

    // Attach live subscriber. Forward events to the wire with monotonic ids.
    const baseId = counter;
    let liveId = baseId;
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

    // Periodic SSE comment to keep the connection alive through proxies.
    const keepalive = setInterval(() => sendSSEComment(res, `keepalive ${Date.now()}`), 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      detachSubscriber(messageId);
    });
  });

  // ── POST /clear ─────────────────────────────────────────────────────
  router.post('/clear', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    if (!user.slug) {
      res.status(400).json({ error: 'no_user_slug', message: 'No user slug for this session.' });
      return;
    }
    deps.framework.clearAgentContext(user.slug, 'web');
    res.json({ ok: true });
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
    const agent = deps.framework.getOrCreateAgent(user.slug, user.type === 'admin', 'web');
    res.json({
      slug: user.slug,
      displayName: user.displayName,
      agentName: config.agent.name ?? 'Agent',
      version: UTARUS_VERSION,
      isStreaming: !!agent.state.isStreaming,
      hasContext: !!agent.state.messages?.length,
    });
  });

  // ── POST /abort ─────────────────────────────────────────────────────
  router.post('/abort', (req: Request, res: Response) => {
    const user = (req as any).user as AuthUser;
    if (!user.slug) {
      res.status(400).json({ error: 'no_user_slug', message: 'No user slug for this session.' });
      return;
    }
    const agent = deps.framework.getOrCreateAgent(user.slug, user.type === 'admin', 'web');
    if (!agent.state.isStreaming) {
      res.status(409).json({ error: 'not_running', message: 'Agent is not currently running.' });
      return;
    }
    agent.abort();
    res.json({ ok: true });
  });

  return router;
}

/**
 * Replicates interfaces/slack/app.ts checkLlmCap. Returns a user-facing
 * message if the user is over their LLM token cap; null otherwise.
 */
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
    // Usage tracking is metadata, not a security control. Log and allow.
    console.warn(`[chat/cap] check failed for slug=${userSlug}: ${(e as Error).message}`);
    return null;
  }
}
