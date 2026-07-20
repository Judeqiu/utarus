/**
 * Single designed information card — portrait poker-card proportions.
 */

import type { CSSProperties } from 'react';
import { CHAT_EMBED_PROPS } from '../../embeds/chat-embed.js';
import type { BadgeTone, InfoCardSpec } from '../../cards/card-spec.js';
import { CardBodyMarkdown } from './CardBodyMarkdown.js';
import { CARD_ICON_MAP } from './card-icons.js';
import { CARD_HEIGHT_PX, CARD_WIDTH_PX } from './card-geometry.js';

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200',
  success: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  warning: 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  danger: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
  info: 'bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
};

export interface InfoCardProps {
  card: InfoCardSpec;
  /** When true, skip CHAT_EMBED_PROPS (deck root owns embed unwrap). */
  embedded?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Interactive face inside a deck. */
  interactive?: boolean;
  /** Deck selection chrome (exactly one face should be true). */
  selected?: boolean;
  tabIndex?: number;
  role?: string;
  'aria-pressed'?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
  onPointerCancel?: (e: React.PointerEvent) => void;
}

export function InfoCard({
  card,
  embedded = false,
  className = '',
  style,
  interactive = false,
  selected = false,
  tabIndex,
  role,
  'aria-pressed': ariaPressed,
  onClick,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: InfoCardProps) {
  const Icon = card.icon ? CARD_ICON_MAP[card.icon] : null;
  const accentStyle: CSSProperties | undefined =
    card.accent !== undefined
      ? ({ ['--info-card-accent' as string]: card.accent } as CSSProperties)
      : undefined;
  const mergedStyle: CSSProperties = {
    width: CARD_WIDTH_PX,
    height: CARD_HEIGHT_PX,
    maxWidth: CARD_WIDTH_PX,
    ...accentStyle,
    ...style,
  };

  const chrome = (
    <div className="info-card-face flex h-full min-h-0 min-w-0 flex-col">
      {/* Header */}
      <div className="flex min-w-0 shrink-0 items-start gap-2.5">
        {Icon && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1 overflow-hidden pt-0.5">
          <div className="line-clamp-2 text-sm font-semibold leading-snug text-stone-900 dark:text-stone-50">
            {card.title}
          </div>
          {card.subtitle && (
            <div className="mt-0.5 line-clamp-2 text-xs text-stone-500 dark:text-stone-400">
              {card.subtitle}
            </div>
          )}
        </div>
      </div>

      {card.badges && card.badges.length > 0 && (
        <div className="mt-3 flex min-w-0 shrink-0 flex-wrap gap-1.5">
          {card.badges.map((b, i) => {
            const tone = b.tone;
            const toneClass =
              tone === 'success' ||
              tone === 'warning' ||
              tone === 'danger' ||
              tone === 'info'
                ? BADGE_TONE_CLASS[tone]
                : BADGE_TONE_CLASS.neutral;
            return (
              <span
                key={`${b.label}-${i}`}
                className={`inline-flex max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toneClass}`}
              >
                {b.label}
              </span>
            );
          })}
        </div>
      )}

      {card.fields && card.fields.length > 0 && (
        <dl className="mt-3 min-w-0 shrink-0 space-y-2 border-t border-stone-100 pt-3 dark:border-stone-800">
          {card.fields.map((f, i) => (
            <div key={`${f.label}-${i}`} className="flex min-w-0 flex-col gap-0.5 text-xs">
              <dt className="truncate font-medium uppercase tracking-wide text-[10px] text-stone-400 dark:text-stone-500">
                {f.label}
              </dt>
              <dd className="min-w-0 break-words text-sm font-medium text-stone-800 dark:text-stone-100">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Body fills remaining portrait space */}
      {card.body !== undefined && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-stone-100 pt-3 dark:border-stone-800">
          <CardBodyMarkdown body={card.body} fill />
        </div>
      )}

      {card.footer && (
        <div className="mt-auto min-w-0 shrink-0 truncate border-t border-stone-100 pt-2.5 text-[11px] text-stone-400 dark:border-stone-800 dark:text-stone-500">
          {card.footer}
        </div>
      )}
    </div>
  );

  const baseClass =
    'info-card info-card--portrait rounded-2xl border bg-white p-4 text-left ' +
    'border-t-4 border-t-[color:var(--info-card-accent,theme(colors.stone.300))] ' +
    'dark:bg-stone-900 ' +
    (selected
      ? 'border-stone-400 shadow-lg ring-2 ring-sky-500 ring-offset-2 dark:border-stone-500 dark:ring-sky-400 dark:ring-offset-stone-950 '
      : 'border-stone-200 shadow-sm dark:border-stone-700 ') +
    className;

  if (interactive) {
    return (
      <div
        className={
          baseClass +
          ' cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-sky-500'
        }
        style={mergedStyle}
        role={role ?? 'button'}
        tabIndex={tabIndex}
        aria-pressed={ariaPressed ?? selected}
        data-selected={selected ? 'true' : 'false'}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {chrome}
      </div>
    );
  }

  return (
    <article
      {...(embedded ? {} : CHAT_EMBED_PROPS)}
      data-info-card
      className={baseClass + (embedded ? '' : ' my-3')}
      style={mergedStyle}
    >
      {chrome}
    </article>
  );
}
