/**
 * Utarus webapp — BinDrive portal + WebUI chat SPA + admin REST.
 *
 * Entry points:
 *   - `createBinDriveApp()` — BinDrive only (files, login form, health).
 *   - `buildWebApp(framework, opts)` — full stack: SPA + BinDrive + chat +
 *     admin + web onboard (login/redeem/password). Domain agents mount
 *     extra routers (e.g. landing-page /api/onboard/register) via opts.
 *   - `startWebApp(framework, opts)` / `startBinDrive(opts)` — listen.
 *
 * Spec: docs/webui-chat-design.md
 */

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type Router,
} from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { UTARUS_VERSION } from '../version.js';
import type { Framework } from '../framework.js';
import bindriveRouter from './routes.js';
import { createChatRouter } from './chat/router.js';
import { adminRouter } from './chat/admin-router.js';
import { onboardRedeemRouter } from './chat/onboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Built SPA lives at packageRoot/web/dist.
 * From dist/webapp/server.js → ../../web/dist
 * From src/webapp/server.ts (tsx) → ../../web/dist
 */
export function resolveWebDistDir(): string {
  return resolve(__dirname, '../../web/dist');
}

export interface ExtraRouterMount {
  /** Mount path, e.g. `/api/onboard` */
  path: string;
  router: Router;
}

export interface BuildWebAppOptions {
  /**
   * Domain-specific routers mounted after framework routes.
   * Same path may be mounted multiple times (Express stacks them).
   */
  extraRouters?: ExtraRouterMount[];
  /** Override SPA static directory. Default: package web/dist. */
  webDistDir?: string;
}

export interface BinDriveOptions {
  /** Override mount path. Default '/'. */
  mountPath?: string;
  /** Override port. Default config.webapp.port. */
  port?: number;
}

export interface StartWebAppOptions extends BuildWebAppOptions {
  port?: number;
}

/** BinDrive-only express app (no chat SPA). */
export function createBinDriveApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use(bindriveRouter);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'bindrive',
      version: UTARUS_VERSION,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

export function startBinDrive(opts: BinDriveOptions = {}): Express {
  const app = createBinDriveApp();
  const port = opts.port ?? config.webapp.port;
  app.listen(port, () => {
    console.log(`BinDrive running on http://localhost:${port}`);
  });
  return app;
}

/**
 * Full WebUI: SPA static + BinDrive + chat + admin + web onboard.
 * Requires the live Framework so the chat router can resolve agents.
 *
 * Ordering:
 *   1. body parsers / cookies
 *   2. SPA static (owns `/` when dist exists)
 *   3. explicit GET /login → SPA index (before BinDrive form login)
 *   4. BinDrive routes (/logout, /api/files/*, /api/auth/*, /health)
 *   5. /api/onboard (framework redeem/login/password)
 *   6. /api/chat, /api/admin
 *   7. extraRouters (domain)
 *   8. SPA fallback for client-side routes
 */
export function buildWebApp(framework: Framework, opts: BuildWebAppOptions = {}): Express {
  const webDistDir = opts.webDistDir ?? resolveWebDistDir();
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  if (existsSync(webDistDir)) {
    app.use(
      express.static(webDistDir, {
        index: 'index.html',
        setHeaders: (_res, filePath) => {
          if (/\.[0-9a-f]{8,}\.(js|css)$/i.test(filePath)) {
            _res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    const indexHtml = join(webDistDir, 'index.html');
    app.get('/login', (_req: Request, res: Response) => {
      res.sendFile(indexHtml);
    });
  } else {
    console.warn(
      `[utarus/web] SPA static dir missing: ${webDistDir}. API-only mode (build web/ first).`,
    );
  }

  // BinDrive sub-app: /logout, /api/files/*, legacy form /login when SPA absent, /health.
  app.use(createBinDriveApp());

  app.use('/api/onboard', onboardRedeemRouter);
  app.use('/api/chat', createChatRouter({ framework }));
  app.use('/api/admin', adminRouter);

  for (const mount of opts.extraRouters ?? []) {
    app.use(mount.path, mount.router);
  }

  if (existsSync(webDistDir)) {
    const indexHtml = join(webDistDir, 'index.html');
    app.get(
      /^\/(?!api\/|logout|health).*$/,
      (req: Request, res: Response, next: NextFunction) => {
        const last = req.path.split('/').pop() ?? '';
        if (last.includes('.')) {
          return next();
        }
        res.sendFile(indexHtml);
      },
    );
  }

  return app;
}

/** Build full WebUI and listen. */
export function startWebApp(framework: Framework, opts: StartWebAppOptions = {}): Express {
  const app = buildWebApp(framework, opts);
  const port = opts.port ?? config.webapp.port;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`WEBAPP_PORT must be a positive integer, got "${port}".`);
  }
  app.listen(port, () => {
    const name = config.agent.name ?? 'Utarus';
    console.log(`[${name}/Web] listening on http://localhost:${port} (chat + BinDrive + admin)`);
  });
  return app;
}
