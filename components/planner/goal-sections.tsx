'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { CalendarClock, Flag, Moon, Target } from 'lucide-react';
import { CategoryIcon } from '@/lib/category-icons';
import { usePlannerStore } from '@/lib/planner-store';
import { fetchCheckins, getItemEventsAvailable, type ItemEvent } from '@/lib/db';
import { suppressionLabel, suppressionReason } from '@/lib/active';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { goalProgress, isAchieved, isGoalActive, nextMilestone, timeElapsed } from '@/lib/goals';
import { formatShort, useToday } from '@/lib/collections';
import { toDateOnly } from '@/lib/overdue';
import { cn } from '@/lib/utils';
import type { Goal, Item } from '@/lib/planner-types';

/**
 * goal-sections.tsx — the parts of a goal that more than one surface renders.
 *
 * The console's detail pane EDITS a goal; `/goal/[id]` READS one. What they
 * share is how a goal is *stated* — the fraction's wording, the progress track,
 * and the rule that every rendered member says whether it is actually going to
 * appear on a day. Those live here so the two surfaces cannot drift into
 * describing the same goal differently, which is the whole reason
 * item-surface-growth insists growth is a presentation and not a fork.
 *
 * See memory/plans/long-term-goals.md.
 */

/* ── the fraction, in words ───────────────────────────────────────────────── */

/**
 * "3/7", "No milestones yet", or "2/2 so far".
 *
 * The suffix is the load-bearing part. The plan's own example is a three-year
 * business with two near-term milestones defined, and a bare "2/2" there reads
 * as finished — so while the goal is still running, a full fraction says what
 * it actually means: everything defined SO FAR. Once the goal is achieved, 2/2
 * means what it says and the suffix goes.
 */
export function progressLabel(goal: Goal, achieved: number, total: number): string {
  if (total === 0) return 'No milestones yet';
  const bare = `${achieved}/${total}`;
  if (!isGoalActive(goal)) return bare;
  return achieved === total ? `${bare} so far` : bare;
}

/**
 * The bar, or nothing at all.
 *
 * Suppressed entirely at zero milestones: every goal is born there and a
 * habit-only goal stays there legitimately, so an empty track reads as a broken
 * feature rather than an unused one.
 *
 * The elapsed marker is a hairline on the SAME track, never a second bar and
 * never blended into the fill. They answer different questions — how much is
 * done, how much time is gone — and merging them would hide exactly the case
 * the pair exists to show.
 */
export function GoalProgressTrack({
  goal,
  achieved,
  total,
  className,
}: {
  goal: Goal;
  achieved: number;
  total: number;
  className?: string;
}) {
  const { todayStr } = useToday();
  if (total === 0) return null;
  const pct = Math.round((achieved / total) * 100);
  const elapsed = timeElapsed(goal, todayStr);
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="goal-progress">
      <div className="bg-muted relative h-1.5 w-full overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
        {elapsed !== null && (
          // `translateX(-100%)` past the far end, or the 1px span sits at
          // [100%, 100%+1px] — entirely outside the track's overflow-hidden.
          // timeElapsed pins at exactly 1 from the target date onward, so the
          // marker vanished precisely when the ahead/behind read matters most.
          <span
            className="bg-foreground/35 absolute inset-y-0 w-px"
            style={{
              left: `${Math.round(elapsed * 100)}%`,
              transform: elapsed >= 0.99 ? 'translateX(-100%)' : undefined,
            }}
            data-testid="goal-time-marker"
            aria-hidden
          />
        )}
      </div>
      {elapsed !== null && (
        <span className="text-muted-foreground text-[11px]">
          {Math.round(elapsed * 100)}% of the way to {formatShort(goal.targetOn!)}
        </span>
      )}
    </div>
  );
}

/* ── suppression, told rather than hidden ─────────────────────────────────── */

/**
 * Why this member will not appear on a day, or null.
 *
 * The goal surfaces are the WHY layer and never suppress anything themselves —
 * but their members can be held off by a paused routine or a switched-off
 * season, and a timeline that says "due Friday" for an item rendering on no
 * Friday column is a quiet lie. Resolved at TODAY, never a navigated date:
 * these surfaces have no date to navigate.
 */
function useSuppression() {
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const { todayStr, tz } = useToday();
  return (item: Item) =>
    suppressionReason(item, todayStr, { userTimezone: tz, routines, seasons });
}

export function GoalMemberNote({ item }: { item: Item }) {
  const reasonFor = useSuppression();
  const reason = reasonFor(item);
  if (!reason) return null;
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"
      data-testid="goal-member-hidden"
    >
      <Moon className="size-3 shrink-0" aria-hidden />
      {suppressionLabel(reason)}
    </span>
  );
}

/* ── the milestone timeline ───────────────────────────────────────────────── */

type MilestoneState = 'achieved' | 'next' | 'overdue' | 'dropped' | 'ahead';

function milestoneState(item: Item, isNext: boolean, todayStr: string): MilestoneState {
  if (item.status === 'cancelled') return 'dropped';
  if (isAchieved(item)) return 'achieved';
  // `next` OUTRANKS `overdue`, which is the opposite of the first version and
  // the difference between a timeline that points somewhere and one that does
  // not. The earliest open milestone of a goal that has slipped is BOTH — and
  // ranking overdue first meant no row was highlighted at all on exactly the
  // goals where "what now?" is the question. Lateness still shows, in the
  // caption.
  if (isNext) return 'next';
  const date = 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : null;
  if (date && date < toDateOnly(todayStr)) return 'overdue';
  return 'ahead';
}

/**
 * The checkpoints, in the order they are meant to happen.
 *
 * Being behind is annotated and never shouted: no warning colour, no badge, no
 * strike-through. Struck-through means done, and a missed checkpoint is the one
 * thing in this app that most needs to not feel like a telling-off — the
 * guilt-free law applies here harder than anywhere else it applies.
 *
 * A dropped (cancelled) milestone still renders, quietly, because it is part of
 * the record of how the goal actually went; it counts on neither side of the
 * fraction.
 */
export function MilestoneTimeline({ goal, itemsById }: { goal: Goal; itemsById: Map<string, Item> }) {
  const { todayStr } = useToday();
  const next = nextMilestone(goal, itemsById);
  // Ordered the way `nextMilestone` orders them — dated first, by date, then
  // the undated in their stored sequence. Rendering the raw membership order
  // instead made the dates jump around under a heading that claims they are in
  // the order they are meant to happen, and dropped the "next up" pip into the
  // middle of the list.
  const rows = goal.milestoneIds
    .map((id) => itemsById.get(id))
    .filter((i): i is Item => !!i)
    .sort((a, b) => {
      const da = 'startDate' in a && a.startDate ? toDateOnly(a.startDate) : null;
      const db = 'startDate' in b && b.startDate ? toDateOnly(b.startDate) : null;
      if (da && db) return da < db ? -1 : da > db ? 1 : 0;
      if (da) return -1;
      if (db) return 1;
      return 0;
    });

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No checkpoints yet. A milestone is a one-shot task whose date is the day you mean to
        have reached it.
      </p>
    );
  }

  return (
    <ol className="flex flex-col" data-testid="goal-timeline">
      {rows.map((item) => {
        const state = milestoneState(item, item.id === next?.id, todayStr);
        const date = 'startDate' in item ? item.startDate : undefined;
        const late = !!date && toDateOnly(date) < toDateOnly(todayStr);
        return (
          <li
            key={item.id}
            data-testid="goal-timeline-row"
            data-state={state}
            className="border-border flex items-start gap-3 border-l py-2.5 pl-4 last:border-l-transparent"
          >
            <span
              className={cn(
                'mt-[3px] -ml-[21px] size-2.5 shrink-0 rounded-full ring-2',
                'ring-background',
                state === 'achieved' && 'bg-primary',
                state === 'next' && 'bg-foreground',
                state === 'overdue' && 'bg-muted-foreground',
                state === 'dropped' && 'bg-muted',
                state === 'ahead' && 'bg-border',
              )}
              aria-hidden
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              {/* A link, because an undated checkpoint has to be reachable from
                  here. Inline creation deliberately leaves a milestone without
                  a date, and before this the goal offered no route at all to
                  giving it one — the timeline said "No date yet" and could not
                  be clicked. */}
              <Link
                href={`/item/${item.id}`}
                className={cn(
                  'hover:text-foreground text-sm transition-colors',
                  state === 'achieved' && 'text-muted-foreground',
                  state === 'dropped' && 'text-muted-foreground',
                  state === 'next' && 'font-medium',
                )}
              >
                {item.title}
              </Link>
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[11px]">
                {date ? formatShort(date) : 'No date yet'}
                {state === 'achieved' && <span>· reached</span>}
                {state === 'next' && <span>· next up</span>}
                {/* "Still ahead of you", not "Overdue". Same information — the
                    date is right there — in the register the rest of this app
                    uses for work that has slipped. Rendered for the NEXT row
                    too when it is late, since `next` now outranks `overdue`. */}
                {(state === 'overdue' || (state === 'next' && late)) && (
                  <span>· still ahead of you</span>
                )}
                {state === 'dropped' && <span>· dropped</span>}
                <GoalMemberNote item={item} />
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ── the supporting work ──────────────────────────────────────────────────── */

/**
 * Members grouped by type, so a goal's five habits read as a practice and its
 * three tasks read as errands.
 */
export function GoalMemberGroups({
  ids,
  itemsById,
  empty,
}: {
  ids: readonly string[];
  itemsById: Map<string, Item>;
  empty: string;
}) {
  const rows = ids.map((id) => itemsById.get(id)).filter((i): i is Item => !!i);
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;

  const byType = new Map<string, Item[]>();
  for (const item of rows) {
    const name = itemTypeName(item);
    const list = byType.get(name);
    if (list) list.push(item);
    else byType.set(name, [item]);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="goal-members">
      {[...byType.entries()].map(([typeName, group]) => {
        const config = getItemTypeConfig(typeName);
        return (
          <div key={typeName} className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
              {config.labelPlural}
            </span>
            {group.map((item) => (
              <span key={item.id} className="flex items-center gap-2 text-sm">
                <CategoryIcon glyph={config.glyph} name={typeName} className="size-3.5 shrink-0" />
                <span className="truncate">{item.title}</span>
                <GoalMemberNote item={item} />
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/* ── check-in history ─────────────────────────────────────────────────────── */

/**
 * The notes a goal has collected, newest first.
 *
 * Each row is keyed on the OCCURRENCE the note was written for, not the moment
 * it was typed — those part company as soon as someone completes Sunday's
 * check-in on Wednesday, and keyed on the wrong one a note files itself into
 * the wrong week forever.
 *
 * A note whose occurrence has since been un-completed is NOT deleted. Undoing a
 * completion says "that did not happen today"; it does not say "I never wrote
 * this". So the note stays, annotated, rather than vanishing — the same posture
 * the whole feature takes towards history it did not create.
 */
export function CheckinHistory({
  goal,
  itemsById,
}: {
  goal: Goal;
  itemsById: Map<string, Item>;
}) {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Cleared FIRST. `/goal/a` → `/goal/b` reconciles the same component
    // instance, so without this the previous goal's notes — private text —
    // keep rendering under the new goal's heading until the fetch lands.
    setEvents(null);
    fetchCheckins(goal.id).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [goal.id]);

  // Quiet when the table is not deployed or nothing has been written — the
  // ActivitySection convention: a bonus surface, never an empty state. It owns
  // its own heading for exactly that reason: a caller that wrapped it in one
  // would render the heading over nothing.
  if (!getItemEventsAvailable() || !events || events.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="goal-checkin-history">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Check-in history
      </h2>
      {events.slice(0, 24).map((e) => {
        const dateStr = typeof e.payload.dateStr === 'string' ? e.payload.dateStr : null;
        const note = typeof e.payload.note === 'string' ? e.payload.note : '';
        const item = itemsById.get(e.itemId);
        // "Orphaned" = the occurrence it was written for is no longer marked
        // done. The note is still true; only the completion was taken back.
        const orphaned =
          !!item && !!dateStr && 'completedDates' in item
            ? !(item.completedDates ?? []).includes(dateStr)
            : false;
        return (
          <div key={e.id} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground flex items-center gap-2 text-[11px]">
              {dateStr ? formatShort(dateStr) : format(new Date(e.createdAt), 'MMM d')}
              {orphaned && <span data-testid="goal-checkin-orphan">· since un-marked</span>}
            </span>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{note}</p>
          </div>
        );
      })}
    </section>
  );
}

/* ── the header summary ───────────────────────────────────────────────────── */

/** The one-line state of a goal, shared by the page header and anywhere else that needs it. */
export function GoalSummary({ goal, itemsById }: { goal: Goal; itemsById: Map<string, Item> }) {
  const { todayStr } = useToday();
  const { achieved, total } = goalProgress(goal, itemsById);
  const next = nextMilestone(goal, itemsById);
  const days =
    goal.targetOn && isGoalActive(goal)
      ? Math.round(
          (Date.parse(`${toDateOnly(goal.targetOn)}T00:00:00Z`) -
            Date.parse(`${toDateOnly(todayStr)}T00:00:00Z`)) /
            86_400_000,
        )
      : null;

  return (
    <div className="flex flex-col gap-3" data-testid="goal-summary">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <Target className="size-3.5" aria-hidden />
          {progressLabel(goal, achieved, total)}
        </span>
        {next && (
          <span className="inline-flex items-center gap-1.5">
            <Flag className="size-3.5" aria-hidden />
            next: {next.title}
            {'startDate' in next && next.startDate ? ` · ${formatShort(next.startDate)}` : ''}
          </span>
        )}
        {days !== null && (
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden />
            {days > 0
              ? `${days} ${days === 1 ? 'day' : 'days'} to ${formatShort(goal.targetOn!)}`
              : days === 0
                ? 'target is today'
                : `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} past ${formatShort(goal.targetOn!)}`}
          </span>
        )}
      </div>
      <GoalProgressTrack goal={goal} achieved={achieved} total={total} />
    </div>
  );
}
