import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { DomainExtension } from '../src/extension.js';
import {
  parseWebSlashCommand,
  listWebCommandCatalog,
  dispatchWebCommand,
  WEB_FRAMEWORK_COMMAND_NAMES,
} from '../src/webapp/chat/web-commands.js';

function baseExtension(overrides: Partial<DomainExtension> = {}): DomainExtension {
  return {
    purpose: 'test',
    tools: [],
    skills: [],
    ...overrides,
  };
}

describe('parseWebSlashCommand', () => {
  it('parses /name and args', () => {
    expect(parseWebSlashCommand('/bind BIND-ABC')).toEqual({
      name: 'bind',
      args: 'BIND-ABC',
    });
    expect(parseWebSlashCommand('  /Status  ')).toEqual({ name: 'status', args: '' });
    expect(parseWebSlashCommand('/onboard list pending')).toEqual({
      name: 'onboard',
      args: 'list pending',
    });
  });

  it('returns null for free-form text', () => {
    expect(parseWebSlashCommand('hello')).toBeNull();
    expect(parseWebSlashCommand('report this')).toBeNull();
    expect(parseWebSlashCommand('//not-a-cmd')).toBeNull();
  });
});

describe('listWebCommandCatalog', () => {
  it('includes framework commands and domain webCommands', () => {
    const catalog = listWebCommandCatalog(
      baseExtension({
        webCommands: [
          {
            name: 'bind',
            description: 'Finish registration',
            adminOnly: false,
            usageHint: 'BIND-XXXXXXXX',
            handler: () => 'ok',
          },
          {
            name: 'onboard',
            description: 'Admin onboard ops',
            adminOnly: true,
            handler: () => 'ok',
          },
        ],
      }),
      { isAdmin: true },
    );
    expect(catalog.some(c => c.name === 'clear' && c.source === 'framework')).toBe(true);
    expect(catalog.some(c => c.name === 'bind' && c.source === 'domain')).toBe(true);
    expect(catalog.some(c => c.name === 'onboard')).toBe(true);
  });

  it('hides admin-only domain commands for non-admins', () => {
    const catalog = listWebCommandCatalog(
      baseExtension({
        webCommands: [
          {
            name: 'secret',
            description: 'Admin only',
            adminOnly: true,
            handler: () => 'x',
          },
        ],
      }),
      { isAdmin: false },
    );
    expect(catalog.some(c => c.name === 'secret')).toBe(false);
  });

  it('lists usage as a framework command', () => {
    const catalog = listWebCommandCatalog(baseExtension());
    expect(catalog.some(c => c.name === 'usage' && c.source === 'framework')).toBe(true);
  });

  it('skips domain commands that collide with framework reserved names', () => {
    for (const name of WEB_FRAMEWORK_COMMAND_NAMES) {
      const catalog = listWebCommandCatalog(
        baseExtension({
          webCommands: [
            { name, description: 'collide', adminOnly: false, handler: () => 'x' },
          ],
        }),
      );
      const entries = catalog.filter(c => c.name === name);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe('framework');
    }
  });
});

describe('dispatchWebCommand', () => {
  it('runs matching domain handler with args and userSlug', async () => {
    const result = await dispatchWebCommand({
      text: '/bind BIND-91',
      extension: baseExtension({
        webCommands: [
          {
            name: 'bind',
            description: 'bind',
            adminOnly: false,
            handler: (ctx) => `got ${ctx.args} for ${ctx.userSlug}`,
          },
        ],
      }),
      userSlug: 'alice',
      isAdmin: false,
      conversationId: null,
    });
    expect(result).toEqual({
      kind: 'handled',
      text: 'got BIND-91 for alice',
    });
  });

  it('enforces adminOnly', async () => {
    const result = await dispatchWebCommand({
      text: '/onboard list',
      extension: baseExtension({
        webCommands: [
          {
            name: 'onboard',
            description: 'admin',
            adminOnly: true,
            handler: () => 'should not run',
          },
        ],
      }),
      userSlug: 'bob',
      isAdmin: false,
    });
    expect(result).toEqual({ kind: 'forbidden', text: '⛔ Admin only.' });
  });

  it('surfaces handler errors as reply text', async () => {
    const result = await dispatchWebCommand({
      text: '/boom',
      extension: baseExtension({
        webCommands: [
          {
            name: 'boom',
            description: 'fails',
            adminOnly: false,
            handler: () => {
              throw new Error('nope');
            },
          },
        ],
      }),
      userSlug: 'x',
      isAdmin: false,
    });
    expect(result).toEqual({ kind: 'handled', text: '❌ nope' });
  });

  it('does not treat free text or unknown/framework names as handled', async () => {
    const ext = baseExtension({
      webCommands: [
        { name: 'bind', description: 'b', adminOnly: false, handler: () => 'ok' },
      ],
    });
    expect(
      await dispatchWebCommand({
        text: 'hello',
        extension: ext,
        userSlug: 'a',
        isAdmin: false,
      }),
    ).toEqual({ kind: 'not_a_command' });
    expect(
      await dispatchWebCommand({
        text: '/unknown',
        extension: ext,
        userSlug: 'a',
        isAdmin: false,
      }),
    ).toEqual({ kind: 'unmatched' });
    expect(
      await dispatchWebCommand({
        text: '/help',
        extension: ext,
        userSlug: 'a',
        isAdmin: false,
      }),
    ).toEqual({ kind: 'unmatched' });
  });
});


describe('dispatchWebCommand /usage', () => {
  let tmp: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    prevDataRoot = process.env.UTARUS_DATA_ROOT;
    tmp = mkdtempSync(join(tmpdir(), 'utarus-web-cmd-test-'));
    process.env.UTARUS_DATA_ROOT = tmp;
  });

  afterEach(() => {
    if (prevDataRoot === undefined) delete process.env.UTARUS_DATA_ROOT;
    else process.env.UTARUS_DATA_ROOT = prevDataRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replies with the caller\'s own usage report', async () => {
    const result = await dispatchWebCommand({
      text: '/usage',
      extension: baseExtension(),
      userSlug: 'alice',
      isAdmin: false,
    });
    expect(result.kind).toBe('handled');
    const text = (result as { kind: 'handled'; text: string }).text;
    expect(text).toContain('**LLM**');
    expect(text).toContain('**Tools**');
  });

  it('handles sessions without a linked user slug', async () => {
    const result = await dispatchWebCommand({
      text: '/usage',
      extension: baseExtension(),
      userSlug: '',
      isAdmin: false,
    });
    expect(result.kind).toBe('handled');
    expect((result as { kind: 'handled'; text: string }).text).toMatch(/No user profile/);
  });
});
