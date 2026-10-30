'use client';

import { useMemo, useState } from 'react';
import { usePlannerStore } from '@/lib/planner-store';
import { useOpenConsole } from '@/lib/console-door';
import { toDateStr } from '@/lib/recurrence';
import { CARD_DAYS, cardLine, habitCards, xCount, type XCard, type XEffectHabit } from '@/lib/x-effect';
import { useXEffectSince } from '@/lib/x-effect-since';
import { BandLabel } from '@/components/planner/item-bands';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The X effect extension's surfaces (lib/x-effect.ts): a habit's card in its
 * panel, and the card shapes Organize's Cards section draws.
 *
 * The no-guilt rules are in the drawing, so they live here too:
 *   - a past day it wasn't done is plain paper, never a mark, never a colour;
 *   - a skip is the day-off dash, an off day a printed dot;
 *   - the X is pen ink, and lime is spent only on today's square;
 *   - the only count shown is X's, never misses.
 */

const LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function weekdayLetter(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return LETTERS[new Date(y, m - 1, d).getDay()];
}

/** A small, stable wobble per date, so the X's look drawn rather than stamped. */
function jitter(date: string, k: number): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) | 0;
  const x = Math.sin(h * 0.001 + k * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 3;
}

function PenX({ date, draw }: { date: string; draw?: boolean }) {
  const j = (k: number) => jitter(date, k).toFixed(1);
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn('size-[72%] overflow-visible', draw && 'x-effect-draw')}
      data-x-effect-x=""
    >
      <path
        d={`M${4 + +j(1)} ${4 + +j(2)} Q12 ${11 + +j(3)} ${20 + +j(4)} ${20 + +j(5)}`}
        className="fill-none stroke-current"
        strokeWidth={2.1}
        strokeLinecap="round"
      />
      <path
        d={`M${20 + +j(6)} ${4 + +j(7)} Q${12 + +j(8)} 12 ${4 + +j(9)} ${20 + +j(10)}`}
        className="fill-none stroke-current"
        strokeWidth={2.1}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The 7 by 7 grid. `labels` adds weekday letters over the columns and week
 * numbers down the side (the panel's full size); the shelf leaves them off.
 * `drawDate` is a date whose X should arrive with a pen stroke.
 */
export function XCardGrid({
  card,
  labels = false,
  drawDate,
}: {
  card: XCard;
  labels?: boolean;
  drawDate?: string | null;
}) {
  return (
    <div
      className={cn('grid items-center', labels ? 'grid-cols-[auto_repeat(7,1fr)]' : 'grid-cols-7')}
      data-testid="x-effect-grid"
    >
      {labels && (
        <>
          <span />
          {card.cells.slice(0, 7).map((c) => (
            <span key={c.date} className="text-muted-foreground pb-[3px] text-center font-mono text-[9.5px]">
              {weekdayLetter(c.date)}
            </span>
          ))}
        </>
      )}
      {card.cells.map((cell, i) => {
        const row = Math.floor(i / 7);
        const col = i % 7;
        return (
          <FragmentRow key={cell.date} label={labels && col === 0 ? row + 1 : null}>
            <div
              title={cell.date}
              data-x-effect-cell={cell.state}
              data-today={cell.today ? '' : undefined}
              className={cn(
                'border-border/70 text-foreground/85 relative flex aspect-square items-center justify-center border-r border-b',
                col === 0 && 'border-l',
                row === 0 && 'border-t',
                cell.today && 'bg-primary/15 after:ring-primary after:pointer-events-none after:absolute after:-inset-px after:rounded-[3px] after:ring-[1.5px]'
              )}
            >
              {cell.state === 'x' && <PenX date={cell.date} draw={cell.date === drawDate} />}
              {cell.state === 'rest' && <span className="bg-day-off h-[2px] w-[34%] rounded-full" />}
              {cell.state === 'off' && <span className="bg-day-off size-[3px] rounded-full" />}
            </div>
          </FragmentRow>
        );
      })}
    </div>
  );
}

function FragmentRow({ label, children }: { label: number | null; children: React.ReactNode }) {
  return (
    <>
      {label !== null && (
        <span className="text-muted-foreground pr-1.5 text-right font-mono text-[9.5px]">{label}</span>
      )}
      {children}
    </>
  );
}

/** A filed card as a 44px thumbnail: its X's as ink, everything else paper. */
export function XCardThumb({ card }: { card: XCard }) {
  return (
    <span
      aria-hidden
      className="bg-card border-border grid w-11 shrink-0 grid-cols-7 gap-px rounded-[6px] border p-1"
    >
      {card.cells.map((c) => (
        <i key={c.date} className={cn('aspect-square rounded-[1px]', c.state === 'x' ? 'bg-foreground/75' : 'bg-border/70')} />
      ))}
    </span>
  );
}

/** The habit's cards as of today, or [] while X effect is off or no card has begun. */
export function useHabitCards(habit: XEffectHabit | null): { cards: XCard[]; since: string | null; today: string } {
  const userId = usePlannerStore((s) => s.userId);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const since = useXEffectSince(userId);
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = toDateStr(new Date(), tz);
  const cards = useMemo(
    () => (habit && since ? habitCards(habit, since, today, tz) : []),
    [habit, since, today, tz]
  );
  return { cards, since, today };
}

/**
 * Today's date once today gains an X while the card is on screen, so only a
 * tick made here and now gets the pen stroke, never a card that opens already
 * crossed. React's "previous value in state" pattern, not an effect.
 */
function useDrawToday(card: XCard | undefined, today: string): string | null {
  const todayX = !!card?.cells.some((c) => c.today && c.state === 'x');
  const [prev, setPrev] = useState(todayX);
  const [draw, setDraw] = useState(false);
  if (todayX !== prev) {
    setPrev(todayX);
    setDraw(todayX);
  }
  return draw ? today : null;
}

/** How many filed cards the panel shows as thumbnails, newest last. */
const PANEL_FILED = 6;

/**
 * The panel's section: the current card with labels, then filed cards as
 * thumbnails and a way to Organize's Cards. Before the first card has begun it
 * says when it will, in one line, rather than showing an empty grid.
 */
export function XEffectSection({ item }: { item: Item }) {
  const habit = item as unknown as XEffectHabit;
  const { cards, since, today } = useHabitCards(habit);
  const openConsole = useOpenConsole();
  const current = cards[cards.length - 1];
  const drawDate = useDrawToday(current, today);
  if (!since) return null;

  const filed = cards.slice(0, -1);
  return (
    <div className="flex flex-col gap-2" data-testid="x-effect-section">
      <div className="flex items-baseline justify-between">
        <BandLabel>X effect</BandLabel>
        <span className="text-muted-foreground/70 font-mono text-[10px]">
          {CARD_DAYS} days, one X a day
        </span>
      </div>
      {current ? (
        <div className="bg-card border-border rounded-[12px] border px-3 pt-2.5 pb-2 shadow-[var(--shadow-elev-bar)]">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold" data-testid="x-effect-line">
              {cardLine(current)}
            </span>
            <span className="text-muted-foreground font-mono text-[10.5px] tabular-nums">
              {xCount(current.xs)}
            </span>
          </div>
          <XCardGrid card={current} labels drawDate={drawDate} />
        </div>
      ) : (
        <p className="text-muted-foreground text-xs" data-testid="x-effect-waiting">
          Your first card starts the next time you tick this.
        </p>
      )}
      {(filed.length > 0 || current) && (
        <div className="flex items-center gap-2">
          {filed.length > 0 && (
            <>
              <span className="text-muted-foreground font-mono text-[10px]">Filed</span>
              {filed.slice(-PANEL_FILED).map((c) => (
                <XCardThumb key={c.number} card={c} />
              ))}
            </>
          )}
          <button
            type="button"
            onClick={() => openConsole({ section: 'cards', focusId: item.id })}
            className="text-muted-foreground hover:text-foreground ml-auto text-[11px] underline-offset-2 hover:underline"
            data-testid="x-effect-all-cards"
          >
            All cards
          </button>
        </div>
      )}
    </div>
  );
}
