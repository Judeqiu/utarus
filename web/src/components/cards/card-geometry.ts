/**
 * Poker-card geometry (portrait). Standard playing card is ~2.5×3.5 (5:7);
 * we use a slightly taller face so body copy has room.
 */

/** Face width (px). */
export const CARD_WIDTH_PX = 240;

/** Face height (px) — portrait, taller than wide. */
export const CARD_HEIGHT_PX = 360;

/** Horizontal rest stack step (collapsed / space-saving). */
export const REST_STEP_PX = 16;

/** Horizontal fan step (collapsed hover). */
export const FAN_STEP_PX = 40;

/** Slight vertical stagger so the hand reads as a poker fan. */
export const REST_LIFT_PX = 4;

export const FAN_LIFT_PX = 10;

/**
 * Expanded cascade: gap between fully visible cards (no content hiding).
 * Total width ≈ n * CARD_WIDTH + (n - 1) * EXPANDED_GAP_PX
 */
export const EXPANDED_GAP_PX = 16;

/** Mild vertical stagger in expanded cascade (poker-hand feel without overlap). */
export const EXPANDED_LIFT_PX = 6;

/** Width needed to show all cards fully visible with gaps. */
export function expandedDeckWidth(cardCount: number): number {
  if (cardCount <= 0) return 0;
  if (cardCount === 1) return CARD_WIDTH_PX;
  return cardCount * CARD_WIDTH_PX + (cardCount - 1) * EXPANDED_GAP_PX;
}

/** Width of collapsed rest stack (only peeks for back cards). */
export function collapsedDeckWidth(cardCount: number, step: number = REST_STEP_PX): number {
  if (cardCount <= 0) return 0;
  return CARD_WIDTH_PX + (cardCount - 1) * step;
}
