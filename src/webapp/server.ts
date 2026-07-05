/**
 * BinDrive — user file portal.
 *
 * Usage: import { startBinDrive } from 'utarus/src/webapp/server.js'
 *   or run via the domain agent's webapp entry point.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from '../config.js';
import router from './routes.js';

export interface BinDriveOptions {
  /** Override mount path. Default '/'. */
  mountPath?: string;
  /** Override port. Default config.webapp.port. */
  port?: number;
}

export function createBinDriveApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());
  app.use(router);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'bindrive', timestamp: new Date().toISOString() });
  });

  return app;
}

export function startBinDrive(opts: BinDriveOptions = {}) {
  const app = createBinDriveApp();
  const port = opts.port ?? config.webapp.port;
  app.listen(port, () => {
    console.log(`BinDrive running on http://localhost:${port}`);
  });
}
