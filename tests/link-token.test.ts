import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLinkToken,
  peekLinkToken,
  consumeLinkToken,
  appendLinkToken,
  buildAuthedUrl,
  _clearLinkTokensForTests,
  type AuthUser,
} from '../src/webapp/auth.js';

const user: AuthUser = { type: 'user', slug: 'alice', displayName: 'Alice' };

beforeEach(() => {
  _clearLinkTokensForTests();
});

describe('createLinkToken', () => {
  it('mints a token that peeks to the same user', () => {
    const { token, expiresInMs } = createLinkToken({ user });
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(expiresInMs).toBe(60 * 60 * 1000);
    expect(peekLinkToken(token)?.slug).toBe('alice');
  });

  it('rejects missing user slug', () => {
    expect(() =>
      createLinkToken({ user: { type: 'user', slug: '', displayName: 'x' } }),
    ).toThrow(/slug/);
  });

  it('rejects ttl under 60s', () => {
    expect(() => createLinkToken({ user, ttlMs: 1000 })).toThrow(/at least/);
  });

  it('caps ttl at 24h', () => {
    const { expiresInMs } = createLinkToken({
      user,
      ttlMs: 48 * 60 * 60 * 1000,
    });
    expect(expiresInMs).toBe(24 * 60 * 60 * 1000);
  });
});

describe('pathPrefix + maxUses', () => {
  it('rejects path outside prefix', () => {
    const { token } = createLinkToken({ user, pathPrefix: '/dashboard' });
    expect(peekLinkToken(token, '/dashboard')).not.toBeNull();
    expect(peekLinkToken(token, '/dashboard/campaign/x')).not.toBeNull();
    expect(peekLinkToken(token, '/dl/file.mp4')).toBeNull();
  });

  it('deletes after maxUses', () => {
    const { token } = createLinkToken({ user, maxUses: 1 });
    expect(consumeLinkToken(token)?.slug).toBe('alice');
    expect(consumeLinkToken(token)).toBeNull();
    expect(peekLinkToken(token)).toBeNull();
  });

  it('rejects URL slug that does not match token identity', () => {
    const { token } = createLinkToken({
      user,
      pathPrefix: '/dl',
      boundSlug: 'alice',
    });
    expect(peekLinkToken(token, '/dl/x.png?slug=alice')).not.toBeNull();
    expect(peekLinkToken(token, '/dl/x.png?slug=bob')).toBeNull();
  });
});

describe('appendLinkToken / buildAuthedUrl', () => {
  it('appends t= to paths with and without query', () => {
    expect(appendLinkToken('/dashboard', 'abc')).toBe('/dashboard?t=abc');
    expect(appendLinkToken('/dl/x.mp4?slug=u', 'abc')).toBe('/dl/x.mp4?slug=u&t=abc');
  });

  it('buildAuthedUrl joins base + path + token', () => {
    const { url, token } = buildAuthedUrl('http://host:3001/', '/dashboard', {
      user,
      pathPrefix: '/dashboard',
    });
    expect(url).toBe(`http://host:3001/dashboard?t=${token}`);
  });
});
