/**
 * Session-auth widget state API + artifact chat cards on user save.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthUser } from './auth.js';
import type { WidgetStateStore } from '../widgets/state-store.js';
import type { WidgetRegistry } from '../widgets/registry.js';
import {
  toFence,
  validateStateData,
  validateWidgetSpec,
  WIDGET_INSTANCE_ID_RE,
} from '../widgets/widget-spec.js';
import { appendMessage, getConversation } from './chat/conversation-store.js';
import type { StoredChatMessage } from './chat/conversation-types.js';

export function createWidgetsRouter(deps: {
  store: WidgetStateStore;
  registry: WidgetRegistry;
}): Router {
  const router = Router();
  const { store, registry } = deps;

  router.get('/state/:instanceId', requireAuth, async (req: Request, res: Response) => {
    const user = (req as Request & { user: AuthUser }).user;
    const instanceId = String(req.params.instanceId ?? '');
    if (!WIDGET_INSTANCE_ID_RE.test(instanceId)) {
      res.status(400).json({ error: 'invalid instanceId', code: 'invalid' });
      return;
    }
    const result = await store.load({
      backend: 'bindrive',
      ownerSlug: user.slug,
      instanceId,
    });
    if (!result.ok) {
      const status =
        result.code === 'not_found' ? 404 : result.code === 'invalid' ? 400 : 500;
      res.status(status).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ doc: result.doc });
  });

  router.put('/state/:instanceId', requireAuth, async (req: Request, res: Response) => {
    const user = (req as Request & { user: AuthUser }).user;
    const instanceId = String(req.params.instanceId ?? '');
    if (!WIDGET_INSTANCE_ID_RE.test(instanceId)) {
      res.status(400).json({ error: 'invalid instanceId', code: 'invalid' });
      return;
    }

    const body = req.body as {
      kind?: string;
      data?: unknown;
      expectedRevision?: number;
      conversationId?: string;
      title?: string;
      summary?: string;
    };

    if (typeof body.kind !== 'string' || !body.kind) {
      res.status(400).json({ error: 'kind is required', code: 'invalid' });
      return;
    }
    const reg = registry.byId.get(body.kind);
    if (!reg) {
      res.status(400).json({ error: `Unknown widget kind: ${body.kind}`, code: 'invalid' });
      return;
    }
    if (!reg.supportsPersistence) {
      res.status(400).json({
        error: `kind '${body.kind}' does not support persistence`,
        code: 'invalid',
      });
      return;
    }
    if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision)) {
      res.status(400).json({ error: 'expectedRevision must be an integer', code: 'invalid' });
      return;
    }
    const sc = validateStateData(body.data);
    if (!sc.ok) {
      res.status(413).json({ error: sc.error, code: 'too_large' });
      return;
    }

    const result = await store.save(
      { backend: 'bindrive', ownerSlug: user.slug, instanceId },
      {
        kind: body.kind,
        data: body.data as Record<string, unknown>,
        expectedRevision: body.expectedRevision,
      },
    );

    if (!result.ok) {
      const status =
        result.code === 'conflict'
          ? 409
          : result.code === 'not_found'
            ? 404
            : result.code === 'too_large'
              ? 413
              : result.code === 'invalid'
                ? 400
                : 500;
      res.status(status).json({
        error: result.error,
        code: result.code,
        currentRevision: result.currentRevision,
      });
      return;
    }

    let message: StoredChatMessage | undefined;
    if (typeof body.conversationId === 'string' && body.conversationId.trim()) {
      const convId = body.conversationId.trim();
      try {
        getConversation(user.slug, convId);
        const title =
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim()
            : reg.label;
        const summary =
          typeof body.summary === 'string' && body.summary.trim()
            ? body.summary.trim()
            : `Saved (revision ${result.doc.revision})`;
        const specResult = validateWidgetSpec({
          action: 'update',
          instanceId,
          kind: body.kind,
          title,
          summary,
          props: {},
          persistence: 'bindrive',
        });
        if (!specResult.ok) {
          throw new Error(specResult.error);
        }
        const text = [
          summary,
          '',
          '```widget',
          toFence(specResult.spec),
          '```',
        ].join('\n');
        const conv = appendMessage(user.slug, convId, {
          role: 'assistant',
          text,
          stopReason: 'widget_state_save',
        });
        message = conv.messages[conv.messages.length - 1];
      } catch (e) {
        // State is already saved; card emission failure is reported but not rolled back
        res.status(200).json({
          doc: result.doc,
          cardError: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }

    res.json({ doc: result.doc, message });
  });

  return router;
}
