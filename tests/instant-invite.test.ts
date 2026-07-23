import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify, parse } from 'yaml';

const dataRoot = mkdtempSync(join(tmpdir(), 'utarus-instant-invite-'));
process.env.UTARUS_LOADED_BY_HOST = '1';
process.env.UTARUS_DATA_ROOT = dataRoot;

const { redeemInviteInstantly } = await import('../src/onboarding/instant-invite.js');
const { resolveInboundMessage } = await import('../src/onboarding/access-gate.js');
const { resolveUserBySlackUser, validateInviteCode } = await import('../src/state/index.js');

function seedInvite(code: string): void {
  mkdirSync(join(dataRoot, 'users'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'invites.yaml'),
    stringify([
      {
        code,
        created_by: 0,
        created_at: '2026-07-13',
        comment: 'test',
      },
    ]),
  );
}

describe('framework instant invite (all agents)', () => {
  beforeEach(() => {
    rmSync(join(dataRoot, 'users'), { recursive: true, force: true });
    mkdirSync(join(dataRoot, 'users'), { recursive: true });
    seedInvite('INV-91B6F805');
  });

  afterAll(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('redeems invite with display name and marks used', async () => {
    const result = await redeemInviteInstantly({
      code: 'INV-91B6F805',
      displayName: 'CY',
      slackUserId: 'U_CY',
    });
    expect(result.slug).toBe('cy');
    expect(result.displayName).toBe('CY');
    expect(typeof result.presetPassword).toBe('string');
    expect(result.presetPassword.length).toBeGreaterThan(0);

    const user = resolveUserBySlackUser('U_CY');
    expect(user?.profile.display_name).toBe('CY');
    expect(user?.user.slack_user_ids).toContain('U_CY');
    expect(user?.user.password_hash).toBeTruthy();

    expect(() => validateInviteCode('INV-91B6F805')).toThrow(/already been used/i);

    const invites = parse(readFileSync(join(dataRoot, 'invites.yaml'), 'utf-8')) as Array<{
      used_by_slack?: string;
    }>;
    expect(invites[0].used_by_slack).toBe('U_CY');
  });

  it('access gate denies without code', async () => {
    const r = await resolveInboundMessage({
      text: 'hello',
      linkedUser: null,
      isAdmin: false,
      slackUserId: 'U_STRANGER',
    });
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') expect(r.text).toMatch(/invite code/i);
  });

  it('access gate instant-redeems and continues as linked (no Q&A)', async () => {
    const r = await resolveInboundMessage({
      text: 'INV-91B6F805 help me analyze markets',
      linkedUser: null,
      isAdmin: false,
      slackUserId: 'U_NEW',
      channelDisplayName: 'CY',
    });
    expect(r.kind).toBe('agent');
    if (r.kind === 'agent') {
      expect(r.text).toMatch(/just joined|Access/i);
      expect(r.text).toMatch(/CY/);
      expect(r.text).toMatch(/help me analyze markets/);
      expect(r.text).not.toMatch(/contact_email|display name would you like|Option A/i);
    }
    expect(resolveUserBySlackUser('U_NEW')?.profile.display_name).toBe('CY');
    expect(existsSync(join(dataRoot, 'users', 'cy.yaml'))).toBe(true);
  });

  it('domain enrichMessage receives linked user after redeem', async () => {
    const r = await resolveInboundMessage({
      text: 'INV-91B6F805',
      linkedUser: null,
      isAdmin: false,
      slackUserId: 'U_DOMAIN',
      channelDisplayName: 'Dana',
      enrichMessage: async (ctx) => {
        expect(ctx.userSlug).toBe('dana');
        return `[Domain] user=${ctx.userSlug}\n\n${ctx.text}`;
      },
    });
    expect(r.kind).toBe('agent');
    if (r.kind === 'agent') {
      expect(r.text).toMatch(/\[Access\]/);
      expect(r.text).toMatch(/\[Domain\] user=dana/);
    }
  });

  it('fails fast when enrichMessage drops the user text', async () => {
    await redeemInviteInstantly({
      code: 'INV-91B6F805',
      displayName: 'Drop',
      slackUserId: 'U_DROP',
    });
    const linked = resolveUserBySlackUser('U_DROP');
    expect(linked).not.toBeNull();

    await expect(
      resolveInboundMessage({
        text: 'setup my company: Acme/SGD',
        linkedUser: linked,
        isAdmin: false,
        slackUserId: 'U_DROP',
        enrichMessage: async () => {
          // Classic bug: domain prefix only — agent never sees the ask.
          return `[Domain] company="Old Co" (MYR). Pull statements before diagnosing.]`;
        },
      }),
    ).rejects.toThrow(/dropped the user message/);
  });

  it('allows REPLY short-circuit without embedding user text', async () => {
    await redeemInviteInstantly({
      code: 'INV-91B6F805',
      displayName: 'Reply',
      slackUserId: 'U_REPLY',
    });
    const linked = resolveUserBySlackUser('U_REPLY');
    const r = await resolveInboundMessage({
      text: 'what is the name of my company?',
      linkedUser: linked,
      isAdmin: false,
      slackUserId: 'U_REPLY',
      enrichMessage: async () => 'REPLY:Your company is Acme Trading (SGD).',
    });
    expect(r).toEqual({
      kind: 'reply',
      text: 'Your company is Acme Trading (SGD).',
    });
  });
});

describe('demo mode access', () => {
  beforeEach(() => {
    rmSync(join(dataRoot, 'users'), { recursive: true, force: true });
    mkdirSync(join(dataRoot, 'users'), { recursive: true });
    seedInvite('INV-91B6F805');
  });

  it('auto-creates profile when demo mode is on (no invite)', async () => {
    const { setDemoMode, isDemoModeEnabled } = await import('../src/onboarding/demo-mode.js');
    setDemoMode({ enabled: true, updatedBySlack: 'U_ADMIN' });
    expect(isDemoModeEnabled()).toBe(true);

    const r = await resolveInboundMessage({
      text: 'Find undervalued stocks for me',
      linkedUser: null,
      isAdmin: false,
      slackUserId: 'U_DEMO_USER',
      channelDisplayName: 'Demo Person',
    });
    expect(r.kind).toBe('agent');
    if (r.kind === 'agent') {
      expect(r.text).toMatch(/demo mode/i);
      expect(r.text).toContain('Find undervalued stocks for me');
      expect(r.text).not.toMatch(/invite code/i);
    }
    expect(resolveUserBySlackUser('U_DEMO_USER')?.profile.display_name).toBe('Demo Person');

    setDemoMode({ enabled: false, updatedBySlack: 'U_ADMIN' });
  });

  it('denies without invite when demo mode is off', async () => {
    const { setDemoMode } = await import('../src/onboarding/demo-mode.js');
    setDemoMode({ enabled: false, updatedBySlack: 'U_ADMIN' });

    const r = await resolveInboundMessage({
      text: 'hello',
      linkedUser: null,
      isAdmin: false,
      slackUserId: 'U_LOCKED',
      channelDisplayName: 'Locked',
    });
    expect(r.kind).toBe('reply');
    if (r.kind === 'reply') expect(r.text).toMatch(/invite code/i);
  });
});
