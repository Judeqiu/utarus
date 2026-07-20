/**
 * Platform kind state/props validators.
 * Domain kinds have no entry here (K24 structural-only props).
 */

import {
  validateRichDocumentProps,
  validateRichDocumentState,
} from './kinds/rich-document-state.js';

export type KindValidateResult =
  | { ok: true }
  | { ok: false; error: string };

type Validator = (data: unknown) => KindValidateResult;

function wrapState(
  fn: (data: unknown) => { ok: true; value: unknown } | { ok: false; error: string },
): Validator {
  return (data) => {
    const r = fn(data);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };
}

function wrapProps(
  fn: (data: unknown) => { ok: true; value: unknown } | { ok: false; error: string },
): Validator {
  return (data) => {
    const r = fn(data);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };
}

export const PLATFORM_KIND_STATE_VALIDATORS: Readonly<Record<string, Validator>> = {
  'rich-document': wrapState(validateRichDocumentState),
};

export const PLATFORM_KIND_PROPS_VALIDATORS: Readonly<Record<string, Validator>> = {
  'rich-document': wrapProps(validateRichDocumentProps),
};

/** Validate state for a kind when a platform validator is registered. */
export function validateKindState(kind: string, data: unknown): KindValidateResult {
  const v = PLATFORM_KIND_STATE_VALIDATORS[kind];
  if (!v) return { ok: true };
  return v(data);
}

/** Validate props for a kind when a platform validator is registered. */
export function validateKindProps(kind: string, props: unknown): KindValidateResult {
  const v = PLATFORM_KIND_PROPS_VALIDATORS[kind];
  if (!v) return { ok: true };
  return v(props);
}
