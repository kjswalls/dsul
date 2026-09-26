'use client';

import { useState } from 'react';
import { Layers, Moon, Trash2 } from 'lucide-react';
import {
  ChoiceChip,
  ColorChip,
  OrganizerSection,
} from '@/components/primitives/organizer-chips';
import { CategoryIcon } from '@/lib/category-icons';
import { usePlannerStore } from '@/lib/planner-store';
// The shell's shared AlertDialog, rendered once in AppShell. Using it rather
// than a local <AlertDialog> keeps the console's confirms on the same surface
// as every other destructive prompt in the app — and keeps the plate free of a
// second dismissable layer competing for Escape.
import { useUIStore } from '@/lib/ui-store';
import {
  inactiveItemIdsOn,
  membersRevealedByRemoving,
  programResumeDate,
  routineStandingOn,
} from '@/lib/active';
import {
  byName,
  countLive,
  formatShort,
  matching,
  parseDay,
  routinePillLabel,
  useLiveItemIds,
  useToday,
} from '@/lib/collections';
import { ObjectRow } from '../primitives';
import {
  DayChip,
  OpenAsPageLink,
  DetailColumn,
  DetailHead,
  ListColumn,
  SectionWelcome,
  StatusStrip,
  TitleRow,
} from '../detail-parts';
import { ContainerCreateForm } from '../container-create-form';
import { ROUTINE_STATES } from '../container-fields';
import { ItemMemberList, MEMBER_ROW_TRAILING_PAD_WITH_MENU } from '../member-list';
import { useMemberActions } from '../member-row-actions';
import { useWeekDotsFor } from '@/components/planner/schedule/schedule-views';
import { cn } from '@/lib/utils';
import type { Item, Program, Routine } from '@/lib/planner-types';

/**
 * IN N PROGRAMS — the reverse view, which exists nowhere else in the app.
 *
 * Membership has only ever been navigable downwards: a program lists its
 * routines, and from a routine you could not see what was answering for it. That
 * is fine until a program holds the routine OFF, at which point the one thing
 * the user needs is the name of the thing overruling them and a way to get to
 * it — and the only route was to guess which program it was and open each one.
 *
 * Rows are buttons, and land on that program's detail in the Programs section.
 * `off` is stated as a word rather than encoded in luminance alone: this list is
 * short, mixed, and the distinction is the entire reason it is on screen.
 */
function ProgramHolders({
  holders,
  blockerIds,
  routineOn,
  onOpen,
}: {
  holders: readonly Program[];
  blockerIds: ReadonlySet<string>;
  /** The routine's own switch. A program cannot carry a routine that is paused. */
  routineOn: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <OrganizerSection label="In programs" count={holders.length} testId="routine-holders">
      {/* Plain overflow-y-auto: <ScrollArea> silently drops max-h. */}
      <div className="max-h-32 space-y-px overflow-y-auto">
        {holders.map((program) => {
          const off = blockerIds.has(program.id);
          // THREE states, not two. A program that is on but whose routine is
          // paused is neither off nor carrying — saying "carrying" there
          // contradicted the pause note directly above it.
          const state = off ? 'off' : routineOn ? 'carrying' : 'idle';
          return (
            <button
              key={program.id}
              type="button"
              onClick={() => onOpen(program.id)}
              data-testid="routine-holder"
              data-program-id={program.id}
              data-holder-state={state}
              className="hover:bg-accent focus-visible:outline-ring flex h-[30px] w-full items-center gap-[9px] rounded-[5px] px-[7px] text-left focus-visible:outline-1 focus-visible:outline-solid"
            >
              <span className="flex w-[18px] shrink-0 justify-center">
                <CategoryIcon glyph={program.icon} name={program.name} className="h-3.5 w-3.5" />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-sm',
                  off ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {program.name}
              </span>
              <span className="text-muted-foreground w-[64px] shrink-0 text-right text-2xs">
                {state === 'idle' ? 'on' : state}
              </span>
            </button>
          );
        })}
      </div>
    </OrganizerSection>
  );
}

/**
 * ROUTINES — the section that goes first, because it is the object people
 * garden most and the one the "New routine or program" entry lands on.
 *
 * Moved from ManageCollectionsDialog with every data-testid intact
 * (memory/plans/organize-console.md, Phase 2). One thing is genuinely new and
 * it is a correctness fix rather than a feature: the "Comes back" resume date,
 * which wires `setRoutinePaused`'s THIRD ARGUMENT — a parameter the store has
 * always taken and which no call site in the app has ever passed, while
 * `pausedUntil` is *read* in three places.
 */
export function RoutinesSection({
  selectedId,
  onSelect,
  onOpenProgram,
  creating,
  onNew,
  onCreated,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Cross-section jump, for the reverse view — see ProgramHolders. */
  onOpenProgram: (id: string) => void;
  creating: boolean;
  onNew: () => void;
  onCreated: (id: string | null) => void;
}) {
  const routines = usePlannerStore((s) => s.routines);
  // For the pill: a routine held off by a program is not "Paused", and saying
  // nothing at all made the list column disagree with the detail beside it.
  const programs = usePlannerStore((s) => s.programs);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const liveIds = useLiveItemIds();
  const { todayStr, tz } = useToday();

  const [query, setQuery] = useState('');

  const selected = routines.find((r) => r.id === selectedId) ?? null;
  const visible = matching(routines, query, byName);

  // The three-part signal, not the flag alone: a container created inside the
  // load window is silently erased when initializeStore's set() replaces
  // `routines`, and the user then owns two.
  const canCreate = collectionsAvailable && !!userId && !isLoading;
  // A section with nothing in it opens straight into the form: "make your first
  // routine" and "make another" are then the same screen, and the definition
  // does its teaching as the form's hint rather than as a line you cannot act on.
  const showCreate = canCreate && (creating || routines.length === 0);

  return (
    <>
      <ListColumn
        eyebrow="ROUTINES"
        count={visible.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter routines…',
          testId: 'routine-filter',
        }}
        onNew={{
          onClick: onNew,
          label: 'New routine',
          testId: 'routine-new',
          disabled: !canCreate,
        }}
      >
        {!collectionsAvailable ? (
          <p
            className="text-muted-foreground px-[7px] pt-2 text-xs"
            data-testid="collections-unavailable"
          >
            Routines and programs aren&apos;t available on this account yet.
          </p>
        ) : routines.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No routines yet.</p>
        ) : (
          visible.map((routine) => (
            <ObjectRow
              key={routine.id}
              testId="routine-row"
              idAttr={{ 'data-routine-id': routine.id }}
              icon={routine.icon}
              color={routine.color}
              name={routine.name}
              selected={selectedId === routine.id}
              pill={routinePillLabel(routine, todayStr, tz, programs)}
              pillTestId="routine-paused-pill"
              count={countLive(routine.itemIds, liveIds)}
              onSelect={() => onSelect(routine.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <ContainerCreateForm
            kind="routine"
            autoFocus={creating}
            onCreated={onCreated}
            // Nothing to cancel back to when the list is empty.
            onCancel={routines.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          <RoutineDetail
            routine={selected}
            onBack={() => onSelect(null)}
            onOpenProgram={onOpenProgram}
          />
        ) : (
          <SectionWelcome section="routines">A routine groups items you want to pause together.</SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

function RoutineDetail({
  routine,
  onBack,
  onOpenProgram,
}: {
  routine: Routine;
  onBack: () => void;
  onOpenProgram: (id: string) => void;
}) {
  const items = usePlannerStore((s) => s.items);
  const programs = usePlannerStore((s) => s.programs);
  // The WHOLE list, not just this one: the resolver has to see every path a
  // member might reach the day by, or it re-answers the container's question.
  const routines = usePlannerStore((s) => s.routines);
  const updateRoutine = usePlannerStore((s) => s.updateRoutine);
  const setRoutinePaused = usePlannerStore((s) => s.setRoutinePaused);
  const removeRoutine = usePlannerStore((s) => s.removeRoutine);
  const confirm = useUIStore((s) => s.confirm);
  const liveIds = useLiveItemIds();
  const { todayStr, tz } = useToday();

  /**
   * Local AND effective, from the same helper (`routineStandingOn`) the scope
   * view-model and the Display menu's Paused-scopes list use.
   *
   * This pane used to resolve `isPausedOn` alone, which is only the routine's
   * OWN switch — so a routine held off by a program showed `Active`, with its
   * members at full contrast and a delete confirm promising items would "come
   * back into view", while the rail one column away reported it off. Both were
   * reading the same store.
   *
   * The segmented control still writes and shows LOCAL, because that is the
   * value it owns.
   *
   * BUT `standing` IS NOT AN ANSWER ABOUT THE ITEMS, and the first version of
   * this pane spent it as though it were. `effectiveOn` says whether this
   * ROUTINE is carrying anything; whether a given MEMBER is on the user's day is
   * a different question, and it differs precisely when the item has a second
   * live path — the situation the disjunctive rule exists to create. So the
   * greying and the delete consequence go through the resolver per item
   * (`hiddenIds`, `revealed`), and only the note — a statement about the routine
   * — reads `standing`.
   */
  const standing = routineStandingOn(routine, programs, todayStr, tz);
  const paused = !standing.localOn;
  const ctx = { userTimezone: tz, routines, programs };
  // Local noon, so the picker's bound is a calendar day rather than an instant
  // — and derived from the USER's today, not the browser's.
  const today = parseDay(todayStr)!;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
  const members = routine.itemIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);

  // Which programs hold this routine — a reverse view that does not exist
  // anywhere in the app today. From a routine you currently cannot see what is
  // answering for it.
  const heldBy = standing.holders;
  const liveCount = countLive(routine.itemIds, liveIds);
  // This week, per member, as the grid will draw it — the rhythm grid folded
  // into the list it would otherwise repeat.
  const week = useWeekDotsFor(routine.itemIds);
  const controls = useMemberActions({
    ownerName: routine.name,
    onRemove: (id) => updateRoutine(routine.id, { itemIds: routine.itemIds.filter((m) => m !== id) }),
    todayState: week.todayState,
  });

  /** Members not on the user's day right now — the resolver's answer, per item. */
  const hiddenIds = inactiveItemIdsOn(items, todayStr, ctx);
  /**
   * The members deleting this routine would actually put back — a delta, not a
   * flag. Items another routine is already carrying do not "come back", and
   * neither do items the same program holds directly.
   */
  const revealed = membersRevealedByRemoving(routine.id, routine.itemIds, items, ctx, todayStr);
  const reappear = revealed.length > 0;
  /** Of this routine's members, the ones its being held off is actually costing. */
  const hiddenHere = routine.itemIds.filter((id) => hiddenIds.has(id)).length;

  const consequence = `“${routine.name}” is removed, but its ${liveCount} ${
    liveCount === 1 ? 'item stays' : 'items stay'
  } exactly as ${liveCount === 1 ? 'it is' : 'they are'} — ${
    liveCount === 1 ? 'it' : 'they'
  } just stop being grouped${reappear ? ', and they come back into view' : ''}.`;

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="routine-detail"
      data-routine-id={routine.id}
    >
      <DetailHead
        kind="Routine"
        color={routine.color}
        name={routine.name}
        testPrefix="routine"
        back={{ label: 'Routines', testId: 'routine-detail-back', onBack }}
        actions={<OpenAsPageLink href={`/routine/${routine.id}`} testId="routine-open-page" />}
        menu={[
          /* `reappear` reads EFFECTIVE, not the local pause. Deleting the
             routine removes the whole activation path, so items held out of
             sight by a PROGRAM come back exactly as ones held out by the
             routine's own switch do — and the local-only version stayed silent
             about it, which is the half of the sentence a user would want
             before pressing Delete. */
          {
            label: 'Delete routine',
            icon: <Trash2 className="size-3.5" />,
            testId: 'routine-delete',
            destructive: true,
            onSelect: () =>
              confirm({
                title: 'Delete this routine?',
                description: consequence,
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () => {
                  removeRoutine(routine.id);
                  onBack();
                },
              }),
          },
        ]}
      />

      <TitleRow
        id={routine.id}
        name={routine.name}
        icon={routine.icon}
        label="Routine"
        testPrefix="routine"
        onPatch={(patch) => updateRoutine(routine.id, patch)}
      />

      {paused && (
        <StatusStrip testId="routine-paused-note" icon={<Moon className="size-3.5" aria-hidden />}>
          {routine.pausedUntil
            ? `Its items come back on ${formatShort(routine.pausedUntil)}, on their own.`
            : 'Its items are hidden until you resume.'}{' '}
          Streaks and history stay exactly as they are.
        </StatusStrip>
      )}

      {/* The override, and the whole reason this pane needed the effective
          split. The chip says Active and is telling the truth about the value
          it writes; this says what that value is currently achieving, which is
          nothing. Rendered only when the two disagree — a routine that is
          simply on has nothing to explain.

          TWO SENTENCES, AND THEY ARE ABOUT DIFFERENT SUBJECTS. The first is
          about the ROUTINE and is always true here: every program holding it is
          off, so it is not carrying anything. The second is about its ITEMS, and
          is only true of the ones actually off the grid — the first version ran
          them together as "so its items are hidden anyway", which lied for every
          member some other routine was still carrying. */}
      {standing.localOn && !standing.effectiveOn && standing.soonestBlocker && (
        <StatusStrip testId="routine-held-note" icon={<Layers className="size-3.5" aria-hidden />}>
          {standing.blockers.length === 1 ? (
            <>
              &ldquo;{standing.soonestBlocker.name}&rdquo; is off, so this routine isn&rsquo;t
              carrying anything right now.
            </>
          ) : (
            <>
              All <span className="font-num">{standing.blockers.length}</span> programs holding it
              are off, so this routine isn&rsquo;t carrying anything right now.
            </>
          )}{' '}
          {/* The soonest holder to return, because the rule is disjunctive: the
              FIRST program back carries the routine, whatever the others do. A
              program with no scheduled return says nothing rather than
              promising a date it does not have. */}
          {hiddenHere === 0 ? (
            <>Its items are still on your day another way.</>
          ) : (
            <>
              <span className="font-num">{hiddenHere}</span>{' '}
              {hiddenHere === 1 ? 'item is' : 'items are'} hidden.{' '}
              {programResumeDate(standing.soonestBlocker, todayStr)
                ? `Back on ${formatShort(programResumeDate(standing.soonestBlocker, todayStr)!)}.`
                : 'They come back when one of those programs does.'}
            </>
          )}
        </StatusStrip>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* setRoutinePaused DIRECTLY, never through updateRoutine: it stamps
            its own history label, and routing through the generic update stamps
            "Edit routine" and lands the intended label on the user's NEXT
            action. The chip shows and writes LOCAL — the value it owns. */}
        <ChoiceChip
          label="Status"
          value={paused ? 'paused' : 'active'}
          options={ROUTINE_STATES}
          testIdPrefix="routine-state"
          onChange={(next) => setRoutinePaused(routine.id, next === 'paused')}
        />
        {paused && (
          /* The store has always taken this third argument and no call site in
             the app had ever passed it, while `pausedUntil` is READ in three
             places — so a routine could be "paused until" a date only the agent
             API could set.

             Today is disabled along with the past, and that matches the rule
             the store already enforces on the API side: the pause interval's
             upper bound is EXCLUSIVE, so `pausedUntil = today` is live today.
             resolvePauseWrite rejects it out loud ("the pause would end
             immediately"); offering it here would be a control that silently
             undoes the pause you are configuring. */
          <DayChip
            label="Comes back"
            value={routine.pausedUntil}
            testId="routine-resume"
            clearLabel="Clear resume date"
            disabledDays={{ before: tomorrow }}
            // `?? null` and not `?? undefined`: clearing the date is a request,
            // and undefined means "I did not say", which the store correctly
            // treats as a no-op. Without this the clear would be a dead button.
            onChange={(next) => setRoutinePaused(routine.id, true, next ?? null)}
          />
        )}
        <ColorChip
          value={routine.color}
          testId="routine-color"
          onChange={(color) => updateRoutine(routine.id, { color })}
        />
      </div>

      <div className="mt-1.5 flex flex-col gap-5">
        <ItemMemberList
          label="Items"
          ownerId={routine.id}
          ownerName={routine.name}
          memberIds={routine.itemIds}
          members={members}
          // PER ITEM. The greying answers "is this item showing up in my day?"
          // — and no property of this routine answers that, because a member can
          // reach the day through another routine or a program of its own.
          hiddenIds={hiddenIds}
          testPrefix="routine"
          orderable
          lead={members.length > 0 ? week.header(MEMBER_ROW_TRAILING_PAD_WITH_MENU) : undefined}
          row={{ trailing: week.trailing, ...controls }}
          onChange={(itemIds) => updateRoutine(routine.id, { itemIds })}
        />

        {heldBy.length > 0 && (
          <ProgramHolders
            holders={heldBy}
            blockerIds={new Set(standing.blockers.map((p) => p.id))}
            // A live program carries this routine only if the routine's own
            // switch is on. Without this the pane said "Its items are hidden
            // until you resume" and "carrying" three lines apart.
            routineOn={standing.localOn}
            onOpen={onOpenProgram}
          />
        )}
      </div>
    </div>
  );
}
