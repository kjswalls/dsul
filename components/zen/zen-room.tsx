'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useViewStore } from '@/lib/view-store';
import { useUIStore } from '@/lib/ui-store';
import { useDayItemsForDates } from '@/hooks/use-day-items';
import { useNowMinutes } from '@/lib/use-now-minutes';
import { useStreaksEnabled } from '@/lib/extension-gates';
import { setHoveredItemRef } from '@/lib/hovered-item';
import { isRowDone, isRowSkipped, toggleRowDone } from '@/lib/item-toggle';
import {
  clockOf,
  elapsedPct,
  formatRemaining,
  heroKicker,
  heroTimeLabel,
  minutesOf,
  multiCount,
  pickHero,
  remainingMins,
  zenRows,
  type ZenRow,
} from '@/lib/zen';
import { toDateStr } from '@/lib/recurrence';
import { prefersReducedMotion } from '@/lib/zen-transition';
import { cn } from '@/lib/utils';

/**
 * Zen — the room.
 *
 * One thing, set large, on an otherwise empty screen, with the rest of the day
 * folded away beneath it. Entered with `z` (lib/commands/registry.ts), left with
 * Escape or the hint at the bottom, and persisted in view-store so a reload
 * mid-session lands you back in here rather than in the full planner.
 *
 * Three rules hold this together, and each is load-bearing:
 *
 * 1. IT IS A LENS, NEVER A SECOND SOURCE. Everything shown comes out of
 *    `useDayItemsForDates`, the same derivation the six canvas views use, so
 *    Zen inherits the suppression, filter and recurrence rules already settled
 *    in lib/active.ts and lib/day-items.ts. It adds no "does this want doing"
 *    logic of its own — a room that argued with the grid would be a second
 *    definition of the day. Ordering and the hero pick live in lib/zen.ts.
 * 2. IT IS ALWAYS TODAY. Every other surface follows the navigable
 *    `selectedDate`; this one does not. "Now" means nothing on a day that is not
 *    today, and a hero reading NOW over next Tuesday's 9am block would be a lie.
 *    Consequence, and it is the sharp one: every tick must name THIS date
 *    explicitly, because the store's default is `selectedDate` — ticking in here
 *    while the canvas sits on Tuesday would otherwise mark Tuesday.
 * 3. IT SITS BESIDE THE DIALOG SLOT, NOT IN IT. Zen is a view-store flag rather
 *    than an `activeDialog` variant, so ⌘K, quick-add and the item editor open
 *    ON TOP of the room and closing them returns to it. Capture never costs you
 *    the room. app-shell renders the edit dialog as a modal while Zen is open,
 *    since the desktop shell that normally docks it is not mounted.
 */

/** How many rows show through the veil before the fold is opened. */
const FOLDED_ROWS = 3;
/** Row height (py-[7px] + 20px line) — the veil's cap is a multiple of it. */
const ROW_PX = 34;

export function ZenRoom() {
  const zenOpen = useViewStore((s) => s.zenOpen);
  // Gated OUTSIDE the surface so a closed room costs nothing: ZenSurface
  // subscribes to the planner store through useDayItemsForDates, and would
  // otherwise re-derive the day on every item change for a screen nobody is
  // looking at.
  if (!zenOpen) return null;
  return <ZenSurface />;
}

/** The room itself, ungated. The desktop mounts it through ZenStage
 *  (components/zen/zen-stage.tsx), which keeps it mounted through the exit
 *  animation after the flag has already gone false. */
export function ZenSurface() {
  const setZenOpen = useViewStore((s) => s.setZenOpen);
  const userTimezone = usePlannerStore((s) => s.userTimezone);
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
  const toggleHabitStatus = usePlannerStore((s) => s.toggleHabitStatus);
  const getProjectColor = usePlannerStore((s) => s.getProjectColor);
  const streaksOn = useStreaksEnabled();
  const [foldOpen, setFoldOpen] = useState(false);
  /*
   * The fold's height while it is moving, in real pixels. `max-height` cannot
   * interpolate to or from `none`, so the old cap-to-undefined swap snapped
   * open and shut. A toggle pins the box to a measured height for the length
   * of the transition, and transitionend drops it back to null — open resting
   * as `none`, so a row added later is never clipped by a stale measurement.
   */
  const [foldMax, setFoldMax] = useState<number | null>(null);
  const foldRef = useRef<HTMLDivElement>(null);

  const timezone = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMin = useNowMinutes(timezone);

  /*
   * Today, resolved once a minute rather than once a render.
   *
   * `nowMin` is a DEPENDENCY the callback never reads, which is the point and
   * why the lint rule is silenced rather than satisfied: it is the clock tick.
   * Dropping it would freeze `todayStr` at whichever day the room was opened on,
   * so a session left running overnight would go on calling yesterday "today".
   *
   * The Date is then memoized on that STRING, which is what holds its identity
   * stable for a whole day — useDayItemsForDates keys its memo on `getTime()`,
   * so a fresh `new Date()` per render would re-derive the day continuously.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const todayStr = useMemo(() => toDateStr(new Date(), timezone), [timezone, nowMin]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const todayDate = useMemo(() => new Date(), [todayStr]);
  const dates = useMemo(() => [todayDate], [todayDate]);
  const [day] = useDayItemsForDates(dates);

  const rows = useMemo(() => zenRows(day), [day]);
  /*
   * A skip is a THIRD state, and the room must not offer a plain checkbox on
   * one. Every other surface says so in its own way — task-row returns a
   * collapsed strip with an Unskip button and no completion box at all — and
   * the reason is not tidiness: ticking a skipped recurring task would write a
   * skipped-AND-completed pair the rest of the app treats as impossible, and
   * ticking a skipped habit would silently clear the skip, turning an
   * occurrence the user deliberately answered back into an open loop that the
   * nightly stake settlement charges as a miss.
   *
   * Left OUT of the room entirely rather than shown inert: they are answered,
   * and the grid is where you go to unskip one.
   */
  const live = useMemo(() => rows.filter((r) => !isRowSkipped(r, todayStr)), [rows, todayStr]);
  const openRows = useMemo(() => live.filter((r) => !isRowDone(r, todayStr)), [live, todayStr]);
  const doneRows = useMemo(() => live.filter((r) => isRowDone(r, todayStr)), [live, todayStr]);
  const hero = useMemo(() => pickHero(openRows, nowMin), [openRows, nowMin]);
  const ledger = useMemo(() => openRows.filter((r) => r !== hero?.row), [openRows, hero]);

  /*
   * Escape leaves the room — the same guarded window listener the bulk action
   * bar uses (components/shell/bulk-action-bar.tsx), and guarded for the same
   * reasons: a Radix layer that already consumed this Escape to close itself
   * (the ⌘K launcher, the add dialog, a confirm) must not ALSO dump the user out
   * of Zen, and a focused text field owns its own Escape. `activeDialog` is
   * checked as well as `defaultPrevented` because a dialog can be open with
   * focus outside it, and closing the room out from under one would leave a
   * modal floating over the planner.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const ui = useUIStore.getState();
      if (ui.activeDialog || ui.confirmRequest) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      setZenOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setZenOpen]);

  /*
   * Forget whatever the mouse was last over.
   *
   * `e` and `⌫` act on lib/hovered-item.ts, a module-level ref written by
   * TaskRow on mouseenter/mouseleave. Unmounting a row does NOT fire mouseleave,
   * so entering Zen from the palette while the pointer rested on a task leaves
   * that task as the live target — and `⌫` in here would then raise a delete
   * confirm for something that is not on screen. Nothing in this room writes the
   * ref, so clearing it once on entry keeps both shortcuts inert throughout.
   */
  useEffect(() => {
    setHoveredItemRef(null, null);
  }, []);

  /*
   * Point the rest of the app at today too.
   *
   * Zen's own ticks name today explicitly, but the room does not own every way
   * to complete something from inside it: ⌘K stays alive on top, and the
   * palette's item commands resolve against `selectedDate` by design ("the day
   * on screen"). While Zen is open the day on screen IS today, so leaving
   * `selectedDate` parked on some browsed Tuesday would have ⌘K → Complete mark
   * a day the user cannot see — the exact bug this room exists to make
   * impossible for its own checkbox.
   *
   * Keyed on `todayStr`, so it also re-syncs across midnight for a session left
   * open overnight rather than only on entry.
   */
  const setSelectedDate = usePlannerStore((s) => s.setSelectedDate);
  /*
   * …but not while the room is still flying in. For that second the planner is
   * on screen around the wave (components/zen/zen-stage.tsx), and re-pointing it
   * would jump the grid to today under the user's eyes and pull the lifting
   * item's slot out from under it. The subscription re-runs this once the wave
   * lands; the check reads the store itself so it sees the flag as it is now.
   */
  const zenMoving = useViewStore((s) => s.zenMoving);
  useEffect(() => {
    if (useViewStore.getState().zenMoving) return;
    const { selectedDate, userTimezone } = usePlannerStore.getState();
    const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (toDateStr(selectedDate, tz) !== todayStr) setSelectedDate(new Date());
  }, [todayStr, setSelectedDate, zenMoving]);

  const heroDone = hero ? isRowDone(hero.row, todayStr) : false;
  const tick = (row: ZenRow) =>
    toggleRowDone(row, { date: todayDate, dateStr: todayStr }, { toggleTaskStatus, toggleHabitStatus });

  /*
   * Does the ledger actually overflow its folded cap?
   *
   * The veil used to render on `!foldOpen` alone. It is anchored to the bottom
   * of a box that shrinks to its content, so on a short day the opaque end of
   * the gradient lay over the only rows there were — the fold appeared to hide
   * something when there was nothing under it, and a two-row ledger read as
   * washed out. The chevron goes with it: nothing to unfold, no control.
   */
  const foldRowCount = ledger.length + doneRows.length + (doneRows.length > 0 ? 1 : 0);
  const foldable = foldRowCount > FOLDED_ROWS;
  const foldCap = FOLDED_ROWS * ROW_PX;

  const toggleFold = () => {
    const el = foldRef.current;
    const next = !foldOpen;
    if (!el || prefersReducedMotion()) {
      setFoldMax(null);
      setFoldOpen(next);
      return;
    }
    if (next) {
      // Cap → full height; transitionend releases it to `none`.
      setFoldMax(el.scrollHeight);
    } else {
      // `none` → cap has no start value to animate from, so pin the current
      // height first and force a layout before handing it the cap.
      flushSync(() => setFoldMax(el.scrollHeight));
      void el.offsetHeight;
      setFoldMax(foldCap);
    }
    setFoldOpen(next);
  };

  const pct = elapsedPct(hero, nowMin);
  const remaining = remainingMins(hero, nowMin);
  const heroProject = hero?.row.item.project;
  const heroMulti = hero ? multiCount(hero.row, todayStr) : null;

  return (
    <div className="zen-room relative flex h-[100dvh] flex-col items-center overflow-y-auto bg-surface-0 px-5 pt-7 pb-24">
      {/* The frost field — the room's whole ambience. aria-hidden and
          pointer-events-none: it is weather, not content. See app/globals.css
          for why it is this dim and this slow. */}
      <div className="zen-frost" aria-hidden="true">
        <span className="zen-frost-a" />
        <span className="zen-frost-b" />
      </div>

      <header className="relative z-10 text-[11px] font-medium uppercase leading-[15px] tracking-[0.08em] text-muted-foreground">
        {new Intl.DateTimeFormat(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          timeZone: timezone,
        }).format(todayDate)}
      </header>

      <main className="relative z-10 flex w-full max-w-[560px] flex-1 flex-col justify-center">
        {/* ── The hero ─────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-[18px]">
          <div className="flex items-center gap-[7px] text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.09em] text-muted-foreground">
            <span
              className={cn(
                'h-1.5 w-1.5 flex-none rounded-full',
                hero?.kind === 'now' ? 'bg-primary' : 'bg-border'
              )}
            />
            {heroKicker(hero)}
          </div>

          {hero === null ? (
            <h1 className="m-0 font-serif text-[clamp(2rem,5.5vw,3.15rem)] font-semibold leading-[1.16] tracking-[-0.01em] text-balance text-secondary-foreground">
              That&apos;s the day.
            </h1>
          ) : (
            <>
              <div className="flex items-start gap-4">
                <button
                  type="button"
                  onClick={() => tick(hero.row)}
                  aria-pressed={heroDone}
                  aria-label={`Complete ${hero.row.item.title}`}
                  className={cn(
                    'mt-[clamp(6px,1.4vw,13px)] flex h-[22px] w-[22px] flex-none items-center justify-center rounded-[6px] border-[1.5px] transition-colors duration-150',
                    heroDone
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground/45 bg-surface-3 hover:border-primary'
                  )}
                >
                  {heroDone && <Check className="h-3 w-3 text-primary-foreground" />}
                </button>
                <h1
                  // The item the room is about — components/zen/zen-stage.tsx
                  // flies it here from its slot in the planner and back.
                  data-zen-hero={hero.row.item.id}
                  className={cn(
                    'm-0 font-serif text-[clamp(2rem,5.5vw,3.15rem)] font-semibold leading-[1.16] tracking-[-0.01em] text-balance',
                    heroDone && 'text-muted-foreground line-through opacity-60'
                  )}
                >
                  {hero.row.item.title}
                </h1>
              </div>

              <div className="flex items-baseline gap-2.5 font-num text-[13px] leading-[17px] text-secondary-foreground">
                <span>{heroTimeLabel(hero.row)}</span>
                {heroMulti && !heroDone && (
                  <span>
                    {heroMulti.count}/{heroMulti.target}
                  </span>
                )}
                {heroProject && (
                  <span className="flex items-center gap-1.5 font-sans text-xs text-muted-foreground">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: getProjectColor(heroProject) }}
                    />
                    {heroProject}
                  </span>
                )}
              </div>

              {/* The now-rail: the schedule grid's own language, straightened
                  out. Elapsed time is a 2px lime bar and the 7px rotated diamond
                  pins the present, but what REMAINS is a plain hairline — never
                  a faded lime, which composites to olive and breaks the standing
                  rule that this accent never dims. */}
              {pct !== null && (
                <div className="relative h-3.5" style={{ ['--pct' as string]: `${pct}%` }}>
                  <span className="absolute left-0 top-1.5 h-0.5 w-[var(--pct)] rounded-[1px] bg-primary" />
                  <span className="absolute right-0 top-[6.5px] left-[calc(var(--pct)+12px)] border-t border-border" />
                  <span className="zen-breath absolute top-[-4px] left-[calc(var(--pct)-7.5px)] h-[22px] w-[22px] rounded-full" />
                  <span className="absolute top-[3.5px] left-[var(--pct)] h-[7px] w-[7px] rotate-45 bg-primary shadow-[0_0_0_1px_var(--surface-0)]" />
                </div>
              )}

              {remaining !== null && (
                <div className="text-right font-num text-[11px] text-muted-foreground">
                  {formatRemaining(remaining)}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── The ledger ───────────────────────────────────────────────── */}
        {(ledger.length > 0 || doneRows.length > 0) && (
          <>
            <div className="mt-11 flex items-center gap-[7px] text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.09em] text-muted-foreground">
              <span className="h-1.5 w-1.5 flex-none rounded-full bg-border" />
              {ledger.length > 0 ? 'Next' : 'Earlier'}
            </div>

            {/*
              One ledger, folded. The rows under the veil are the SAME rows at
              the same geometry — the fold only lifts a cap, so nothing re-aligns
              when it opens. The veil is painted in the ground colour rather than
              being a transparent gradient, so it reads identically over the
              frost field behind it.
            */}
            <div
              ref={foldRef}
              className="relative mt-1.5 overflow-hidden transition-[max-height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
              style={{
                maxHeight: !foldable ? undefined : (foldMax ?? (foldOpen ? undefined : foldCap)),
              }}
              onTransitionEnd={(e) => {
                if (e.target === e.currentTarget && e.propertyName === 'max-height') setFoldMax(null);
              }}
            >
              {ledger.length > 0 && (
                <ul className="m-0 flex list-none flex-col p-0">
                  {ledger.map((row) => (
                    <ZenLedgerRow
                      key={row.item.id}
                      row={row}
                      dateStr={todayStr}
                      onTick={() => tick(row)}
                      streaksOn={streaksOn}
                    />
                  ))}
                </ul>
              )}

              {doneRows.length > 0 && (
                <>
                  {ledger.length > 0 && (
                    <div className="mb-1.5 mt-[18px] flex items-center gap-[7px] text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.09em] text-muted-foreground">
                      <span className="h-1.5 w-1.5 flex-none rounded-full bg-border" />
                      Earlier
                    </div>
                  )}
                  <ul className="m-0 flex list-none flex-col p-0">
                    {doneRows.map((row) => (
                      <ZenLedgerRow
                        key={row.item.id}
                        row={row}
                        dateStr={todayStr}
                        done
                        onTick={() => tick(row)}
                        streaksOn={streaksOn}
                      />
                    ))}
                  </ul>
                </>
              )}

              {foldable && (
                <div
                  className={cn(
                    'pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent to-surface-0 transition-opacity duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                    foldOpen && 'opacity-0',
                  )}
                />
              )}
            </div>

            {foldable && (
            <button
              type="button"
              onClick={toggleFold}
              aria-expanded={foldOpen}
              aria-label={foldOpen ? 'Fold the day away' : 'Show the rest of the day'}
              className="mt-4 flex h-[30px] w-[30px] items-center justify-center self-center rounded-full border border-border bg-surface-3 text-muted-foreground transition-colors duration-150 hover:border-muted-foreground/60 hover:text-foreground"
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', foldOpen && 'rotate-180')}
              />
            </button>
            )}
          </>
        )}
      </main>

      <button
        type="button"
        onClick={() => setZenOpen(false)}
        className="relative z-10 mt-6 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-secondary-foreground"
      >
        <span className="rounded-[5px] border border-border bg-surface-3 px-1.5 py-1 font-num text-[10.5px] leading-none text-secondary-foreground">
          esc
        </span>
        back to the planner
      </button>
    </div>
  );
}

function ZenLedgerRow({
  row,
  dateStr,
  done = false,
  onTick,
  streaksOn,
}: {
  row: ZenRow;
  dateStr: string;
  done?: boolean;
  onTick: () => void;
  streaksOn: boolean;
}) {
  const habit = row.itemType === 'habit' ? row.item : null;
  const streak = habit && streaksOn && habit.streak > 0 ? `\u00d7${habit.streak}` : '';
  const multi = multiCount(row, dateStr);
  /*
   * The right margin carries ONE number, and a multi-count habit's progress
   * outranks its hour: `isRowDone` only turns true at the target, so without an
   * n/N readout the first N-1 ticks of "drink 3 glasses" change nothing on
   * screen and read as dead clicks. Otherwise it is the hour if the item has
   * one, else the streak — which is what lets an unscheduled row sit in the
   * same list without a placeholder dash standing in for a time it lacks.
   */
  const rightMeta =
    multi && !done
      ? `${multi.count}/${multi.target}`
      : row.item.startTime
        ? clockOf(minutesOf(row.item.startTime))
        : streak;

  return (
    <li className="grid grid-cols-[16px_1fr_auto] items-center gap-x-[19px] rounded-[5px] py-[7px] pl-[3px] pr-2 hover:bg-accent">
      <button
        type="button"
        onClick={onTick}
        aria-pressed={done}
        aria-label={`${done ? 'Un-complete' : 'Complete'} ${row.item.title}`}
        className={cn(
          'relative flex h-4 w-4 flex-none items-center justify-center overflow-hidden rounded-[5px] border transition-colors duration-150',
          done
            ? 'border-primary bg-primary'
            : 'border-muted-foreground/45 bg-surface-3 hover:border-primary'
        )}
      >
        {/* Partial progress rises inside the box, the same way it does on the
            planner's own rows. Its own element rather than an opacity on the
            parent, so the lime never composites down to olive. */}
        {multi && !done && multi.count > 0 && (
          <span
            className="absolute inset-x-0 bottom-0 bg-primary/70"
            style={{ height: `${multi.pct}%` }}
          />
        )}
        {done && <Check className="relative h-2.5 w-2.5 text-primary-foreground" />}
      </button>
      <span
        className={cn(
          'min-w-0 truncate text-[13px]',
          done ? 'text-muted-foreground line-through opacity-60' : 'text-secondary-foreground'
        )}
      >
        {row.item.title}
      </span>
      <span className="font-num text-xs text-muted-foreground">{rightMeta}</span>
    </li>
  );
}
