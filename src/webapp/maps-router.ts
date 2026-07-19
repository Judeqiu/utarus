/**
 * Maps config API — browser Embed key for MapEmbed (session-auth).
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth } from './auth.js';
import { resolveMapsHttpConfig } from '../maps/config.js';

export const mapsRouter = Router();

mapsRouter.get('/config', requireAuth, (_req: Request, res: Response) => {
  const result = resolveMapsHttpConfig();
  if (result.kind === 'disabled') {
    res.status(200).json({ enabled: false });
    return;
  }
  if (result.kind === 'misconfigured') {
    res.status(500).json({
      error: 'maps_misconfigured',
      message: result.message,
    });
    return;
  }
  res.status(200).json({
    enabled: true,
    embedApiKey: result.embedApiKey,
  });
});
