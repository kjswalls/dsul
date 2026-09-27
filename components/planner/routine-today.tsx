'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Check, SkipForward } from 'lucide-react';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { useToday } from '@/lib/collections';
import { milestoneItemIds } from '@/lib/goals';
import { useContainerSchedule } from '@/components/planner/schedule/schedule-views';
import { useVerbs } from '@/components/planner/organize/member-row-actions';
import { cn } from '@/lib/utils';
import type { OccurrenceState } from '@/lib/container-schedule';
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

  const rows = useMemo<TodayRow[]>(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const position = new Map(routine.itemIds.map((id, i) => [id, i]));
    const today = schedule.days.find((d) => d.date === todayStr);
    return (today?.occurrences ?? [])
      .map((o) => ({ item: byId.get(o.itemId), state: o.state }))
      .filter((r): r is TodayRow => !!r.item)
      .sort((a, b) => (position.get(a.item.id) ?? 0) - (position.get(b.item.id) ?? 0));
  }, [items, routine.itemIds, schedule, todayStr]);

  const done = rows.filter((r) => r.state === 'done').length;
  const skipped = rows.filter((r) => r.state === 'skipped').length;
  const nextId = rows.find((r) => r.state === 'due')?.item.id;
  const finished = rows.length > 0 && !nextId;

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3">
        {/* No usual time here: both hosts already state it, once — the page in
            its header line, the console pane on its "Usually at" chip. */}
        <p className="text-muted-foreground text-xs" data-testid={`${testId}-summary`}>
          {rows.length > 0 && (
            <>
              <span className="font-num">{done}</span> of <span className="font-num">{rows.length}</span> done
              {skipped > 0 && (
                <>
                  {' · '}
                  <span className="font-num">{skipped}</span> skipped
                </>
              )}
            </>
          )}
        </p>
        {finished && (
          <p className="text-foreground text-xs font-medium" data-testid={`${testId}-finished`}>
            All through for today.
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
          {routine.itemIds.length === 0
            ? 'Nothing is in it yet.'
            : `Nothing from ${routine.name} is on today.`}
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
        onClick={v.tick?.run}
        aria-label={v.tick?.label ?? item.title}
        data-testid={`${testId}-tick`}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors disabled:cursor-default',
          state === 'done'
            ? 'border-primary bg-primary'
            : 'border-muted-foreground/45 bg-surface-3 hover:border-primary'
        )}
      >
        {state === 'done' && <Check className="text-primary-foreground h-2.5 w-2.5" />}
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
      {next && <span className="text-muted-foreground shrink-0 text-2xs">next</span>}
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
