'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { SkipForward } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useToday } from '@/lib/collections';
import { milestoneItemIds } from '@/lib/goals';
import { useContainerSchedule } from '@/components/planner/schedule/schedule-views';
import { useVerbs } from '@/components/planner/organize/member-row-actions';
import { cn } from '@/lib/utils';
import { ItemTick, springItemCheck } from '@/components/primitives/item-check';
import { todayInOrder, type OccurrenceState } from '@/lib/container-schedule';
import {
  ROUTINE_TODAY_FINISHED,
  ROUTINE_TODAY_NEXT,
  routineTodayEmpty,
  routineTodaySummaryRuns,
} from '@/lib/organize-copy';
import { CopyRuns } from '@/components/primitives/copy-runs';
import type { Item, Routine } from '@/lib/planner-types';

/**
 * TODAY, IN ORDER — a routine run top to bottom.
 *
 * A routine is things done regularly, together, and usually in a sequence: the
 * morning is water, then stretch, then journal. The console could already
 * reorder members (`routine_items.sort_order`) and tick them one row at a time,
 * but nothing READ the order back as what it is — a checklist. This is that:
 * today's members, in the routine's order, with the first open one called out
 * as "next" and a count of how far through you are.
 *
 * Nothing here decides anything new, which is the whole reason it is small:
 *  · WHICH members are on today is the grid's own answer, through
 *    useContainerSchedule (deriveDayItems + inactiveItemIdsOn for the day) — a
 *    weekday habit on a Saturday is not listed, and a paused routine lists
 *    nothing, because it lists nothing on the grid either.
 *  · A tick or a skip is the console member row's verb (useVerbs in
 *    member-row-actions.tsx), so counted habits step, a skipped day unskips
 *    rather than completing, and a page left open past midnight refuses to
 *    write to a day it did not show.
 *
 * Guilt-free, like every chart in lib/container-schedule.ts: an unticked member
 * is "open", never "missed", and nothing here turns amber at any hour.
 */

interface TodayRow {
  item: Item;
  state: OccurrenceState;
}

export function RoutineToday({ routine, testId = 'routine-today' }: { routine: Routine; testId?: string }) {
  const items = usePlannerStore((s) => s.items);
  const goals = usePlannerStore((s) => s.goals);
  const { todayStr } = useToday();
  const milestoneIds = useMemo(() => milestoneItemIds(goals ?? []), [goals]);
  const schedule = useContainerSchedule(routine.itemIds, todayStr, 1);

  // Today's members in the routine's order, and how far through: one rule,
  // shared with the iPhone (lib/container-schedule.ts todayInOrder).
  const run = useMemo(() => todayInOrder(schedule, routine.itemIds, todayStr), [schedule, routine.itemIds, todayStr]);
  const rows = useMemo<TodayRow[]>(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return run.rows
      .map((r) => ({ item: byId.get(r.itemId), state: r.state }))
      .filter((r): r is TodayRow => !!r.item);
  }, [items, run]);

  const { done, skipped, nextId, finished } = run;
  const summary = routineTodaySummaryRuns(done, rows.length, skipped);

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        {/* No usual time here: both hosts already state it, once — the page in
            its header line, the console pane on its "Usually at" chip. */}
        <p className="text-muted-foreground text-xs" data-testid={`${testId}-summary`}>
          {summary && <CopyRuns runs={summary} />}
        </p>
        {finished && (
          <p className="text-foreground text-xs font-medium" data-testid={`${testId}-finished`}>
            {ROUTINE_TODAY_FINISHED}
          </p>
        )}
      </div>

      {rows.length > 0 && (
        // Its own element, never a parent's opacity: the lime fill must stay
        // at full strength (CLAUDE.md, the accent rule).
        <div className="bg-muted h-1 overflow-hidden rounded-full" aria-hidden>
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200"
            style={{ width: `${((done + skipped) / rows.length) * 100}%` }}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid={`${testId}-empty`}>
          {routineTodayEmpty(routine.name, routine.itemIds.length)}
        </p>
      ) : (
        <ol className="flex flex-col gap-px">
          {rows.map((row, i) => (
            <TodayRowView
              key={row.item.id}
              row={row}
              index={i + 1}
              next={row.item.id === nextId}
              todayStr={todayStr}
              milestoneIds={milestoneIds}
              testId={testId}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function TodayRowView({
  row,
  index,
  next,
  todayStr,
  milestoneIds,
  testId,
}: {
  row: TodayRow;
  index: number;
  next: boolean;
  todayStr: string;
  milestoneIds: ReadonlySet<string>;
  testId: string;
}) {
  const { item, state } = row;
  const v = useVerbs(item, state, todayStr, milestoneIds);
  const resolved = state === 'done' || state === 'skipped';
  return (
    <li
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-[6px] px-2',
        next ? 'bg-accent' : 'hover:bg-accent/60'
      )}
      data-testid={`${testId}-row`}
      data-item-id={item.id}
      data-state={state}
      data-next={next || undefined}
    >
      <span className="text-muted-foreground font-num w-4 shrink-0 text-right text-2xs">{index}</span>
      <button
        type="button"
        disabled={!v.tick}
        onClick={(e) => {
          if (state !== 'done') springItemCheck(e.currentTarget);
          v.tick?.run();
        }}
        aria-label={v.tick?.label ?? item.title}
        data-testid={`${testId}-tick`}
        className={cn(
          'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] inset-ring transition-[background-color,box-shadow] disabled:cursor-default',
          state === 'done'
            ? 'inset-ring-primary bg-primary'
            : 'inset-ring-muted-foreground/45 bg-surface-3 hover:inset-ring-primary'
        )}
      >
        {state === 'done' && <ItemTick />}
        {state === 'skipped' && <SkipForward className="text-muted-foreground h-2.5 w-2.5" />}
      </button>
      {/* Closes the console on the way out when this renders inside it — the
          item page cannot sit over the console. onNavigate, not onClick, so a
          ⌘-click into a new tab keeps it open. A no-op on the routine page. */}
      <Link
        href={`/item/${item.id}`}
        onNavigate={() => useUIStore.getState().closeDialog()}
        className={cn(
          'min-w-0 flex-1 truncate text-sm hover:underline',
          resolved ? 'text-muted-foreground line-through decoration-1' : 'text-foreground'
        )}
      >
        {item.title}
      </Link>
      {next && <span className="text-muted-foreground shrink-0 text-2xs">{ROUTINE_TODAY_NEXT}</span>}
      {v.skip && (
        <button
          type="button"
          onClick={v.skip}
          aria-label={`Skip ${item.title} today`}
          data-testid={`${testId}-skip`}
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px]"
        >
          <SkipForward className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}
