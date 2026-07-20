/**
 * InfoCardDeck visual-order pure helpers (mirrored from web/src/cards/deck-order.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  toFront,
  cycleSelection,
  initialVisualOrder,
} from '../web/src/cards/deck-order.js';

describe('deck-order', () => {
  it('initialVisualOrder is 0..n-1', () => {
    expect(initialVisualOrder(3)).toEqual([0, 1, 2]);
  });

  it('toFront moves data index to end', () => {
    expect(toFront([0, 1, 2], 0)).toEqual([1, 2, 0]);
    expect(toFront([0, 1, 2], 2)).toEqual([0, 1, 2]);
  });

  it('cycleSelection walks visual order', () => {
    const order = [0, 1, 2];
    expect(cycleSelection(order, 2, -1)).toBe(1);
    expect(cycleSelection(order, 0, 1)).toBe(1);
    expect(cycleSelection(order, 2, 1)).toBe(2);
    expect(cycleSelection(order, 0, -1)).toBe(0);
  });
});
