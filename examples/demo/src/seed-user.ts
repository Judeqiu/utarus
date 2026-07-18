/**
 * Ensure a ready-to-login normal user exists for the Demo agent.
 *
 * Credentials (fixed for the walkthrough):
 *   slug:     demo
 *   email:    demo@example.com
 *   password: demo1234
 *
 * Idempotent: if demo.yaml already has a password_hash, leave it alone
 * unless DEMO_RESET_USER=1 is set.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import {
  blankState,
  saveState,
  loadState,
  stateExists,
  hashPassword,
  resolveDataRoot,
} from 'utarus';

export const DEMO_USER = {
  slug: 'demo',
  displayName: 'Demo User',
  contactEmail: 'demo@example.com',
  password: 'demo1234',
} as const;

export async function ensureDemoUser(): Promise<void> {
  const reset = process.env.DEMO_RESET_USER === '1';
  const path = join(resolveDataRoot(), 'users', `${DEMO_USER.slug}.yaml`);

  if (stateExists(DEMO_USER.slug) && !reset) {
    try {
      const existing = loadState(DEMO_USER.slug);
      if (existing.user.password_hash) {
        console.log(
          `[Demo] user ready: slug=${DEMO_USER.slug} password=${DEMO_USER.password}`,
        );
        return;
      }
    } catch {
      // rewrite broken file below
    }
  }

  if (existsSync(path) && reset) {
    console.log(`[Demo] DEMO_RESET_USER=1 — rewriting ${DEMO_USER.slug}`);
  }

  const state = blankState({
    slug: DEMO_USER.slug,
    displayName: DEMO_USER.displayName,
    contactEmail: DEMO_USER.contactEmail,
  });
  state.user.password_hash = await hashPassword(DEMO_USER.password);
  state.log.push({
    ts: new Date().toISOString().slice(0, 10),
    action: 'seeded_demo_user',
  });
  saveState(state);
  console.log(
    `[Demo] seeded user: slug=${DEMO_USER.slug} password=${DEMO_USER.password} (email=${DEMO_USER.contactEmail})`,
  );
}
