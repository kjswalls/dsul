'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Flag } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useToday, formatShort } from '@/lib/collections';
import {
  addDaysStr,
  daysBetween,
  deriveContainerSchedule,
  MAX_SCHEDULE_DAYS,
  occurrencesByItem,
  weekBuckets,
  weekdayOf,
  weekStartOf,
  type ContainerSchedule,
  type Occurrence,
  type OccurrenceState,
} from '@/lib/container-schedule';
import { cn } from '@/lib/utils';
import type { Item, Program, Project, Routine } from '@/lib/planner-types';

/**
 * THE CONTAINER SCHEDULE CHARTS (Kirby, 2026-09-26; design canvas
 * "Container schedule explorations").
 *
 *   · WeekDots        — seven dots on a member row: the rhythm grid, folded
 *                       into the list it would otherwise repeat.
 *   · RhythmGrid      — the same, wide: item × day for a week or four.
 *   · SeasonHeatmap   — a program's run, one square per day.
 *   · GoalTimeline    — a goal's window, one lane per item; GoalBars is its
 *                       per-week alternative behind a toggle.
 *   · UnscheduledTray — members with no date at all.
 *
 * All of them read lib/container-schedule.ts, which is the grid's own per-day
 * answer narrowed to the container — so no chart can disagree with the planner.
 *
 * The past shows only what was RECORDED. A done day is lime; a day with nothing
 * recorded is a faint wash, the habit heatmap's convention — never "missed",
 * never a warning mark (the guilt-free law). Colours are tokens throughout, so
 * dark mode needs nothing here; the lime is never faded through a parent.
 */

/* ── data ──────────────────────────────────────────────────────────────── */

export interface ScheduleOverrides {
  /** A draft container the store has not seen yet — the create modal's preview. */
  routines?: readonly Routine[];
  programs?: readonly Program[];
}

/**
 * The schedule for `memberIds` from `from` for `days` days, memoized on the
 * store slices it reads. `overrides` replaces the routine/program lists that
 * activation resolves against (pass the store's plus a draft).
 */
export function useContainerSchedule(
  memberIds: readonly string[],
  from: string,
  days: number,
  overrides?: ScheduleOverrides,
  block?: Project,
): ContainerSchedule {
  const items = usePlannerStore((s) => s.items);
  const tasks = usePlannerStore((s) => s.tasks);
  const habits = usePlannerStore((s) => s.habits);
  const storeRoutines = usePlannerStore((s) => s.routines);
  const storePrograms = usePlannerStore((s) => s.programs);
  const { todayStr, tz } = useToday();
  const routines = overrides?.routines ?? storeRoutines;
  const programs = overrides?.programs ?? storePrograms;
  const key = memberIds.join(',');
  return useMemo(
    () =>
      deriveContainerSchedule({
        memberIds,
        source: { items, tasks, habits, routines, programs, timezone: tz },
        from,
        days,
        todayStr,
        block,
      }),
    // `key` stands in for `memberIds`: callers build the array per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, items, tasks, habits, routines, programs, tz, from, days, todayStr, block]
  );
}

export function useWeekStartDay() {
  return usePlannerStore((s) => s.weekStartDay);
}

const DOW_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The dated states a chart row draws, in words — its text alternative. */
function rowStates(row: Map<string, Occurrence> | undefined, dates: readonly string[]): string {
  const on = dates.filter((d) => row?.has(d));
  if (on.length === 0) return 'nothing in this span';
  return on.map((d) => `${formatShort(d)} ${STATE_WORD[row!.get(d)!.state]}`).join(', ');
}

const STATE_WORD: Record<OccurrenceState, string> = {
  done: 'done',
  skipped: 'skipped',
  due: 'due',
  open: 'nothing recorded',
};

/** One occurrence's mark. `once` draws a diamond; the rest are round. */
function Mark({
  o,
  size,
  isToday,
}: {
  o: Occurrence | undefined;
  size: 'sm' | 'md';
  isToday?: boolean;
}) {
  // Told apart by SHAPE as well as colour, so none of it rests on seeing lime:
  //   done    — a full mark, filled, with an ink edge
  //   due     — a full mark, hollow
  //   skipped — a small hollow ring
  //   open    — a small dot (an earlier day with nothing recorded; never "missed")
  //   nothing — blank
  const box = size === 'sm' ? 'size-[7px]' : 'size-[13px]';
  const small = size === 'sm' ? 'size-[4px]' : 'size-[6px]';
  if (!o) return null;
  const shape = o.once ? 'rotate-45 rounded-[2px]' : 'rounded-full';
  if (o.state === 'open') {
    return <span aria-hidden className={cn(small, shape, 'bg-muted-foreground/40 shrink-0')} />;
  }
  if (o.state === 'skipped') {
    return <span aria-hidden className={cn(small, shape, 'border-muted-foreground box-border shrink-0 border')} />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        box,
        shape,
        'box-border shrink-0',
        o.state === 'done' && 'bg-primary border-[1px] border-[var(--lime-ink)]',
        o.state === 'due' && 'border-muted-foreground border-[1.5px]',
        isToday && o.state === 'due' && 'border-foreground'
      )}
    />
  );
}

/* ── week dots on a member row ─────────────────────────────────────────── */

/** The dates of the current week, from the user's week start. */
export function useThisWeek(): string[] {
  const { todayStr } = useToday();
  const weekStartDay = useWeekStartDay();
  return useMemo(() => {
    const start = weekStartOf(todayStr, weekStartDay);
    return Array.from({ length: 7 }, (_, i) => addDaysStr(start, i));
  }, [todayStr, weekStartDay]);
}

export function WeekDots({
  row,
  dates,
  todayStr,
  title,
}: {
  row: Map<string, Occurrence> | undefined;
  dates: readonly string[];
  todayStr: string;
  /** The item's title, for the accessible summary. */
  title: string;
}) {
  const on = dates.filter((d) => row?.has(d));
  const label = on.length
    ? `${title} this week: ${on.map((d) => `${DOW_SHORT[weekdayOf(d)]} ${STATE_WORD[row!.get(d)!.state]}`).join(', ')}`
    : `${title}: nothing this week`;
  return (
    <span
      // Hidden on a phone: at bottom-sheet width the dots would leave the title
      // ~30px. The row's own meta column still says when.
      className="hidden shrink-0 items-center gap-[3px] sm:flex"
      role="img"
      aria-label={label}
      data-testid="week-dots"
    >
      {dates.map((d) => (
        <span
          key={d}
          className={cn('flex size-[11px] items-center justify-center rounded-[3px]', d === todayStr && 'bg-muted')}
        >
          <Mark o={row?.get(d)} size="sm" isToday={d === todayStr} />
        </span>
      ))}
    </span>
  );
}

/** The day letters over a column of WeekDots. `trailingPad` clears the row's control rail. */
export function WeekDotsHeader({ dates, todayStr, trailingPad }: { dates: readonly string[]; todayStr: string; trailingPad: number }) {
  return (
    // The member list scrolls past six rows, and a classic scrollbar narrows the
    // rows under it; reserving the same gutter here keeps letters over dots.
    <div
      className="hidden justify-end overflow-hidden [scrollbar-gutter:stable] sm:flex"
      style={{ paddingRight: trailingPad }}
      aria-hidden
    >
      <span className="flex items-center gap-[3px]">
        {dates.map((d) => (
          <span
            key={d}
            className={cn(
              'w-[11px] text-center text-[9px] leading-none',
              d === todayStr ? 'text-foreground font-semibold' : 'text-muted-foreground'
            )}
          >
            {DOW_LETTERS[weekdayOf(d)]}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * Everything a member list needs to carry the week: the dots per row and the
 * letters over them. One schedule for the whole list, so seven days cost seven
 * resolver passes however many rows there are.
 */
export function useWeekDotsFor(memberIds: readonly string[], overrides?: ScheduleOverrides) {
  const dates = useThisWeek();
  const { todayStr } = useToday();
  const schedule = useContainerSchedule(memberIds, dates[0], 7, overrides);
  const byItem = useMemo(() => occurrencesByItem(schedule), [schedule]);
  return {
    /** Today's occurrence for a member — what the row controls gate ticks and skips on. */
    todayState: (itemId: string) => byItem.get(itemId)?.get(todayStr)?.state,
    header: (trailingPad: number) => <WeekDotsHeader dates={dates} todayStr={todayStr} trailingPad={trailingPad} />,
    trailing: (item: Item) => (
      <WeekDots row={byItem.get(item.id)} dates={dates} todayStr={todayStr} title={item.title} />
    ),
  };
}

/* ── shared chrome ─────────────────────────────────────────────────────── */

export function ScheduleHeading({
  label,
  children,
  testId,
}: {
  label: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-h-5 items-center justify-between gap-2" data-testid={testId}>
      <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{label}</p>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  testId,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  testId: string;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="bg-muted flex h-[22px] items-center gap-0.5 rounded-[8px] p-0.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-[18px] rounded-[6px] px-2 text-[10.5px] transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            value === o.value
              ? 'bg-surface-2 text-foreground font-medium shadow-[var(--shadow-elev-sm)]'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── unscheduled ───────────────────────────────────────────────────────── */

export function UnscheduledTray({ items, testId = 'schedule-unscheduled' }: { items: readonly Item[]; testId?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <ScheduleHeading label={`Unscheduled · ${items.length}`}>
        <span className="text-muted-foreground text-[11px]">No date yet — in the braindump</span>
      </ScheduleHeading>
      <div className="flex flex-wrap gap-1">
        {items.slice(0, 12).map((i) => (
          <span key={i.id} className="bg-muted text-foreground max-w-[180px] truncate rounded-[6px] px-2 py-0.5 text-[11px]">
            {i.title}
          </span>
        ))}
        {items.length > 12 && (
          <span className="text-muted-foreground px-1 py-0.5 text-[11px]">+{items.length - 12} more</span>
        )}
      </div>
    </div>
  );
}

/* ── rhythm grid (pages) ───────────────────────────────────────────────── */

export function RhythmGrid({
  members,
  overrides,
  block,
  onlyActive = false,
  linkItems = false,
  testId = 'rhythm-grid',
}: {
  members: readonly Item[];
  overrides?: ScheduleOverrides;
  /** A project: draw its time block as a row of its own. */
  block?: Project;
  /** Skip members with nothing in range — a project can hold hundreds. */
  onlyActive?: boolean;
  /** Titles link to the item's page (the container pages; the console keeps rows as addresses of its own). */
  linkItems?: boolean;
  testId?: string;
}) {
  const { todayStr } = useToday();
  const weekStartDay = useWeekStartDay();
  const [span, setSpan] = useState<'week' | 'month'>('week');
  const [offset, setOffset] = useState(0);
  const days = span === 'week' ? 7 : 28;
  const thisWeek = weekStartOf(todayStr, weekStartDay);
  // Four weeks END on this one: the question a month answers is "how has it
  // been going", and the future half of it is the week view's.
  const from = addDaysStr(thisWeek, (span === 'week' ? 0 : -21) + offset * days);
  const ids = members.map((m) => m.id);
  const schedule = useContainerSchedule(ids, from, days, overrides, block);
  const byItem = useMemo(() => occurrencesByItem(schedule), [schedule]);
  const dates = schedule.days.map((d) => d.date);
  const rows = onlyActive ? members.filter((m) => byItem.has(m.id)) : members;
  const quiet = members.length - rows.length;
  const blockDays = new Set(schedule.days.filter((d) => d.block).map((d) => d.date));
  const doneCount = schedule.days.reduce((n, d) => n + d.occurrences.filter((o) => o.state === 'done').length, 0);
  const dueCount = schedule.days.reduce((n, d) => n + d.occurrences.filter((o) => o.state === 'due').length, 0);
  const cols = `minmax(120px, 200px) repeat(${days}, minmax(0, 1fr))`;
  const last = dates[dates.length - 1];

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <ScheduleHeading label="Rhythm">
        <div className="flex items-center gap-2">
          <Segmented
            label="Span"
            value={span}
            options={[
              { value: 'week', label: 'Week' },
              { value: 'month', label: '4 weeks' },
            ]}
            onChange={(v) => {
              setSpan(v);
              setOffset(0);
            }}
            testId={`${testId}-span`}
          />
          <div className="flex items-center">
            <button type="button" aria-label="Earlier" onClick={() => setOffset((o) => o - 1)} className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-6 place-items-center rounded-[5px]">
              <ChevronLeft className="size-3.5" />
            </button>
            <span className="text-muted-foreground font-num min-w-[92px] text-center text-[11px]">
              {formatShort(from)} – {formatShort(last)}
            </span>
            <button type="button" aria-label="Later" onClick={() => setOffset((o) => o + 1)} className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-6 place-items-center rounded-[5px]">
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      </ScheduleHeading>
      <div className="overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="grid h-6 items-end" style={{ gridTemplateColumns: cols }}>
            <span />
            {dates.map((d) => (
              <span
                key={d}
                className={cn(
                  'font-num text-center text-[9.5px]',
                  d === todayStr ? 'text-foreground font-semibold' : 'text-muted-foreground'
                )}
              >
                {span === 'week' ? `${DOW_LETTERS[weekdayOf(d)]} ${Number(d.slice(8))}` : weekdayOf(d) === weekdayOf(from) || d === todayStr ? Number(d.slice(8)) : ''}
              </span>
            ))}
          </div>
          {block && blockDays.size > 0 && (
            <div className="border-border/60 grid h-8 items-center border-t" style={{ gridTemplateColumns: cols }} data-testid={`${testId}-block`}>
              <span className="text-muted-foreground truncate pr-2 text-[12px]">
                Block{block.startTime ? ` · ${block.startTime}` : ''}
              </span>
              {dates.map((d) => (
                <span key={d} className={cn('flex h-8 items-center justify-center', d === todayStr && 'bg-muted/60')}>
                  {blockDays.has(d) ? <span className="bg-muted-foreground/35 h-[13px] w-[70%] rounded-[3px]" /> : null}
                </span>
              ))}
            </div>
          )}
          {rows.map((item) => (
            <div
              key={item.id}
              className="border-border/60 grid h-8 items-center border-t"
              style={{ gridTemplateColumns: cols }}
              data-testid={`${testId}-row`}
            >
              {/* The marks are aria-hidden; this is what a screen reader hears
                  instead (a name on a plain div is not announced). */}
              <span className="sr-only" data-testid={`${testId}-row-summary`}>
                {rowStates(byItem.get(item.id), dates)}
              </span>
              {linkItems ? (
                <Link href={`/item/${item.id}`} className="hover:text-foreground truncate pr-2 text-[13px] hover:underline" title={item.title}>
                  {item.title}
                </Link>
              ) : (
                <span className="truncate pr-2 text-[13px]" title={item.title}>{item.title}</span>
              )}
              {dates.map((d) => (
                <span key={d} className={cn('flex h-8 items-center justify-center', d === todayStr && 'bg-muted/60')}>
                  <Mark o={byItem.get(item.id)?.get(d)} size={span === 'week' ? 'md' : 'sm'} isToday={d === todayStr} />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="text-muted-foreground text-[11px]" data-testid={`${testId}-summary`}>
        {doneCount} done{dueCount ? ` · ${dueCount} still to come` : ''}
        {quiet > 0 ? ` · ${quiet} more with nothing in this span` : ''}
      </p>
      <UnscheduledTray items={schedule.unscheduled} />
    </div>
  );
}

/* ── season heatmap (programs) ─────────────────────────────────────────── */

/**
 * The run, or — for a program with no dates, or held On/Off by hand — the
 * next sixteen weeks from this one. A long run is capped (MAX_SCHEDULE_DAYS).
 */
export function programRange(program: Pick<Program, 'state' | 'startsOn' | 'endsOn'>, todayStr: string, weekStartDay: 'sunday' | 'monday' | 'saturday') {
  const auto = program.state === 'auto';
  if (auto && program.startsOn && program.endsOn && program.endsOn >= program.startsOn) {
    const start = weekStartOf(program.startsOn, weekStartDay);
    const full = daysBetween(start, program.endsOn) + 1;
    if (full <= MAX_SCHEDULE_DAYS) return { from: start, days: full, capped: false, bounded: true };
    // Too long to draw whole: keep today in view, week-aligned, inside the run.
    const latest = weekStartOf(addDaysStr(program.endsOn, -(MAX_SCHEDULE_DAYS - 7)), weekStartDay);
    const from = weekStartOf(clampWindowStart(todayStr, start, latest, 0), weekStartDay);
    return { from, days: MAX_SCHEDULE_DAYS, capped: true, bounded: true };
  }
  // Open-ended (or held by hand): sixteen weeks from this one — or from the
  // start, while that is still ahead — never a stretch that is all behind us.
  const anchor = auto && program.startsOn && program.startsOn > todayStr ? program.startsOn : todayStr;
  return { from: weekStartOf(anchor, weekStartDay), days: 16 * 7, capped: false, bounded: false };
}

/**
 * Where a capped window opens: half a year before today, but never before the
 * window's start nor so late that it runs past `to` (or past `latest` itself
 * when `span` is 0, i.e. `to` is already the latest allowed start).
 */
function clampWindowStart(todayStr: string, start: string, to: string, span = MAX_SCHEDULE_DAYS) {
  const latest = span ? addDaysStr(to, -(span - 1)) : to;
  const back = addDaysStr(todayStr, -182);
  if (back < start) return start;
  if (back > latest) return latest;
  return back;
}

export function SeasonHeatmap({
  program,
  memberIds,
  overrides,
  testId = 'season-heatmap',
}: {
  program: Pick<Program, 'state' | 'startsOn' | 'endsOn'>;
  memberIds: readonly string[];
  overrides?: ScheduleOverrides;
  testId?: string;
}) {
  const { todayStr } = useToday();
  const weekStartDay = useWeekStartDay();
  const range = programRange(program, todayStr, weekStartDay);
  const schedule = useContainerSchedule(memberIds, range.from, range.days, overrides);
  const [hover, setHover] = useState<string | null>(null);
  const items = usePlannerStore((s) => s.items);
  const titleOf = (id: string) => items.find((i) => i.id === id)?.title ?? '';

  const inRun = (d: string) =>
    program.state !== 'auto' ||
    ((!program.startsOn || d >= program.startsOn) && (!program.endsOn || d <= program.endsOn));

  // Columns are weeks; rows are the seven weekdays from the user's week start.
  const weeks: { date: string; n: number; done: number; once: boolean; inRun: boolean }[][] = [];
  schedule.days.forEach((day, i) => {
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      date: day.date,
      n: day.occurrences.length,
      done: day.occurrences.filter((o) => o.state === 'done').length,
      once: day.occurrences.some((o) => o.once),
      inRun: inRun(day.date),
    });
  });
  // Two scales: the past is shaded by what was DONE (never by what was
  // "missed"), the future by what is planned, each against its own maximum.
  const past = schedule.days.filter((d) => d.date < todayStr);
  const pastMax = Math.max(1, ...past.map((d) => d.occurrences.filter((o) => o.state === 'done').length));
  const futureMax = Math.max(1, ...schedule.days.filter((d) => d.date >= todayStr).map((d) => d.occurrences.length));
  const shade = (c: { date: string; n: number; done: number }) => {
    if (c.date < todayStr) {
      const r = c.done / pastMax;
      // The lime steps are MIXED from its own tint and solid, never faded
      // through alpha — faded lime reads olive on the dark ramp (CLAUDE.md).
      return c.done === 0
        ? 'bg-muted/50'
        : r > 0.66
          ? 'bg-primary'
          : r > 0.33
            ? 'bg-[color-mix(in_oklab,var(--lime-solid)_55%,var(--lime-tint))]'
            : 'bg-[var(--lime-tint)]';
    }
    const r = c.n / futureMax;
    return c.n === 0 ? 'bg-muted/50' : r > 0.75 ? 'bg-muted-foreground/70' : r > 0.5 ? 'bg-muted-foreground/45' : r > 0.25 ? 'bg-muted-foreground/25' : 'bg-muted';
  };
  const hovered = hover ? schedule.days.find((d) => d.date === hover) : null;
  const heaviest = [...schedule.days].filter((d) => d.date >= todayStr).sort((a, b) => b.occurrences.length - a.occurrences.length)[0];
  const doneTotal = past.reduce((n, d) => n + d.occurrences.filter((o) => o.state === 'done').length, 0);
  const heatmapSummary =
    `${formatShort(range.from)} to ${formatShort(addDaysStr(range.from, range.days - 1))}: ` +
    `${doneTotal} done so far` +
    (heaviest && heaviest.occurrences.length ? `, busiest ahead ${formatShort(heaviest.date)}` : '');
  const rangeNotes = `${!range.bounded ? ' No run set — showing sixteen weeks.' : ''}${range.capped ? ' Long run — showing the first 400 days.' : ''}`;

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="overflow-x-auto">
        {/* ONE image to assistive tech and the keyboard, not hundreds of tab
            stops: the cells are spans, hover fills the line below, and the
            summary is the label. */}
        <div
          className="flex gap-[3px]"
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={heatmapSummary}
        >
          {weeks.map((week) => (
            <div key={week[0].date} className="flex flex-col gap-[3px]">
              {week.map((c) => (
                <span
                  key={c.date}
                  onMouseEnter={() => setHover(c.date)}
                  data-testid={`${testId}-cell`}
                  data-date={c.date}
                  className={cn(
                    'relative grid size-[13px] place-items-center rounded-[3px]',
                    c.inRun ? shade(c) : 'border-border border bg-transparent',
                    c.date === todayStr && 'ring-foreground ring-[1.5px] ring-inset'
                  )}
                >
                  {c.once && c.inRun && <span className="bg-foreground size-[5px] rotate-45 rounded-[1px]" aria-hidden />}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="text-muted-foreground min-h-4 text-[11px]" data-testid={`${testId}-info`}>
        {hovered ? (
          <>
            <span className="font-num">{formatShort(hovered.date)}</span> —{' '}
            {hovered.occurrences.length === 0
              ? 'nothing'
              : hovered.occurrences.map((o) => titleOf(o.itemId)).join(', ')}
          </>
        ) : heaviest && heaviest.occurrences.length > 0 ? (
          <>
            Busiest ahead: <span className="font-num">{formatShort(heaviest.date)}</span>, {heaviest.occurrences.length} things.
            {rangeNotes}
          </>
        ) : memberIds.length > 0 ? (
          <>
            Nothing ahead in this range{doneTotal ? ` — ${doneTotal} done before today` : ''}.{rangeNotes}
          </>
        ) : (
          'Nothing lands on it yet — link routines or items to see its season.'
        )}
      </p>
      <UnscheduledTray items={schedule.unscheduled} />
    </div>
  );
}

/* ── goal timeline and bars ────────────────────────────────────────────── */

export interface GoalRoles {
  milestoneIds: readonly string[];
  checkinIds: readonly string[];
  memberIds: readonly string[];
}

/** The goal's window, or twelve weeks from its start when it has no target. */
export function goalRange(startsOn: string | undefined, targetOn: string | undefined, todayStr: string) {
  const start = startsOn ?? todayStr;
  const to = targetOn && targetOn >= start ? targetOn : addDaysStr(start, 12 * 7 - 1);
  const full = daysBetween(start, to) + 1;
  if (full <= MAX_SCHEDULE_DAYS) return { from: start, days: full, capped: false, open: !targetOn };
  // Longer than the chart can hold: keep TODAY in view — half a year behind it
  // at most — rather than showing a first 400 days that may be long over.
  // Clamped into the window, so a goal whose target is long past still shows
  // its last stretch instead of an empty chart after it.
  return { from: clampWindowStart(todayStr, start, to), days: MAX_SCHEDULE_DAYS, capped: true, open: !targetOn };
}

const MAX_LANES = 8;

export function GoalSchedule({
  goal,
  overrides,
  testId = 'goal-schedule',
}: {
  goal: GoalRoles & { startsOn?: string; targetOn?: string };
  overrides?: ScheduleOverrides;
  testId?: string;
}) {
  const [view, setView] = useState<'timeline' | 'bars'>('timeline');
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <ScheduleHeading label="Across the window">
        <Segmented
          label="Chart"
          value={view}
          options={[
            { value: 'timeline', label: 'Timeline' },
            { value: 'bars', label: 'Bars' },
          ]}
          onChange={setView}
          testId={`${testId}-view`}
        />
      </ScheduleHeading>
      {view === 'timeline' ? (
        <GoalTimeline goal={goal} overrides={overrides} testId={`${testId}-timeline`} />
      ) : (
        <GoalBars goal={goal} overrides={overrides} testId={`${testId}-bars`} />
      )}
    </div>
  );
}

function useGoalSchedule(goal: GoalRoles & { startsOn?: string; targetOn?: string }, overrides?: ScheduleOverrides) {
  const { todayStr } = useToday();
  const range = goalRange(goal.startsOn, goal.targetOn, todayStr);
  const ids = [...goal.milestoneIds, ...goal.checkinIds, ...goal.memberIds];
  const schedule = useContainerSchedule(ids, range.from, range.days, overrides);
  return { range, schedule, todayStr };
}

function rangeNote(range: { capped: boolean; open: boolean }) {
  if (range.capped) return 'A long window — showing 400 days around today.';
  if (range.open) return 'No target yet — showing twelve weeks from the start.';
  return null;
}

export function GoalTimeline({
  goal,
  overrides,
  testId,
}: {
  goal: GoalRoles & { startsOn?: string; targetOn?: string };
  overrides?: ScheduleOverrides;
  testId: string;
}) {
  const { range, schedule, todayStr } = useGoalSchedule(goal, overrides);
  const items = usePlannerStore((s) => s.items);
  const byItem = useMemo(() => occurrencesByItem(schedule), [schedule]);
  const pct = (d: string) => `${(daysBetween(range.from, d) / range.days) * 100}%`;
  const todayIn = todayStr >= range.from && daysBetween(range.from, todayStr) < range.days;
  const title = (id: string) => items.find((i) => i.id === id)?.title ?? '';

  const milestones = goal.milestoneIds.flatMap((id) => [...(byItem.get(id)?.values() ?? [])]);
  const lanes = [...goal.checkinIds, ...goal.memberIds].filter((id) => byItem.has(id));
  const shown = lanes.slice(0, MAX_LANES);
  const months: { label: string; at: string }[] = [];
  for (const day of schedule.days) {
    // The range's own start is labelled only when the next 1st is not close
    // behind it, or the two labels overprint.
    const firstNear = day.date === range.from && Number(day.date.slice(8)) > 20;
    if (day.date.endsWith('-01') || (day.date === range.from && !firstNear)) {
      months.push({
        label: new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
        at: day.date,
      });
    }
  }
  const tickColor = (s: OccurrenceState) =>
    s === 'done' ? 'bg-primary' : s === 'due' ? 'bg-muted-foreground/60' : 'bg-transparent';

  if (milestones.length === 0 && lanes.length === 0) {
    return (
      <div className="flex flex-col gap-2" data-testid={testId}>
        <p className="text-muted-foreground text-[11px]">
          Nothing dated in the window yet — link milestones, check-ins or supporting work to see it here.
        </p>
        <UnscheduledTray items={schedule.unscheduled} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="relative">
        <div className="grid grid-cols-[120px_1fr]">
          <span />
          <div className="relative h-4">
            {months.map((m) => (
              <span key={m.at} className="text-muted-foreground absolute top-0 text-[9.5px]" style={{ left: pct(m.at) }}>
                {m.label}
              </span>
            ))}
          </div>
        </div>
        {milestones.length > 0 && (
          <div className="border-border/60 grid h-8 grid-cols-[120px_1fr] items-center border-t">
            <span className="truncate pr-2 text-[12.5px]">Milestones</span>
            <div className="relative h-8">
              {milestones.map((o) => (
                <span
                  key={`${o.itemId}:${o.date}`}
                  className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap"
                  style={{ left: pct(o.date) }}
                  title={`${title(o.itemId)} · ${formatShort(o.date)}`}
                  data-testid={`${testId}-milestone`}
                >
                  <Flag className={cn('size-3', o.state === 'done' ? 'text-muted-foreground' : 'text-foreground')} fill="currentColor" aria-hidden />
                  <span className="text-[10.5px]">{title(o.itemId)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {shown.map((id) => (
          <div key={id} className="border-border/60 grid h-7 grid-cols-[120px_1fr] items-center border-t" data-testid={`${testId}-lane`}>
            <span className="truncate pr-2 text-[12.5px]" title={title(id)}>{title(id)}</span>
            <span className="sr-only">
              {(() => {
                const row = byItem.get(id);
                const dates = [...(row?.values() ?? [])].filter((o) => o.state !== 'open').map((o) => o.date);
                return rowStates(row, dates);
              })()}
            </span>
            <div className="relative h-7" aria-hidden>
              {[...(byItem.get(id)?.values() ?? [])].filter((o) => o.state !== 'open').map((o) =>
                o.once ? (
                  <span key={o.date} className={cn('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px]', o.state === 'done' ? 'bg-primary' : 'bg-muted-foreground/60')} style={{ left: pct(o.date) }} />
                ) : (
                  <span key={o.date} className={cn('absolute top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-[1px]', tickColor(o.state))} style={{ left: pct(o.date) }} />
                )
              )}
            </div>
          </div>
        ))}
        {todayIn && (
          <span className="bg-foreground pointer-events-none absolute top-4 bottom-0 w-[1.5px]" style={{ left: `calc(120px + (100% - 120px) * ${daysBetween(range.from, todayStr) / range.days})` }} aria-hidden data-testid={`${testId}-today`} />
        )}
      </div>
      {(lanes.length > MAX_LANES || rangeNote(range)) && (
        <p className="text-muted-foreground text-[11px]">
          {lanes.length > MAX_LANES && `${lanes.length - MAX_LANES} more not shown. `}
          {rangeNote(range)}
        </p>
      )}
      <UnscheduledTray items={schedule.unscheduled} />
    </div>
  );
}

export function GoalBars({
  goal,
  overrides,
  testId,
}: {
  goal: GoalRoles & { startsOn?: string; targetOn?: string };
  overrides?: ScheduleOverrides;
  testId: string;
}) {
  const { range, schedule, todayStr } = useGoalSchedule(goal, overrides);
  const weekStartDay = useWeekStartDay();
  const weeks = weekBuckets(schedule, weekStartDay);
  const milestoneSet = new Set(goal.milestoneIds);
  const max = Math.max(1, ...weeks.map((w) => w.done + w.due + w.open + w.skipped));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover != null ? weeks[hover] : null;
  const thisWeek = weekStartOf(todayStr, weekStartDay);

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div
        className="relative flex h-24 items-end gap-[3px] border-b pt-3"
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${weeks.length} weeks: ${weeks.reduce((n, w) => n + w.done, 0)} done, ${weeks.reduce((n, w) => n + w.due, 0)} to come`}
      >
        {weeks.map((w, i) => {
          const total = w.done + w.due + w.open + w.skipped;
          const flag = w.once.some((o) => milestoneSet.has(o.itemId));
          return (
            <span
              key={w.start}
              onMouseEnter={() => setHover(i)}
              data-testid={`${testId}-bar`}
              className={cn('relative flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[3px]', hover === i && 'bg-muted/60', w.start === thisWeek && 'ring-foreground/40 ring-1 ring-inset')}
            >
              {flag && <Flag className="text-foreground absolute left-1/2 size-2.5 -translate-x-1/2" style={{ bottom: `calc(${(total / max) * 100}% + 2px)` }} fill="currentColor" aria-hidden />}
              <span className="flex flex-col overflow-hidden rounded-t-[2px]" style={{ height: `${(total / max) * 100}%` }}>
                <span className="bg-muted-foreground/25 block" style={{ flexGrow: w.due }} />
                <span className="bg-muted block" style={{ flexGrow: w.open + w.skipped }} />
                <span className="bg-primary block" style={{ flexGrow: w.done }} />
              </span>
            </span>
          );
        })}
      </div>
      <p className="text-muted-foreground min-h-4 text-[11px]">
        {h ? (
          <>
            Week of <span className="font-num">{formatShort(h.start)}</span> — {h.done} done
            {h.due ? `, ${h.due} to come` : ''}
            {h.once.length ? ` · ${h.once.length} one-off` : ''}
          </>
        ) : (
          rangeNote(range) ?? 'Hover a week for what lands in it.'
        )}
      </p>
      <UnscheduledTray items={schedule.unscheduled} />
    </div>
  );
}
