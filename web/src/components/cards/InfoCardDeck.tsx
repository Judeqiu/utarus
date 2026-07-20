/**
 * Multi-card deck:
 * - Expanded: when horizontal space is enough, cascade all faces fully visible.
 * - Collapsed: when space is tight, poker stack / fan.
 *
 * Selection invariant: exactly one selectedDataIndex; in collapsed mode the
 * selected card is always front of visualOrder (promote on select).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';
import type { InfoCardDeckSpec } from '../../cards/card-spec.js';
import {
  cycleSelection,
  initialVisualOrder,
  toFront,
} from '../../cards/deck-order.js';
import { InfoCard } from './InfoCard.js';
import {
  CARD_HEIGHT_PX,
  CARD_WIDTH_PX,
  EXPANDED_GAP_PX,
  EXPANDED_LIFT_PX,
  expandedDeckWidth,
  FAN_LIFT_PX,
  FAN_STEP_PX,
  REST_LIFT_PX,
  REST_STEP_PX,
} from './card-geometry.js';

const DRAG_AXIS_THRESHOLD_PX = 8;
const DRAG_PROMOTE_RATIO = 0.4;

type DeckMode = 'rest' | 'fan' | 'selected' | 'dragging';
type DeckLayout = 'expanded' | 'collapsed';

interface DragState {
  pointerId: number;
  originX: number;
  originY: number;
  dx: number;
  dataIndex: number;
  axis: 'undecided' | 'horizontal' | 'vertical';
}

function useContainerWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      setWidth(w > 0 ? w : 0);
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

function isBodyScrollTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-info-card-body-scroll]') != null
  );
}

export function InfoCardDeck({ spec }: { spec: InfoCardDeckSpec }) {
  const n = spec.cards.length;
  const [visualOrder, setVisualOrder] = useState(() => initialVisualOrder(n));
  const [selectedDataIndex, setSelectedDataIndex] = useState(() => n - 1);
  const [mode, setMode] = useState<DeckMode>('rest');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [liveText, setLiveText] = useState('');
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const selectedRef = useRef(selectedDataIndex);
  const visualOrderRef = useRef(visualOrder);
  const modeRef = useRef(mode);
  selectedRef.current = selectedDataIndex;
  visualOrderRef.current = visualOrder;
  modeRef.current = mode;

  const reducedMotion = usePrefersReducedMotion();
  const availableWidth = useContainerWidth(deckRef);

  const needExpanded = expandedDeckWidth(n);
  const layout: DeckLayout =
    availableWidth === 0
      ? n <= 2
        ? 'expanded'
        : 'collapsed'
      : availableWidth >= needExpanded
        ? 'expanded'
        : 'collapsed';
  const isExpanded = layout === 'expanded';
  const isExpandedRef = useRef(isExpanded);
  isExpandedRef.current = isExpanded;

  const deckKey = useMemo(
    () => JSON.stringify(spec.cards.map((c) => c.title)),
    [spec.cards],
  );
  useEffect(() => {
    const order = initialVisualOrder(n);
    const sel = n - 1;
    setVisualOrder(order);
    setSelectedDataIndex(sel);
    setMode('rest');
    setDrag(null);
    selectedRef.current = sel;
    visualOrderRef.current = order;
  }, [deckKey, n]);

  useEffect(() => {
    if (isExpanded) {
      setDrag(null);
      setMode((m) => (m === 'dragging' || m === 'fan' ? 'rest' : m));
    }
  }, [isExpanded]);

  const announce = useCallback(
    (dataIndex: number, order: number[]) => {
      const title = spec.cards[dataIndex]?.title ?? '';
      const position = isExpandedRef.current
        ? dataIndex + 1
        : order.indexOf(dataIndex) + 1;
      setLiveText(`Selected: ${title} (${position} of ${n})`);
    },
    [n, spec.cards],
  );

  const focusCard = useCallback((dataIndex: number) => {
    queueMicrotask(() => {
      cardRefs.current.get(dataIndex)?.focus({ preventScroll: true });
    });
  }, []);

  /**
   * Single select path — always ends with exactly one selected card.
   * Collapsed: also promotes to front so front === selected.
   */
  const selectCard = useCallback(
    (dataIndex: number, opts?: { focus?: boolean }) => {
      if (dataIndex < 0 || dataIndex >= n) return;
      const expanded = isExpandedRef.current;

      if (expanded) {
        setSelectedDataIndex(dataIndex);
        selectedRef.current = dataIndex;
        setMode('selected');
        modeRef.current = 'selected';
        setDrag(null);
        announce(dataIndex, visualOrderRef.current);
      } else {
        const nextOrder = toFront(visualOrderRef.current, dataIndex);
        setVisualOrder(nextOrder);
        visualOrderRef.current = nextOrder;
        setSelectedDataIndex(dataIndex);
        selectedRef.current = dataIndex;
        setMode('selected');
        modeRef.current = 'selected';
        setDrag(null);
        announce(dataIndex, nextOrder);
      }

      if (opts?.focus !== false) focusCard(dataIndex);
    },
    [announce, focusCard, n],
  );

  const onKeyDownDeck = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setMode('rest');
      modeRef.current = 'rest';
      (document.activeElement as HTMLElement | null)?.blur();
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir: 1 | -1 = e.key === 'ArrowRight' ? 1 : -1;
      if (isExpandedRef.current) {
        const cur = selectedRef.current;
        const next = Math.max(0, Math.min(n - 1, cur + dir));
        selectCard(next);
      } else {
        const nextSel = cycleSelection(
          visualOrderRef.current,
          selectedRef.current,
          dir,
        );
        // Promote so selected is always front — one visual "active" card
        selectCard(nextSel);
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Home' || e.key === 'End') {
      if (isExpandedRef.current) {
        selectCard(e.key === 'Home' ? 0 : n - 1);
      } else {
        const order = visualOrderRef.current;
        selectCard(e.key === 'Home' ? order[0]! : order[order.length - 1]!);
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      selectCard(selectedRef.current);
      e.preventDefault();
    }
  };

  const onPointerDownCard = (dataIndex: number, e: ReactPointerEvent) => {
    if (e.button !== 0) return;

    // Expanded: select immediately (works even when click starts on body text).
    if (isExpandedRef.current) {
      selectCard(dataIndex);
      return;
    }

    // Collapsed: don't start drag from body scroll area — still select/promote.
    if (isBodyScrollTarget(e.target)) {
      selectCard(dataIndex);
      return;
    }

    const order = visualOrderRef.current;
    const front = order[n - 1];
    if (modeRef.current === 'rest' && dataIndex !== front) {
      // Clicking a peek in rest: promote immediately
      selectCard(dataIndex);
      return;
    }

    setDrag({
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      dx: 0,
      dataIndex,
      axis: 'undecided',
    });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (isExpandedRef.current || !drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.originX;
    const dy = e.clientY - drag.originY;

    if (drag.axis === 'undecided') {
      if (Math.hypot(dx, dy) < DRAG_AXIS_THRESHOLD_PX) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical → treat as click/select, cancel drag
        const idx = drag.dataIndex;
        setDrag(null);
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        selectCard(idx);
        return;
      }
      setDrag({ ...drag, axis: 'horizontal', dx });
      setMode('dragging');
      modeRef.current = 'dragging';
      return;
    }
    if (drag.axis === 'vertical') return;
    setDrag({ ...drag, dx });
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (isExpandedRef.current) return;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { dataIndex, dx, axis } = drag;
    setDrag(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    if (axis === 'horizontal' && Math.abs(dx) > DRAG_PROMOTE_RATIO * CARD_WIDTH_PX) {
      selectCard(dataIndex);
      return;
    }
    // Click or short drag → select/promote
    if (axis === 'undecided' || Math.abs(dx) < DRAG_AXIS_THRESHOLD_PX) {
      selectCard(dataIndex);
      return;
    }
    // Cancelled drag: keep previous selection; return to fan if hovering
    const over = deckRef.current?.matches(':hover');
    setMode(over ? 'fan' : 'selected');
    modeRef.current = over ? 'fan' : 'selected';
  };

  // Avoid double-firing: pointer path already selects; swallow click.
  const onClickCard = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const isFanned =
    !isExpanded &&
    (mode === 'fan' || mode === 'selected' || mode === 'dragging');
  const step = isExpanded
    ? CARD_WIDTH_PX + EXPANDED_GAP_PX
    : isFanned
      ? FAN_STEP_PX
      : REST_STEP_PX;
  const lift = isExpanded
    ? EXPANDED_LIFT_PX
    : isFanned
      ? FAN_LIFT_PX
      : REST_LIFT_PX;

  const trackWidth = isExpanded
    ? needExpanded
    : CARD_WIDTH_PX + (n - 1) * step;
  const padRight = isExpanded ? 8 : 24;
  const padBottom = isExpanded ? 20 : isFanned ? 56 : 28;
  const padTop = isExpanded ? 12 : isFanned ? 20 : 8;
  const staggerExtra = isExpanded ? (n - 1) * lift + 8 : 0;
  const viewportHeight = CARD_HEIGHT_PX + padTop + padBottom + staggerExtra;

  const transition = reducedMotion
    ? 'none'
    : 'transform 200ms ease, filter 200ms ease, box-shadow 200ms ease';

  const hint = isExpanded
    ? `${n} cards · fully spread · click to select`
    : `${n} cards · stacked to fit · click or arrows to select`;

  return (
    <div
      {...CHAT_EMBED_PROPS}
      ref={deckRef}
      data-info-card-deck
      data-deck-layout={layout}
      role="group"
      aria-label={`Information cards, ${n} items, ${layout} layout`}
      className="info-card-deck relative my-4 w-full max-w-full isolate touch-pan-y outline-none"
      style={{
        minHeight: viewportHeight,
        paddingTop: padTop,
        paddingRight: padRight,
        paddingBottom: padBottom,
      }}
      onMouseEnter={() => {
        if (!isExpanded && modeRef.current === 'rest') {
          setMode('fan');
          modeRef.current = 'fan';
        }
      }}
      onMouseLeave={() => {
        if (
          !isExpanded &&
          modeRef.current === 'fan' &&
          !drag
        ) {
          // Keep selection; leave fan chrome for rest stack (selected still front)
          setMode('selected');
          modeRef.current = 'selected';
        }
      }}
      onFocusCapture={() => {
        if (!isExpanded && modeRef.current === 'rest') {
          setMode('fan');
          modeRef.current = 'fan';
        }
      }}
      onKeyDown={onKeyDownDeck}
    >
      <div
        className="relative"
        style={{ width: trackWidth, height: CARD_HEIGHT_PX + staggerExtra }}
      >
        {spec.cards.map((card, dataIndex) => {
          const isSelected = dataIndex === selectedDataIndex;

          let translateX: number;
          let translateY: number;
          let rotate: number;
          let z: number;
          let pointerEvents: CSSProperties['pointerEvents'] = 'auto';

          if (isExpanded) {
            translateX = dataIndex * step;
            translateY = dataIndex * lift;
            rotate = 0;
            // Selected always on top; others by data index
            z = isSelected ? n + 2 : dataIndex + 1;
            if (isSelected) translateY -= 8;
          } else {
            const v = visualOrder.indexOf(dataIndex);
            const isFront = v === n - 1;
            // Front (=== selected after promote) gets top z
            z = v + 1;
            const mid = (n - 1) / 2;
            rotate = (v - mid) * 2.5;
            // Only the selected (front) card sits flat
            if (isSelected) rotate = 0;
            translateX = v * step;
            translateY = (n - 1 - v) * lift;
            if (isFanned && isSelected) translateY -= 14;
            if (drag && drag.dataIndex === dataIndex && drag.axis === 'horizontal') {
              translateX += drag.dx;
              translateY -= 10;
            }
            if (mode === 'rest' && !isFront) pointerEvents = 'none';
            if (mode === 'dragging' && drag && drag.dataIndex !== dataIndex) {
              pointerEvents = 'none';
            }
          }

          const style: CSSProperties = {
            position: 'absolute',
            left: 0,
            top: 0,
            width: CARD_WIDTH_PX,
            height: CARD_HEIGHT_PX,
            maxWidth: CARD_WIDTH_PX,
            boxSizing: 'border-box',
            zIndex: z,
            transform: `translate(${translateX}px, ${translateY}px) rotate(${rotate}deg)`,
            transition:
              !isExpanded && mode === 'dragging' && drag?.dataIndex === dataIndex
                ? 'none'
                : transition,
            pointerEvents,
            touchAction:
              !isExpanded && mode === 'dragging' && drag?.dataIndex === dataIndex
                ? 'none'
                : undefined,
          };

          return (
            <div
              key={dataIndex}
              ref={(el) => {
                cardRefs.current.set(dataIndex, el);
              }}
              style={style}
              className="box-border min-w-0 will-change-transform"
              data-selected={isSelected ? '1' : '0'}
            >
              <InfoCard
                card={card}
                embedded
                interactive
                selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                aria-pressed={isSelected}
                onClick={onClickCard}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    selectCard(dataIndex);
                    ev.preventDefault();
                    ev.stopPropagation();
                  }
                }}
                onPointerDown={(ev) => onPointerDownCard(dataIndex, ev)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">{hint}</div>
      <div className="sr-only" aria-live="polite">
        {liveText}
      </div>
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const fn = () => setReduced(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return reduced;
}
