import { describe, it, expect } from 'vitest';
import { blankState, assertValidSlug } from '../src/state/state-file.js';

describe('blankState', () => {
  it('populates framework fields with no fallback for missing args', () => {
    const s = blankState({ slug: 'acme', displayName: 'Acme', contactEmail: 'ops@acme.sg' });
    expect(s.user.slug).toBe('acme');
    expect(s.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.user.auth_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.user.telegram_user_ids).toEqual([]);
    expect(s.profile.display_name).toBe('Acme');
    expect(s.profile.contact_email).toBe('ops@acme.sg');
    expect(s.log).toHaveLength(1);
    expect(s.log[0]?.action).toBe('created');
  });

  it('refuses invalid slug', () => {
    expect(() => blankState({ slug: 'UPPER', displayName: 'x', contactEmail: 'y' }))
      .toThrow(/lowercase kebab-case/);
  });

  it('refuses empty display name', () => {
    expect(() => blankState({ slug: 'acme', displayName: '', contactEmail: 'y' }))
      .toThrow(/displayName is required/);
  });

  it('refuses empty contact email', () => {
    expect(() => blankState({ slug: 'acme', displayName: 'x', contactEmail: '' }))
      .toThrow(/contactEmail is required/);
  });
});

describe('assertValidSlug', () => {
  it.each(['acme', 'acme-trading', 'acme-123', 'a'])('accepts "%s"', (slug) => {
    expect(() => assertValidSlug(slug)).not.toThrow();
  });

  // Empty slug gets a specific "is required" message; non-empty bad slugs
  // get the lowercase-kebab-case message.
  it('rejects empty slug with a required message', () => {
    expect(() => assertValidSlug('')).toThrow(/User slug is required/);
  });

  // The regex requires leading alphanumeric. Trailing dashes are technically
  // allowed by the regex; init_user/redeem_invite_code strip them via the
  // slugifier before the slug ever reaches this check.
  it.each(['UPPER', 'acme_', '-acme', ' acme', 'Acme'])('rejects "%s"', (slug) => {
    expect(() => assertValidSlug(slug)).toThrow(/lowercase kebab-case/);
  });
});
