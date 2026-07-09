/**
 * BinDrive routes — file management API + browser UI.
 */

import { Router, type Request, type Response } from 'express';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, basename } from 'path';
import { config, resolveDataRoot } from '../config.js';
import {
  requireAuth,
  requireAdmin,
  createSession,
  destroySession,
  authenticateAdmin,
  resolveByToken,
  createLinkToken,
  DEFAULT_LINK_TOKEN_TTL_MS,
  MAX_LINK_TOKEN_TTL_MS,
  MIN_LINK_TOKEN_TTL_MS,
  type AuthUser,
  targetSlug,
} from './auth.js';
import { loginPage, drivePage } from './views.js';

const router = Router();

function driveDir(slug: string): string {
  const root = resolveDataRoot();
  return join(root, 'drive', slug);
}

function ensureDriveDir(slug: string): string {
  const dir = driveDir(slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listFiles(slug: string): Array<{ name: string; size: number; modified: string }> {
  const dir = driveDir(slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => !f.startsWith('.'))
    .map(f => {
      const stat = statSync(join(dir, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// ── Browser UI ──────────────────────────────────────────────────────

router.get('/login', (req: Request, res: Response) => {
  const returnUrl = (req.query.return as string) || '';
  res.send(loginPage(undefined, returnUrl));
});

router.post('/login', (req: Request, res: Response) => {
  const { token, username, return: returnUrl } = req.body;
  if (!token) {
    res.send(loginPage('Token required', returnUrl));
    return;
  }

  // Try as seller token (if no username provided)
  let user = !username ? resolveByToken(token) : null;

  // Try as admin credentials
  if (!user && username) {
    user = authenticateAdmin(username, token);
  }

  if (!user) {
    res.send(loginPage('Invalid credentials', returnUrl));
    return;
  }

  const sessionToken = createSession(user);
  res.cookie('bindrive_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.redirect(returnUrl && returnUrl.startsWith('/') ? returnUrl : '/');
});

router.get('/logout', (req: Request, res: Response) => {
  const token = req.cookies?.['bindrive_session'];
  if (token) destroySession(token);
  res.clearCookie('bindrive_session');
  res.redirect('/login');
});

router.get('/', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const files = listFiles(slug);
    res.send(drivePage(user, slug, files));
  } catch (e) {
    res.status(400).send((e as Error).message);
  }
});

// ── API: Link tokens ────────────────────────────────────────────────

/**
 * POST /api/auth/link-token
 *
 * Mint a short-lived token for deep links (Slack/Telegram buttons, chat URLs).
 * Requires an existing session, permanent auth_token, or admin credentials.
 *
 * Body (all optional):
 *   { ttlSeconds?: number, pathPrefix?: string, maxUses?: number }
 *
 * Response:
 *   { token, expiresAt, expiresInMs }
 *
 * Attach as `?t=<token>` on any BinDrive URL. First browser visit exchanges
 * the token for a session cookie and redirects without `t`.
 */
router.post('/api/auth/link-token', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  const body = (req.body || {}) as {
    ttlSeconds?: number;
    pathPrefix?: string;
    maxUses?: number;
  };

  let ttlMs = DEFAULT_LINK_TOKEN_TTL_MS;
  if (body.ttlSeconds !== undefined) {
    if (typeof body.ttlSeconds !== 'number' || !Number.isFinite(body.ttlSeconds)) {
      res.status(400).json({ error: 'ttlSeconds must be a number' });
      return;
    }
    ttlMs = Math.floor(body.ttlSeconds * 1000);
  }

  try {
    if (ttlMs < MIN_LINK_TOKEN_TTL_MS) {
      res.status(400).json({
        error: `ttlSeconds must be at least ${MIN_LINK_TOKEN_TTL_MS / 1000}`,
      });
      return;
    }
    if (ttlMs > MAX_LINK_TOKEN_TTL_MS) {
      ttlMs = MAX_LINK_TOKEN_TTL_MS;
    }

    const minted = createLinkToken({
      user,
      ttlMs,
      pathPrefix: body.pathPrefix,
      boundSlug: user.slug,
      maxUses: body.maxUses,
    });
    res.json({
      token: minted.token,
      expiresAt: new Date(minted.expiresAt).toISOString(),
      expiresInMs: minted.expiresInMs,
      identity: {
        slug: user.slug,
        displayName: user.displayName,
        userId: user.userId,
        type: user.type,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── API: File management ────────────────────────────────────────────

/**
 * GET /api/files?slug=<slug>
 * List files in seller's drive folder.
 */
router.get('/api/files', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const files = listFiles(slug);
    res.json({ slug, files });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * POST /api/files?slug=<slug>
 * Upload a file. Multipart form: file field.
 * Also accepts JSON: { name, content } for simple text files.
 */
router.post('/api/files', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const dir = ensureDriveDir(slug);

    // JSON upload: { name, content }
    if (req.body?.name && req.body?.content !== undefined) {
      const name = basename(req.body.name);
      if (!name || name.startsWith('.')) {
        res.status(400).json({ error: 'Invalid file name' });
        return;
      }
      const filePath = join(dir, name);
      writeFileSync(filePath, req.body.content, 'utf-8');
      res.json({ ok: true, name, size: Buffer.byteLength(req.body.content) });
      return;
    }

    // Multipart upload (if multer is available)
    if ((req as any).file) {
      const file = (req as any).file;
      const name = basename(file.originalname);
      const filePath = join(dir, name);
      writeFileSync(filePath, file.buffer);
      res.json({ ok: true, name, size: file.size });
      return;
    }

    res.status(400).json({ error: 'Provide { name, content } in JSON body, or multipart file' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * GET /api/files/:name?slug=<slug>
 * Download a file.
 */
router.get('/api/files/:name', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const name = basename(req.params.name as string);
    const filePath = join(driveDir(slug), name);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const content = readFileSync(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(content);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * DELETE /api/files/:name?slug=<slug>
 * Delete a file.
 */
router.delete('/api/files/:name', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const name = basename(req.params.name as string);
    const filePath = join(driveDir(slug), name);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    unlinkSync(filePath);
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * GET /api/files/:name/view?slug=<slug>
 * View a file inline (for HTML reports).
 */
router.get('/api/files/:name/view', requireAuth, (req: Request, res: Response) => {
  const user = (req as any).user as AuthUser;
  try {
    const slug = targetSlug(req, user);
    const name = basename(req.params.name as string);
    const filePath = join(driveDir(slug), name);

    if (!existsSync(filePath)) {
      res.status(404).send('File not found');
      return;
    }

    const content = readFileSync(filePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(content);
  } catch (e) {
    res.status(500).send((e as Error).message);
  }
});

export default router;
