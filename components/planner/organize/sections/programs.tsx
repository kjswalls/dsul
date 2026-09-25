'use client';

import { useState } from 'react';
import { CalendarRange, Trash2 } from 'lucide-react';
import {
  ChoiceChip,
  ColorChip,
  DateRangeChip,
  type ChoiceOption,
} from '@/components/primitives/organizer-chips';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { inactiveItemIdsOn, isProgramActiveOn } from '@/lib/active';
import {
  byName,
  countLive,
  formatShort,
  matching,
  programPillLabel,
  useLiveItemIds,
  useLiveRoutineIds,
  useToday,
} from '@/lib/collections';
import { ObjectRow } from '../primitives';
import {
  CreateForm,
  DetailColumn,
  DetailHead,
  ListColumn,
  SectionWelcome,
  StatusStrip,
  TitleRow,
} from '../detail-parts';
import { ItemMemberList, RoutineMemberList } from '../member-list';
import { makeIconToken } from '@/lib/category-icons';
import type { Item, Program, Routine } from '@/lib/planner-types';

/**
 * PROGRAMS — a stretch of life that switches whole routines on and off.
 *
 * Moved from ManageCollectionsDialog with every data-testid intact
 * (memory/plans/organize-console.md, Phase 2). The three things worth knowing
 * before changing anything here are all about the tri-state:
 *
 *   On / Off are MANUAL OVERRIDES and always win — a person who flips a program
 *   by hand ("we came back early") must never be second-guessed by a date they
 *   set weeks ago. Only Dates is date-resolved, which is why the range renders
 *   under Dates alone: pickers beside On or Off would be controls with no
 *   effect. The dates stay on the row meanwhile, waiting.
 */
export function ProgramsSection({
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
  const programs = usePlannerStore((s) => s.programs);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const addProgram = usePlannerStore((s) => s.addProgram);
  const liveIds = useLiveItemIds();
  const liveRoutineIds = useLiveRoutineIds();
  const { todayStr } = useToday();

  const [query, setQuery] = useState('');

  const selected = programs.find((p) => p.id === selectedId) ?? null;
  const visible = matching(programs, query, byName);
  const canCreate = collectionsAvailable && !!userId && !isLoading;
  const showCreate = canCreate && (creating || programs.length === 0);

  return (
    <>
      <ListColumn
        eyebrow="PROGRAMS"
        count={visible.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter programs…',
          testId: 'program-filter',
        }}
        onNew={{
          onClick: onNew,
          label: 'New program',
          testId: 'program-new',
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
        ) : programs.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No programs yet.</p>
        ) : (
          visible.map((program) => (
            <ObjectRow
              key={program.id}
              testId="program-row"
              idAttr={{ 'data-program-id': program.id }}
              icon={program.icon}
              color={program.color}
              name={program.name}
              selected={selectedId === program.id}
              pill={programPillLabel(program, todayStr)}
              pillTestId="program-state-pill"
              // Both member arrays. Routines are the members a program is
              // usually built out of, and one holding only routines would
              // otherwise read as empty.
              count={
                countLive(program.itemIds, liveIds) +
                countLive(program.routineIds, liveRoutineIds)
              }
              onSelect={() => onSelect(program.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <ProgramCreateForm
            autoFocus={creating}
            onCreate={(name, icon, run) =>
              onCreated(
                // `auto`, never 'active': with no dates that is always-on, the
                // one state that cannot hide anything a program you just made
                // holds; with dates it follows them, which is what giving it a
                // run asked for. One addProgram — never a create then a patch.
                addProgram({
                  name,
                  icon,
                  state: 'auto',
                  startsOn: run.startsOn,
                  endsOn: run.endsOn,
                  itemIds: [],
                  routineIds: [],
                })
              )
            }
            onCancel={programs.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          <ProgramDetail program={selected} onBack={() => onSelect(null)} />
        ) : (
          <SectionWelcome section="programs">
            A program is a stretch of life — a summer, a term — that switches whole routines on
            and off.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

/**
 * "+ New" for a program: the name, and optionally its run — the one thing
 * beyond a name that makes a program a stretch of life rather than a folder.
 * Both ends optional; unset is always-on.
 */
function ProgramCreateForm({
  autoFocus,
  onCreate,
  onCancel,
}: {
  autoFocus: boolean;
  onCreate: (
    name: string,
    icon: string | undefined,
    run: { startsOn?: string; endsOn?: string }
  ) => void;
  onCancel?: () => void;
}) {
  const [run, setRun] = useState<{ startsOn?: string; endsOn?: string }>({});
  return (
    <CreateForm
      eyebrow="NEW PROGRAM"
      placeholder="Name your program…"
      addLabel="Create program"
      icon={makeIconToken('CalendarRange')}
      testPrefix="program"
      autoFocus={autoFocus}
      hint="A program is a stretch of life — a summer, a term — that switches whole routines on and off. Without dates it starts always-on, hiding nothing."
      fields={
        <div className="flex flex-wrap items-center gap-1.5">
          <DateRangeChip
            label="Runs"
            start={run.startsOn}
            end={run.endsOn}
            startLabel="Starts"
            endLabel="Ends"
            emptyLabel="Runs"
            testIdPrefix="program-new-runs"
            onChange={(startsOn, endsOn) => setRun({ startsOn, endsOn })}
          />
        </div>
      }
      onCreate={(name, icon) => onCreate(name, icon, run)}
      onCancel={onCancel}
    />
  );
}

/**
 * The three states as a chip. `auto` is "Dates", and its dot follows whether
 * the dates have it on today — the chip then says at a glance what the
 * program is doing, not only how it was set.
 */
function programStates(live: boolean): ChoiceOption<Program['state']>[] {
  return [
    { value: 'active', label: 'On', dot: 'lime' },
    { value: 'paused', label: 'Off', dot: 'muted' },
    { value: 'auto', label: 'Dates', dot: live ? 'lime' : 'muted' },
  ];
}

function ProgramDetail({ program, onBack }: { program: Program; onBack: () => void }) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const updateProgram = usePlannerStore((s) => s.updateProgram);
  const setProgramState = usePlannerStore((s) => s.setProgramState);
  const swapToProgram = usePlannerStore((s) => s.swapToProgram);
  const removeProgram = usePlannerStore((s) => s.removeProgram);
  const confirm = useUIStore((s) => s.confirm);
  const liveIds = useLiveItemIds();
  const liveRoutineIds = useLiveRoutineIds();
  const { todayStr, tz } = useToday();

  const live = isProgramActiveOn(program, todayStr);
  const members = program.itemIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is Item => !!i);
  const routineMembers = program.routineIds
    .map((id) => routines.find((r) => r.id === id))
    .filter((r): r is Routine => !!r);

  const itemCount = countLive(program.itemIds, liveIds);
  const routineCount = countLive(program.routineIds, liveRoutineIds);

  // The swap verb only earns its place when there is something to swap AWAY
  // from. With no other program on, "Switch to this" and "On" would be the same
  // button wearing two labels.
  const displaced = programs.filter((p) => p.id !== program.id && isProgramActiveOn(p, todayStr));

  /**
   * How many items an attach would ACTUALLY hide, asked of the resolver by
   * simulating the join rather than counting members.
   *
   * A raw member count is wrong three ways at once: members already hidden by
   * the routine's own pause, members the user paused by hand, and members held
   * by a second live program all count toward it while none of them would move.
   * At worst that produces a confirm saying "this will hide 5 items" for a write
   * that hides nothing — which teaches the user to dismiss the prompt unread,
   * and this is the one prompt in the app that has something to say.
   */
  const wouldHide = (routine: Routine): number => {
    const ctx = { userTimezone: tz, routines, programs };
    const before = inactiveItemIdsOn(items, todayStr, ctx);
    const after = inactiveItemIdsOn(items, todayStr, {
      ...ctx,
      programs: programs.map((p) =>
        p.id === program.id ? { ...p, routineIds: [...p.routineIds, routine.id] } : p
      ),
    });
    let n = 0;
    for (const id of after) if (!before.has(id)) n += 1;
    return n;
  };

  const attach = (routine: Routine) =>
    updateProgram(program.id, { routineIds: [...program.routineIds, routine.id] });

  /**
   * The attach discontinuity, said out loud (programs-routines decision 3).
   *
   * A routine that belongs to NO program answers for itself. Put it in its first
   * program and the program answers too — so attaching a live routine to a
   * program that is off makes its items vanish from today as a side effect of a
   * join write. That is the algebra working as designed (scoping a routine IS
   * the point), but an unannounced "5 items disappeared" reads as a bug.
   */
  const requestAttach = (routine: Routine) => {
    // Only the FIRST program a routine joins rescopes it. A second is purely
    // additive — the path algebra is disjunctive — so warning there would train
    // the user to dismiss the prompt that matters.
    const heldElsewhere = programs.some(
      (p) => p.id !== program.id && p.routineIds.includes(routine.id)
    );
    const hides = heldElsewhere ? 0 : wouldHide(routine);
    if (hides === 0) {
      attach(routine);
      return;
    }
    const returns =
      program.state === 'auto' && program.startsOn && todayStr < program.startsOn
        ? formatShort(program.startsOn)
        : null;
    confirm({
      title: `This will hide ${hides} ${hides === 1 ? 'item' : 'items'} for now`,
      description:
        `“${routine.name}” looks after itself today. Putting it in ${program.name} hands that ` +
        `over — and ${program.name} is off, so its ${hides} ${hides === 1 ? 'item' : 'items'} ` +
        `${returns ? `come back on ${returns}` : 'stay hidden until you switch it on'}. ` +
        `Nothing is deleted, and taking it back out restores them.`,
      confirmLabel: 'Add it anyway',
      testId: 'program-routine-attach-confirm',
      onConfirm: () => attach(routine),
    });
  };

  const requestDelete = () =>
    confirm({
      title: 'Delete this program?',
      description: deleteConsequence(program, itemCount, routineCount, live),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        removeProgram(program.id);
        onBack();
      },
    });

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="program-detail"
      data-program-id={program.id}
    >
      <DetailHead
        kind="Program"
        color={program.color}
        name={program.name}
        testPrefix="program"
        back={{ label: 'Programs', testId: 'program-detail-back', onBack }}
        menu={[
          {
            label: 'Delete program',
            icon: <Trash2 className="size-3.5" />,
            testId: 'program-delete',
            destructive: true,
            onSelect: requestDelete,
          },
        ]}
      />

      <TitleRow
        id={program.id}
        name={program.name}
        icon={program.icon}
        label="Program"
        testPrefix="program"
        onPatch={(patch) => updateProgram(program.id, patch)}
      />

      <StatusStrip
        testId="program-state-note"
        icon={<CalendarRange className="size-3.5" aria-hidden />}
      >
        <ProgramStateNote program={program} live={live} />
      </StatusStrip>

      <div className="flex flex-wrap items-center gap-1.5">
        {/* setProgramState DIRECTLY, never through updateProgram: it stamps its
            own history label and its own optimistic `updatedAt`, and routing
            through the generic update stamps "Edit program" and lands the
            intended label on the user's NEXT action. */}
        <ChoiceChip
          label="Status"
          value={program.state}
          options={programStates(live)}
          testIdPrefix="program-state"
          onChange={(state) => setProgramState(program.id, state)}
        />
        {/* Under Dates alone: On and Off are manual overrides that always win,
            so a range beside them would be a control with no effect. The dates
            stay on the row meanwhile, waiting. The chip fences start ≤ end — an
            inverted range is live on NO date, so every member would vanish
            while the note cheerfully reported "Runs Sep 1 to Aug 1". Both ends
            are included, as the note says. */}
        {program.state === 'auto' && (
          <DateRangeChip
            start={program.startsOn}
            end={program.endsOn}
            startLabel="Starts"
            endLabel="Ends"
            emptyLabel="Runs"
            testIdPrefix="program-runs"
            onChange={(startsOn, endsOn) => updateProgram(program.id, { startsOn, endsOn })}
          />
        )}
        <ColorChip
          value={program.color}
          testId="program-color"
          onChange={(color) => updateProgram(program.id, { color })}
        />
      </div>

      {!live && displaced.length > 0 && (
        <button
          type="button"
          onClick={() => swapToProgram(program.id)}
          data-testid="program-swap"
          className="border-border hover:bg-accent flex flex-col items-start gap-0.5 self-start rounded-[5px] border px-3 py-2 text-left"
        >
          <span className="text-foreground text-sm font-medium">Switch to this program</span>
          <span className="text-muted-foreground text-xs">
            Turns off {displaced.map((p) => p.name).join(', ')}. One undo puts it all back.
          </span>
        </button>
      )}

      <div className="mt-1.5 flex flex-col gap-5">
        <RoutineMemberList
          program={program}
          live={live}
          members={routineMembers}
          candidates={routines.filter((r) => !program.routineIds.includes(r.id))}
          onRequestAttach={requestAttach}
          onRemove={(routineId) =>
            updateProgram(program.id, {
              routineIds: program.routineIds.filter((id) => id !== routineId),
            })
          }
        />

        {/* NOT orderable, and not a taste call: `routine_items` carries a
            `sort_order` column and `program_items` does not, so an order
            arranged here would survive until the next fetch and then silently
            reshuffle. */}
        <ItemMemberList
          label="Items"
          ownerId={program.id}
          ownerName={program.name}
          memberIds={program.itemIds}
          members={members}
          // The resolver's per-item answer, not this program's state — same
          // correction the routine pane needed. `!live` greyed items a second
          // live path was still carrying, and drew items at full contrast while
          // their own pause kept them off the grid.
          hiddenIds={inactiveItemIdsOn(items, todayStr, {
            userTimezone: tz,
            routines,
            programs,
          })}
          testPrefix="program"
          onChange={(itemIds) => updateProgram(program.id, { itemIds })}
        />
      </div>
    </div>
  );
}

/**
 * What deleting actually does — and the half of it a user would never guess.
 *
 * Trashing a program REMOVES ITS PATHS, so a routine it was the only holder of
 * falls back to standalone and its members reappear. "Delete" reads as
 * subtraction; here it can add rows back to today's grid, and that has to be on
 * the button rather than discovered afterwards.
 */
function deleteConsequence(
  program: Program,
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
    `“${program.name}” is removed` +
    (held ? `, but the ${held} it holds stay exactly as they are` : '') +
    (!live && (itemCount > 0 || routineCount > 0)
      ? ' — and anything it was hiding comes back into view'
      : '') +
    '.'
  );
}

/** The four ways a program can be, in the program's own words. */
function ProgramStateNote({ program, live }: { program: Program; live: boolean }) {
  if (program.state === 'active') {
    return <>On until you say otherwise — dates are ignored while it is set this way.</>;
  }
  if (program.state === 'paused') {
    return <>Off. Everything it holds is hidden, and streaks and history stay exactly as they are.</>;
  }
  if (!program.startsOn && !program.endsOn) {
    return <>Always on. Give it a start or an end to make it follow the calendar.</>;
  }
  const from = program.startsOn ? formatShort(program.startsOn) : null;
  const to = program.endsOn ? formatShort(program.endsOn) : null;
  const span = from && to ? `${from} to ${to}` : from ? `from ${from}` : `until ${to}`;
  return (
    <>
      Runs {span}, inclusive. {live ? 'On now.' : 'Off right now — nothing it holds is showing.'}
    </>
  );
}
