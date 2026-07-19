/**
 * Maps enablement — shared by show_map tool and GET /api/maps/config.
 * Fail-fast: no silent enable; flag must be exactly "true" and key non-empty.
 */

export type MapsHttpConfigResult =
  | { kind: 'disabled' }
  | { kind: 'ok'; embedApiKey: string }
  | { kind: 'misconfigured'; message: string };

function flagEnabled(): boolean {
  return process.env.UTARUS_MAPS_ENABLED === 'true';
}

function rawKey(): string {
  const k = process.env.GOOGLE_MAPS_EMBED_API_KEY;
  if (typeof k !== 'string') return '';
  return k.trim();
}

/**
 * True only when maps are fully usable for the tool path:
 * UTARUS_MAPS_ENABLED === "true" AND non-empty GOOGLE_MAPS_EMBED_API_KEY.
 */
export function isMapsEnabled(): boolean {
  return flagEnabled() && rawKey().length > 0;
}

/**
 * Returns trimmed embed key or throws with a clear message.
 */
export function getEmbedApiKeyOrThrow(): string {
  if (!flagEnabled()) {
    throw new Error('Maps are not enabled on this server (UTARUS_MAPS_ENABLED is not true)');
  }
  const key = rawKey();
  if (!key) {
    throw new Error(
      'Maps misconfigured: UTARUS_MAPS_ENABLED=true but GOOGLE_MAPS_EMBED_API_KEY is empty',
    );
  }
  return key;
}

/**
 * HTTP config resolution — distinguishes disabled (200) vs misconfigured (500).
 */
export function resolveMapsHttpConfig(): MapsHttpConfigResult {
  if (!flagEnabled()) {
    return { kind: 'disabled' };
  }
  const key = rawKey();
  if (!key) {
    return {
      kind: 'misconfigured',
      message:
        'UTARUS_MAPS_ENABLED=true but GOOGLE_MAPS_EMBED_API_KEY is missing or empty',
    };
  }
  return { kind: 'ok', embedApiKey: key };
}
