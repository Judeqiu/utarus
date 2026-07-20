/**
 * Pure helpers for InfoCardDeck visual order (unit-testable).
 */

/** Move dataIndex to the front (end of visualOrder). No-op if already front. */
export function toFront(visualOrder: number[], dataIndex: number): number[] {
  const without = visualOrder.filter((i) => i !== dataIndex);
  return [...without, dataIndex];
}

/**
 * Cycle selection along visual order.
 * dir +1 → toward front (higher visual index); dir -1 → toward back.
 */
export function cycleSelection(
  visualOrder: number[],
  selectedDataIndex: number,
  dir: 1 | -1,
): number {
  const v = visualOrder.indexOf(selectedDataIndex);
  if (v < 0) return selectedDataIndex;
  const next = Math.max(0, Math.min(visualOrder.length - 1, v + dir));
  return visualOrder[next]!;
}

/** Initial visual order: [0..N-1], last card starts in front. */
export function initialVisualOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
