'use client';

import { useState } from 'react';
import { CalendarRange, Trash2 } from 'lucide-react';
import { ChoiceChip, ColorChip, DateRangeChip } from '@/components/primitives/organizer-chips';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { inactiveItemIdsOn, isSeasonActiveOn } from '@/lib/active';
import {
  byName,
  countLive,
  formatShort,
  matching,
  seasonPillLabel,
  useLiveItemIds,
  useLiveRoutineIds,
  useToday,
} from '@/lib/collections';
import { ObjectRow } from '../primitives';
import {
  DetailColumn,
  OpenAsPageLink,
  DetailHead,
  ListColumn,
  SectionWelcome,
  StatusStrip,
  TitleRow,
} from '../detail-parts';
import { ItemMemberList, MEMBER_ROW_TRAILING_PAD_WITH_MENU, RoutineMemberList } from '../member-list';
import { useMemberActions } from '../member-row-actions';
import {
  ScheduleHeading,
  SeasonHeatmap,
  useWeekDotsFor,
} from '@/components/planner/schedule/schedule-views';
import { containerMemberIds } from '@/lib/container-schedule';
import { ContainerCreateForm } from '../container-create-form';
import { seasonStates } from '../container-fields';
import type { Item, Season, Routine } from '@/lib/planner-types';

/**
 * SEASONS — a stretch of life that switches whole routines on and off.
 *
 * Moved from ManageCollectionsDialog with every data-testid intact
 * (memory/plans/organize-console.md, Phase 2). The three things worth knowing
 * before changing anything here are all about the tri-state:
 *
 *   On / Off are MANUAL OVERRIDES and always win — a person who flips a season
 *   by hand ("we came back early") must never be second-guessed by a date they
 *   set weeks ago. Only Dates is date-resolved, which is why the range renders
 *   under Dates alone: pickers beside On or Off would be controls with no
 *   effect. The dates stay on the row meanwhile, waiting.
 */
export function SeasonsSection({
  selectedId,
  onSelect,
  creating,
  onNew,
  onCreated,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  creating: boolean;
  onNew: () => void;
  onCreated: (id: string | null) => void;
}) {
  const seasons = usePlannerStore((s) => s.seasons);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const liveIds = useLiveItemIds();
  const liveRoutineIds = useLiveRoutineIds();
  const { todayStr } = useToday();

  const [query, setQuery] = useState('');

  const selected = seasons.find((p) => p.id === selectedId) ?? null;
  const visible = matching(seasons, query, byName);
  const canCreate = collectionsAvailable && !!userId && !isLoading;
  const showCreate = canCreate && (creating || seasons.length === 0);

  return (
    <>
      <ListColumn
        eyebrow="SEASONS"
        count={visible.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter seasons…',
          testId: 'season-filter',
        }}
        onNew={{
          onClick: onNew,
          label: 'New season',
          testId: 'season-new',
          disabled: !canCreate,
        }}
      >
        {!collectionsAvailable ? (
          <p
            className="text-muted-foreground px-[7px] pt-2 text-xs"
            data-testid="collections-unavailable"
          >
            Routines and seasons aren&apos;t available on this account yet.
          </p>
        ) : seasons.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No seasons yet.</p>
        ) : (
          visible.map((season) => (
            <ObjectRow
              key={season.id}
              testId="season-row"
              idAttr={{ 'data-season-id': season.id }}
              icon={season.icon}
              color={season.color}
              name={season.name}
              selected={selectedId === season.id}
              pill={seasonPillLabel(season, todayStr)}
              pillTestId="season-state-pill"
              // Both member arrays. Routines are the members a season is
              // usually built out of, and one holding only routines would
              // otherwise read as empty.
              count={
                countLive(season.itemIds, liveIds) +
                countLive(season.routineIds, liveRoutineIds)
              }
              onSelect={() => onSelect(season.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <ContainerCreateForm
            kind="season"
            autoFocus={creating}
            onCreated={onCreated}
            onCancel={seasons.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          <SeasonDetail season={selected} onBack={() => onSelect(null)} />
        ) : (
          <SectionWelcome section="seasons">
            A season is a stretch of life — a summer, a term — that switches whole routines on
            and off.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

function SeasonDetail({ season, onBack }: { season: Season; onBack: () => void }) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const updateSeason = usePlannerStore((s) => s.updateSeason);
  const setSeasonState = usePlannerStore((s) => s.setSeasonState);
  const swapToSeason = usePlannerStore((s) => s.swapToSeason);
  const removeSeason = usePlannerStore((s) => s.removeSeason);
  const confirm = useUIStore((s) => s.confirm);
  const liveIds = useLiveItemIds();
  const liveRoutineIds = useLiveRoutineIds();
  const { todayStr, tz } = useToday();

  const live = isSeasonActiveOn(season, todayStr);
  const members = season.itemIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  const routineMembers = season.routineIds
    .map((id) => routines.find((r) => r.id === id))
    .filter((r): r is Routine => !!r);

  const itemCount = countLive(season.itemIds, liveIds);
  const week = useWeekDotsFor(season.itemIds);
  const controls = useMemberActions({
    ownerName: season.name,
    onRemove: (id) => updateSeason(season.id, { itemIds: season.itemIds.filter((m) => m !== id) }),
    todayState: week.todayState,
  });
  // Its routines' members ride along when it is on, so they are on its calendar.
  const calendarIds = containerMemberIds({ kind: 'season', season }, items, routines);
  const routineCount = countLive(season.routineIds, liveRoutineIds);

  // The swap verb only earns its place when there is something to swap AWAY
  // from. With no other season on, "Switch to this" and "On" would be the same
  // button wearing two labels.
  const displaced = seasons.filter((p) => p.id !== season.id && isSeasonActiveOn(p, todayStr));

  /**
   * How many items an attach would ACTUALLY hide, asked of the resolver by
   * simulating the join rather than counting members.
   *
   * A raw member count is wrong three ways at once: members already hidden by
   * the routine's own pause, members the user paused by hand, and members held
   * by a second live season all count toward it while none of them would move.
   * At worst that produces a confirm saying "this will hide 5 items" for a write
   * that hides nothing — which teaches the user to dismiss the prompt unread,
   * and this is the one prompt in the app that has something to say.
   */
  const wouldHide = (routine: Routine): number => {
    const ctx = { userTimezone: tz, routines, seasons };
    const before = inactiveItemIdsOn(items, todayStr, ctx);
    const after = inactiveItemIdsOn(items, todayStr, {
      ...ctx,
      seasons: seasons.map((p) =>
        p.id === season.id ? { ...p, routineIds: [...p.routineIds, routine.id] } : p
      ),
    });
    let n = 0;
    for (const id of after) if (!before.has(id)) n += 1;
    return n;
  };

  const attach = (routine: Routine) =>
    updateSeason(season.id, { routineIds: [...season.routineIds, routine.id] });

  /**
   * The attach discontinuity, said out loud (programs-routines decision 3).
   *
   * A routine that belongs to NO season answers for itself. Put it in its first
   * season and the season answers too — so attaching a live routine to a
   * season that is off makes its items vanish from today as a side effect of a
   * join write. That is the algebra working as designed (scoping a routine IS
   * the point), but an unannounced "5 items disappeared" reads as a bug.
   */
  const requestAttach = (routine: Routine) => {
    // Only the FIRST season a routine joins rescopes it. A second is purely
    // additive — the path algebra is disjunctive — so warning there would train
    // the user to dismiss the prompt that matters.
    const heldElsewhere = seasons.some(
      (p) => p.id !== season.id && p.routineIds.includes(routine.id)
    );
    const hides = heldElsewhere ? 0 : wouldHide(routine);
    if (hides === 0) {
      attach(routine);
      return;
    }
    const returns =
      season.state === 'auto' && season.startsOn && todayStr < season.startsOn
        ? formatShort(season.startsOn)
        : null;
    confirm({
      title: `This will hide ${hides} ${hides === 1 ? 'item' : 'items'} for now`,
      description:
        `“${routine.name}” looks after itself today. Putting it in ${season.name} hands that ` +
        `over — and ${season.name} is off, so its ${hides} ${hides === 1 ? 'item' : 'items'} ` +
        `${returns ? `come back on ${returns}` : 'stay hidden until you switch it on'}. ` +
        `Nothing is deleted, and taking it back out restores them.`,
      confirmLabel: 'Add it anyway',
      testId: 'season-routine-attach-confirm',
      onConfirm: () => attach(routine),
    });
  };

  const requestDelete = () =>
    confirm({
      title: 'Delete this season?',
      description: deleteConsequence(season, itemCount, routineCount, live),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        removeSeason(season.id);
        onBack();
      },
    });

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="season-detail"
      data-season-id={season.id}
    >
      <DetailHead
        kind="Season"
        color={season.color}
        name={season.name}
        testPrefix="season"
        back={{ label: 'Seasons', testId: 'season-detail-back', onBack }}
        actions={<OpenAsPageLink href={`/season/${season.id}`} testId="season-open-page" />}
        menu={[
          {
            label: 'Delete season',
            icon: <Trash2 className="size-3.5" />,
            testId: 'season-delete',
            destructive: true,
            onSelect: requestDelete,
          },
        ]}
      />

      <TitleRow
        id={season.id}
        name={season.name}
        icon={season.icon}
        label="Calendar"
        testPrefix="season"
        onPatch={(patch) => updateSeason(season.id, patch)}
      />

      <StatusStrip
        testId="season-state-note"
        icon={<CalendarRange className="size-3.5" aria-hidden />}
      >
        <SeasonStateNote season={season} live={live} />
      </StatusStrip>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* setSeasonState DIRECTLY, never through updateSeason: it stamps its
            own history label and its own optimistic `updatedAt`, and routing
            through the generic update stamps "Edit season" and lands the
            intended label on the user's NEXT action. */}
        <ChoiceChip
          label="Status"
          value={season.state}
          options={seasonStates(live)}
          testIdPrefix="season-state"
          onChange={(state) => setSeasonState(season.id, state)}
        />
        {/* Under Dates alone: On and Off are manual overrides that always win,
            so a range beside them would be a control with no effect. The dates
            stay on the row meanwhile, waiting. The chip fences start ≤ end — an
            inverted range is live on NO date, so every member would vanish
            while the note cheerfully reported "Runs Sep 1 to Aug 1". Both ends
            are included, as the note says. */}
        {season.state === 'auto' && (
          <DateRangeChip
            start={season.startsOn}
            end={season.endsOn}
            startLabel="Starts"
            endLabel="Ends"
            emptyLabel="Runs"
            testIdPrefix="season-runs"
            onChange={(startsOn, endsOn) => updateSeason(season.id, { startsOn, endsOn })}
          />
        )}
        <ColorChip
          value={season.color}
          testId="season-color"
          onChange={(color) => updateSeason(season.id, { color })}
        />
      </div>

      {!live && displaced.length > 0 && (
        <button
          type="button"
          onClick={() => swapToSeason(season.id)}
          data-testid="season-swap"
          className="border-border hover:bg-accent flex flex-col items-start gap-0.5 self-start rounded-[5px] border px-3 py-2 text-left"
        >
          <span className="text-foreground text-sm font-medium">Switch to this season</span>
          <span className="text-muted-foreground text-xs">
            Turns off {displaced.map((p) => p.name).join(', ')}. One undo puts it all back.
          </span>
        </button>
      )}

      <section className="flex flex-col gap-2" data-testid="season-calendar">
        <ScheduleHeading label="Calendar" />
        <SeasonHeatmap season={season} memberIds={calendarIds} />
      </section>

      <div className="mt-1.5 flex flex-col gap-5">
        <RoutineMemberList
          season={season}
          live={live}
          members={routineMembers}
          candidates={routines.filter((r) => !season.routineIds.includes(r.id))}
          onRequestAttach={requestAttach}
          onRemove={(routineId) =>
            updateSeason(season.id, {
              routineIds: season.routineIds.filter((id) => id !== routineId),
            })
          }
        />

        {/* NOT orderable, and not a taste call: `routine_items` carries a
            `sort_order` column and `season_items` does not, so an order
            arranged here would survive until the next fetch and then silently
            reshuffle. */}
        <ItemMemberList
        openItems
          label="Items"
          ownerId={season.id}
          ownerName={season.name}
          memberIds={season.itemIds}
          members={members}
          // The resolver's per-item answer, not this season's state — same
          // correction the routine pane needed. `!live` greyed items a second
          // live path was still carrying, and drew items at full contrast while
          // their own pause kept them off the grid.
          hiddenIds={inactiveItemIdsOn(items, todayStr, {
            userTimezone: tz,
            routines,
            seasons,
          })}
          testPrefix="season"
          lead={members.length > 0 ? week.header(MEMBER_ROW_TRAILING_PAD_WITH_MENU) : undefined}
          row={{ trailing: week.trailing, ...controls }}
          onChange={(itemIds) => updateSeason(season.id, { itemIds })}
        />
      </div>
    </div>
  );
}

/**
 * What deleting actually does — and the half of it a user would never guess.
 *
 * Trashing a season REMOVES ITS PATHS, so a routine it was the only holder of
 * falls back to standalone and its members reappear. "Delete" reads as
 * subtraction; here it can add rows back to today's grid, and that has to be on
 * the button rather than discovered afterwards.
 */
function deleteConsequence(
  season: Season,
  itemCount: number,
  routineCount: number,
  live: boolean
): string {
  const held = [
    itemCount > 0 ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : null,
    routineCount > 0 ? `${routineCount} ${routineCount === 1 ? 'routine' : 'routines'}` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    `“${season.name}” is removed` +
    (held ? `, but the ${held} it holds stay exactly as they are` : '') +
    (!live && (itemCount > 0 || routineCount > 0)
      ? ' — and anything it was hiding comes back into view'
      : '') +
    '.'
  );
}

/** The four ways a season can be, in the season's own words. Shared with /season/[id]. */
export function SeasonStateNote({ season, live }: { season: Season; live: boolean }) {
  if (season.state === 'active') {
    return <>On until you say otherwise — dates are ignored while it is set this way.</>;
  }
  if (season.state === 'paused') {
    return <>Off. Everything it holds is hidden, and streaks and history stay exactly as they are.</>;
  }
  if (!season.startsOn && !season.endsOn) {
    return <>Always on. Give it a start or an end to make it follow the calendar.</>;
  }
  const from = season.startsOn ? formatShort(season.startsOn) : null;
  const to = season.endsOn ? formatShort(season.endsOn) : null;
  const span = from && to ? `${from} to ${to}` : from ? `from ${from}` : `until ${to}`;
  return (
    <>
      Runs {span}, inclusive. {live ? 'On now.' : 'Off right now — nothing it holds is showing.'}
    </>
  );
}
