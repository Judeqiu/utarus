/**
 * Framework WebUI metadata routes (manifest for SPA shell).
 */

import { Router, type Request, type Response } from 'express';
import type { Framework } from '../framework.js';
import { requireAuth, type AuthUser } from './auth.js';
import { buildWebUiManifest } from './webui-manifest.js';

export function createWebUiRouter(framework: Framework): Router {
  const router = Router();

  router.get('/manifest', requireAuth, (req: Request, res: Response) => {
    const user = (req as Request & { user: AuthUser }).user;
    const manifest = buildWebUiManifest(framework.extension);
    // Filter admin-only nav for non-admins
    const nav = manifest.nav.filter((item) => {
      if (!item.adminOnly) return true;
      return user.type === 'admin';
    });
    res.json({ ...manifest, nav });
  });

  return router;
}
