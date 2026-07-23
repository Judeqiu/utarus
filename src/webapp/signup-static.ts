/**
 * Framework open-signup page at /signup (static HTML + assets).
 * Served only when UTARUS_OPEN_SIGNUP_ENABLED=true.
 */

import { Router, static as expressStatic, type Request, type Response, type NextFunction } from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { isOpenSignupEnabled } from '../onboarding/web-signup.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function resolveSignupStaticDir(): string | null {
  const candidates = [
    // package root signup-static/ (published with package)
    join(HERE, '../../signup-static'),
    // when running from dist/webapp
    join(HERE, '../../../signup-static'),
    join(process.cwd(), 'signup-static'),
    join(process.cwd(), 'node_modules/utarus/signup-static'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'index.html'))) return p;
  }
  return null;
}

/**
 * Mount at `/`. Paths: /signup, /signup/, /signup/styles.css, /signup/app.js
 */
export function createSignupStaticRouter(): Router {
  const router = Router();

  router.use('/signup', (req: Request, res: Response, next: NextFunction) => {
    if (!isOpenSignupEnabled()) {
      res.status(404).send('Open signup is not enabled (set UTARUS_OPEN_SIGNUP_ENABLED=true).');
      return;
    }
    next();
  });

  const dir = resolveSignupStaticDir();
  if (!dir) {
    router.use('/signup', (_req, res) => {
      res.status(500).send('signup-static/ not found in utarus package.');
    });
    return router;
  }

  router.use(
    '/signup',
    expressStatic(dir, {
      index: 'index.html',
      fallthrough: false,
    }),
  );
  return router;
}
