import { describe, expect, it } from 'vitest';
import {
  validateRichDocumentProps,
  validateRichDocumentState,
  validateExternalOpenUrl,
  RICH_DOCUMENT_FORMAT,
} from '../src/widgets/kinds/rich-document-state.js';
import {
  validateKindProps,
  validateKindState,
} from '../src/widgets/kind-validators.js';
import { isAllowedWidgetEntryUrl } from '../src/widgets/widget-spec.js';
import { resolvePlatformWidgetsDistDirFrom } from '../src/widgets/platform-assets.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('rich-document state', () => {
  it('accepts valid v1 document', () => {
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: '# Hello\n\n**bold**\n',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects missing format', () => {
    const r = validateRichDocumentState({ markdown: 'x' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown fields', () => {
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: 'x',
      html: '<b>x</b>',
    });
    expect(r.ok).toBe(false);
  });

  it('accepts comments without changing markdown contract', () => {
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: '# Title\n',
      comments: [
        {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          body: 'Consider a shorter title',
          quote: 'Title',
          author: 'agent',
          createdAt: '2026-07-20T12:00:00.000Z',
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.comments).toHaveLength(1);
      expect(r.value.comments![0]!.quote).toBe('Title');
    }
  });

  it('accepts non-RFC hex UUID comment ids (agent-minted)', () => {
    // Fails strict v4 (version/variant nibbles) but is a valid 8-4-4-4-12 hex form
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: 'x',
      comments: [
        {
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          body: 'ok',
          author: 'agent',
          createdAt: '2026-07-20T12:00:00.000Z',
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects comment with bad author', () => {
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: 'x',
      comments: [
        {
          id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          body: 'nope',
          author: 'bot',
          createdAt: '2026-07-20T12:00:00.000Z',
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects comments in props', () => {
    const r = validateRichDocumentProps({ comments: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects control characters in markdown', () => {
    const r = validateRichDocumentState({
      format: RICH_DOCUMENT_FORMAT,
      markdown: 'a\x00b',
    });
    expect(r.ok).toBe(false);
  });

  it('kind validator is wired', () => {
    expect(validateKindState('rich-document', { format: RICH_DOCUMENT_FORMAT, markdown: '' }).ok).toBe(
      true,
    );
    expect(validateKindState('rich-document', { markdown: '' }).ok).toBe(false);
    expect(validateKindState('floor-plan-3d', { anything: true }).ok).toBe(true);
  });
});

describe('rich-document props', () => {
  it('accepts empty props', () => {
    expect(validateRichDocumentProps({}).ok).toBe(true);
  });

  it('accepts mode edit/view', () => {
    expect(validateRichDocumentProps({ mode: 'edit' }).ok).toBe(true);
    expect(validateRichDocumentProps({ mode: 'view' }).ok).toBe(true);
    expect(validateRichDocumentProps({ mode: 'bogus' }).ok).toBe(false);
  });

  it('rejects body keys in props', () => {
    const r = validateRichDocumentProps({ markdown: '# no' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/document body\/comments in state|state\.markdown/);
  });

  it('kind props validator is wired', () => {
    expect(validateKindProps('rich-document', { mode: 'edit' }).ok).toBe(true);
    expect(validateKindProps('rich-document', { content: 'x' }).ok).toBe(false);
  });
});

describe('open_external url validation', () => {
  it('accepts https', () => {
    expect(validateExternalOpenUrl('https://example.com/a').ok).toBe(true);
  });

  it('rejects javascript and relative', () => {
    expect(validateExternalOpenUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateExternalOpenUrl('/relative').ok).toBe(false);
  });

  it('rejects userinfo', () => {
    expect(validateExternalOpenUrl('https://user:pass@example.com/').ok).toBe(false);
  });

  it('rejects overlong urls', () => {
    expect(validateExternalOpenUrl('https://x.com/' + 'a'.repeat(2100)).ok).toBe(false);
  });
});

describe('platform-assets allowlist', () => {
  it('allows platform widget html entry', () => {
    expect(
      isAllowedWidgetEntryUrl('/platform-assets/widgets/rich-document/index.html', {
        viewerSlug: '',
        agentKey: null,
      }),
    ).toBe(true);
  });

  it('rejects platform non-html and traversal', () => {
    expect(
      isAllowedWidgetEntryUrl('/platform-assets/widgets/rich-document/main.js', {
        viewerSlug: '',
        agentKey: null,
      }),
    ).toBe(false);
    expect(
      isAllowedWidgetEntryUrl('/platform-assets/widgets/../secret/index.html', {
        viewerSlug: '',
        agentKey: null,
      }),
    ).toBe(false);
  });
});

describe('resolvePlatformWidgetsDistDirFrom', () => {
  it('finds first existing candidate', () => {
    const base = mkdtempSync(join(tmpdir(), 'utarus-pw-'));
    try {
      const a = join(base, 'a');
      const b = join(base, 'b');
      mkdirSync(a);
      // moduleDir such that ../platform-widgets = a when we use custom layout
      // candidates: moduleDir/../platform-widgets, moduleDir/../../dist/platform-widgets
      const moduleDir = join(base, 'mod', 'sub');
      mkdirSync(moduleDir, { recursive: true });
      const cand1 = join(base, 'mod', 'platform-widgets');
      mkdirSync(cand1);
      writeFileSync(join(cand1, 'marker'), '1');
      const found = resolvePlatformWidgetsDistDirFrom(moduleDir);
      expect(found).toBe(cand1);
      void b;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
