/**
 * Framework open-signup page at /signup.
 *
 * - Default: framework shell (signup-static/index.html) + embed form.
 * - Domain shell: when webUi.signupPage.shell is registered, GET /signup
 *   serves that HTML; Utarus form still mounts via /signup/embed.js into
 *   #utarus-signup-root.
 *
 * Served only when UTARUS_OPEN_SIGNUP_ENABLED=true.
 */

import {
  Router,
  static as expressStatic,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import {
  getOpenSignupShell,
  isOpenSignupEnabled,
} from '../onboarding/web-signup.js';

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
    if (existsSync(join(p, 'index.html')) && existsSync(join(p, 'embed.js'))) {
      return p;
    }
  }
  return null;
}

function sendSignupHtml(req: Request, res: Response, frameworkIndex: string): void {
  const shell = getOpenSignupShell();
  if (shell) {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(shell.absolutePath);
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(frameworkIndex);
}

/**
 * Mount at `/`. Paths:
 *   GET /signup, /signup/           → domain shell or framework index.html
 *   /signup/form.css, embed.js, …   → framework form assets
 *   /signup/styles.css              → default page chrome (framework shell only)
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
      res.status(500).send('signup-static/ not found in utarus package (need index.html + embed.js).');
    });
    return router;
  }

  const frameworkIndex = join(dir, 'index.html');

  // Exact page routes before static assets
  router.get(['/signup', '/signup/'], (req, res) => {
    sendSignupHtml(req, res, frameworkIndex);
  });

  router.use(
    '/signup',
    expressStatic(dir, {
      index: false,
      fallthrough: false,
    }),
  );

  return router;
}
