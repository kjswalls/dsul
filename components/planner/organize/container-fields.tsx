'use client';

import { useMemo } from 'react';
import {
  ChoiceChip,
  ColorChip,
  DateRangeChip,
  type ChoiceOption,
} from '@/components/primitives/organizer-chips';
import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import { InlineAddRow } from '@/components/primitives/organizer-chips';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CategoryIcon } from '@/lib/category-icons';
import { isCheckinEligible, isCollectible, isMilestoneEligible } from '@/lib/item-registry';
import { isItemActiveOn, isProgramActiveOn, resolvePauseWrite } from '@/lib/active';
import { addDaysStr } from '@/lib/container-schedule';
import { newMemberTaskShape, resolveGoalStateWrite } from '@/lib/goals';
import { formatShort, parseDay } from '@/lib/collections';
import { DayChip, NotesField } from './detail-parts';
import { ItemMemberList, MEMBER_ROW_TRAILING_PAD, RoutineMemberList } from './member-list';
import {
  GoalSchedule,
  ScheduleHeading,
  SeasonHeatmap,
  useWeekDotsFor,
} from '@/components/planner/schedule/schedule-views';
import { containerMemberIds } from '@/lib/container-schedule';
import type { Goal, GoalRole, Item, Program, Routine } from '@/lib/planner-types';

/**
 * EVERY FIELD AN ORGANIZER HAS, ASKED AT BIRTH (Kirby, 2026-09-26).
 *
 * One body, two shells: the "new" dialog (container-dialog.tsx) and the Organize
 * console's "+ New" form (container-create-form.tsx) both render this, so making
 * a goal in either place is the same form — the console's create pane mirrors
 * the modal because it IS the modal's body.
 *
 * It owns no state. The shell holds a `ContainerDraft` and hands it back through
 * `build*`, which turns it into the ONE create call — status, dates, colour, the
 * why and every membership arrive in a single add, so the arrival is one ⌘Z and
 * one INSERT (plus its join rows, which lib/db.ts writes inside the same create).
 *
 * Two things need more than one write, and are written IN ORDER by the store
 * (Kirby, 2026-09-27) rather than left out:
 *  · NEW items typed into a section ("Add milestone…") — each item's row lands
 *    before the container's join row that points at it (awaitItemCreates);
 *  · a routine's programs — program_routines rows are written once the
 *    routine's own row has landed (addRoutine's `programIds`).
 * `createFromDraft` folds all of it into ONE history entry, so ⌘Z still takes
 * the whole birth back in one press.
 */

export type DraftKind = 'goal' | 'routine' | 'program';

export interface ContainerDraft {
  color?: string;
  /** Goal: the window's start. Program: the run's start. */
  startsOn?: string;
  /** Goal: `targetOn`. Program: `endsOn`. One field, because the chip is one range. */
  endsOn?: string;
  goalState: Goal['state'];
  why: string;
  routinePaused: boolean;
  /** Routine: the resume date, EXCLUSIVE (live again on it). Only read while paused. */
  pausedUntil?: string;
  programState: Program['state'];
  itemIds: string[];
  routineIds: string[];
  memberIds: string[];
  milestoneIds: string[];
  checkinIds: string[];
  /** Items typed in as NEW — created (then linked) only when the form is submitted. */
  newItems: NewItemDraft[];
  /** Routine: programs to hold it from birth. */
  programIds: string[];
}

export type NewItemRole = 'items' | GoalRole;

export interface NewItemDraft {
  key: string;
  title: string;
  /** Which section it was typed into: a goal role, or a routine/program's items. */
  role: NewItemRole;
}

/**
 * The defaults — the answers that need no asking. Active, auto-coloured, a
 * goal's window opening TODAY (the user's today, as useToday resolves it), a
 * program on its (absent) dates, which is always-on and hides nothing.
 */
export function initialDraft(kind: DraftKind, todayStr: string, notes?: string): ContainerDraft {
  return {
    color: undefined,
    startsOn: kind === 'goal' ? todayStr : undefined,
    endsOn: undefined,
    goalState: 'active',
    // Notes carried over from an item become a goal's why. The other kinds have
    // no free text and never read it — but it is KEPT, so a trip through the type
    // menu (goal → routine → goal) does not lose what was written.
    why: notes ?? '',
    routinePaused: false,
    pausedUntil: undefined,
    programState: 'auto',
    itemIds: [],
    routineIds: [],
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    newItems: [],
    programIds: [],
  };
}

/**
 * Create the container the draft describes, with everything in it, as ONE ⌘Z:
 * the new items first (addTask, each registering its in-flight INSERT), then
 * the container carrying their ids — the store's add waits for those INSERTs
 * before writing the join rows, and for a routine writes its programs' holds
 * last. Returns the new id, or '' when the store refused (addGoal's guard).
 */
export function createFromDraft(
  kind: DraftKind,
  name: string,
  icon: string | undefined,
  draft: ContainerDraft,
  todayStr: string,
  tz: string,
): string {
  const store = usePlannerStore.getState();
  const nowIso = new Date().toISOString();
  let id = '';
  batchHistory(`Add ${kind}: ${name}`, 1 + draft.newItems.length, () => {
    const made: Record<NewItemRole, string[]> = { items: [], member: [], milestone: [], checkin: [] };
    for (const n of draft.newItems) {
      const role: GoalRole = n.role === 'items' ? 'member' : n.role;
      made[n.role].push(store.addTask(newMemberTaskShape(role, n.title, todayStr) as never));
    }
    const d: ContainerDraft = {
      ...draft,
      itemIds: [...draft.itemIds, ...made.items],
      memberIds: [...draft.memberIds, ...made.member],
      milestoneIds: [...draft.milestoneIds, ...made.milestone],
      checkinIds: [...draft.checkinIds, ...made.checkin],
    };
    id =
      kind === 'goal'
        ? store.addGoal(buildGoal(name, icon, d, nowIso))
        : kind === 'routine'
          ? d.programIds.length
            ? store.addRoutine(buildRoutine(name, icon, d, todayStr, nowIso, tz), { programIds: d.programIds })
            : store.addRoutine(buildRoutine(name, icon, d, todayStr, nowIso, tz))
          : store.addProgram(buildProgram(name, icon, d));
  });
  return id;
}

/* ── the one create call per kind ─────────────────────────────────────── */

/**
 * `achievedAt` rides resolveGoalStateWrite, the verb's own definition — so a goal
 * made "Achieved" carries its stamp exactly as one marked achieved later would,
 * and undo of either clears it the same way.
 */
export function buildGoal(
  name: string,
  icon: string | undefined,
  d: ContainerDraft,
  nowIso: string,
): Omit<Goal, 'id'> {
  const state = resolveGoalStateWrite(
    { state: 'active' } as Goal,
    d.goalState,
    nowIso,
  );
  return {
    name,
    icon,
    color: d.color,
    why: d.why.trim() || undefined,
    startsOn: d.startsOn,
    targetOn: d.endsOn,
    state: 'active',
    ...state,
    memberIds: d.memberIds,
    milestoneIds: d.milestoneIds,
    checkinIds: d.checkinIds,
  };
}

/**
 * A routine born paused gets its pause columns from resolvePauseWrite — the one
 * definition of what pausing writes — INSIDE the create. A follow-up
 * setRoutinePaused would be an UPDATE racing the INSERT, and one that lands first
 * matches no row and is lost without an error.
 */
export function buildRoutine(
  name: string,
  icon: string | undefined,
  d: ContainerDraft,
  todayStr: string,
  nowIso: string,
  tz: string,
): Omit<Routine, 'id'> {
  let pause: Pick<Routine, 'pausedAt' | 'pausedUntil'> = {};
  if (d.routinePaused) {
    const write = resolvePauseWrite(
      {},
      { paused: true, pausedUntil: d.pausedUntil ?? null },
      todayStr,
      nowIso,
      tz,
    );
    // A refusal is a resume date not after today — the picker floors it at
    // tomorrow, but a dialog left open past midnight can carry yesterday's
    // "tomorrow". Dropping the date would pause with NO end, the opposite of
    // what was asked; the nearest honest reading is "back tomorrow".
    pause =
      'patch' in write ? write.patch : { pausedAt: nowIso, pausedUntil: addDaysStr(todayStr, 1) };
  }
  return { name, icon, color: d.color, ...pause, itemIds: d.itemIds };
}

/**
 * The dates travel whatever the state, as they do on the row: under On or Off
 * they wait, unread, until the program is put back on its dates.
 */
export function buildProgram(
  name: string,
  icon: string | undefined,
  d: ContainerDraft,
): Omit<Program, 'id'> {
  return {
    name,
    icon,
    color: d.color,
    state: d.programState,
    startsOn: d.startsOn,
    endsOn: d.endsOn,
    itemIds: d.itemIds,
    routineIds: d.routineIds,
  };
}

/* ── status vocabularies, shared with the detail panes ────────────────── */

export const GOAL_STATES = [
  { value: 'active', label: 'Active', dot: 'lime' },
  { value: 'achieved', label: 'Achieved', dot: 'muted' },
  { value: 'abandoned', label: 'Set aside', dot: 'muted' },
] as const satisfies readonly { value: Goal['state']; label: string; dot: string }[];

export const ROUTINE_STATES = [
  { value: 'active', label: 'Active', dot: 'lime' },
  { value: 'paused', label: 'Paused', dot: 'muted' },
] as const;

/**
 * `auto` is "Dates", and its dot follows whether the dates have it on today — the
 * chip then says what the program is doing, not only how it was set.
 */
export function programStates(live: boolean): ChoiceOption<Program['state']>[] {
  return [
    { value: 'active', label: 'On', dot: 'lime' },
    { value: 'paused', label: 'Off', dot: 'muted' },
    { value: 'auto', label: 'Dates', dot: live ? 'lime' : 'muted' },
  ];
}

/* ── the sentences ────────────────────────────────────────────────────── */

/**
 * What a program's dates will do, in words — the Runs chip alone doesn't say
 * that a program on its dates switches ITSELF. Inclusive at both ends, as
 * isProgramActiveOn reads them; no dates means "on every day", which needs no
 * sentence.
 */
export function programRunsCopy(
  startsOn: string | undefined,
  endsOn: string | undefined,
  todayStr: string,
): string | null {
  if (endsOn && endsOn < todayStr) return 'Its dates are already over, so it starts switched off.';
  const startsLater = !!startsOn && startsOn > todayStr;
  if (startsLater && endsOn) {
    return `It switches on by itself on ${formatShort(startsOn!)} and off after ${formatShort(endsOn)}.`;
  }
  if (startsLater) return `It switches on by itself on ${formatShort(startsOn!)}.`;
  if (endsOn) return `It's on now, and switches off by itself after ${formatShort(endsOn)}.`;
  return null;
}

/** The program's state sentence at birth — the manual states need one too. */
function programStateCopy(d: ContainerDraft, todayStr: string): string | null {
  // Dates picked under Dates and then hidden by switching to On/Off are still
  // written — so say so, rather than store something the form no longer shows.
  const waiting = d.startsOn || d.endsOn ? ' Its dates are kept, unused, for if you put it back on them.' : '';
  if (d.programState === 'active') return `On until you switch it off.${waiting}`;
  if (d.programState === 'paused') return `Off from the start — everything it holds is on hold.${waiting}`;
  return programRunsCopy(d.startsOn, d.endsOn, todayStr);
}

const DRAFT_ID = '__draft__';

/**
 * What creating this would do to its members' ACTIVATION, asked of the resolver
 * rather than guessed: a paused routine puts its members on hold, a program that
 * is off does the same to what it holds, and linking an item a paused routine was
 * holding into a LIVE container gives it a path back.
 *
 * Liveness (`isItemActiveOn`), deliberately NOT the grid's hide set: that one is
 * "suppressed AND an open loop today", so it would count undated work and habits
 * not due today as hidden "from your day", and miss a habit already ticked today
 * that the pause holds from tomorrow on. The copy says "on hold", which is what
 * this measures. Only the draft's own members can change, so only they are asked.
 */
export function draftConsequence(
  kind: DraftKind,
  d: ContainerDraft,
  store: { items: readonly Item[]; routines: readonly Routine[]; programs: readonly Program[] },
  todayStr: string,
  nowIso: string,
  tz: string,
): { hides: number; shows: number } {
  if (kind === 'goal') return { hides: 0, shows: 0 }; // goals never hide anything
  if (d.itemIds.length === 0 && d.routineIds.length === 0) return { hides: 0, shows: 0 };
  const affected = new Set(d.itemIds);
  if (kind === 'program') {
    for (const rid of d.routineIds) store.routines.find((r) => r.id === rid)?.itemIds.forEach((id) => affected.add(id));
  }
  const ctx = { userTimezone: tz, routines: store.routines, programs: store.programs };
  const after =
    kind === 'routine'
      ? {
          ...ctx,
          routines: [
            ...store.routines,
            { id: DRAFT_ID, ...buildRoutine('', undefined, d, todayStr, nowIso, tz) },
          ],
          // Joining a program that is off puts the routine's items on hold —
          // the attach discontinuity the program pane confirms, said here.
          programs: store.programs.map((p) =>
            d.programIds.includes(p.id) ? { ...p, routineIds: [...p.routineIds, DRAFT_ID] } : p
          ),
        }
      : { ...ctx, programs: [...store.programs, { id: DRAFT_ID, ...buildProgram('', undefined, d) }] };
  let hides = 0;
  let shows = 0;
  for (const item of store.items) {
    if (!affected.has(item.id)) continue;
    const was = isItemActiveOn(item, todayStr, ctx);
    const will = isItemActiveOn(item, todayStr, after);
    if (was && !will) hides += 1;
    if (!was && will) shows += 1;
  }
  return { hides, shows };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ── the body ─────────────────────────────────────────────────────────── */

/** Shared, so a fresh Set per render never churns a memo downstream. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/**
 * Is this item already held by one of the goal's OTHER role arrays? The PK gives
 * an item one role per goal, so a picker offering it again would offer a
 * contradiction the write refuses. Shared with the goal detail pane.
 */
export function heldElsewhere(
  roles: Pick<Goal, 'memberIds' | 'milestoneIds' | 'checkinIds'>,
  own: 'memberIds' | 'milestoneIds' | 'checkinIds',
  id: string,
): boolean {
  return (['memberIds', 'milestoneIds', 'checkinIds'] as const)
    .filter((k) => k !== own)
    .some((k) => roles[k].includes(id));
}

export function ContainerDraftFields({
  kind,
  draft,
  onChange,
  testPrefix,
  ownerName,
  todayStr,
  tz,
}: {
  kind: DraftKind;
  draft: ContainerDraft;
  onChange: (patch: Partial<ContainerDraft>) => void;
  /** `goal-dialog` in the modal, `goal-new` in the console — the testids both shells already had. */
  testPrefix: string;
  /** For the member rows' accessible names ("Remove Stretch from Mornings"). */
  ownerName: string;
  todayStr: string;
  tz: string;
}) {
  const items = usePlannerStore((s) => s.items);
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const p = testPrefix;

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);

  const consequence = useMemo(
    () =>
      draftConsequence(kind, draft, { items, routines, programs }, todayStr, new Date().toISOString(), tz),
    [kind, draft, items, routines, programs, todayStr, tz],
  );

  // Local noon on the day after the user's today — the resume picker's floor.
  // pausedUntil is exclusive, so today itself would be a pause that is over.
  const today = parseDay(todayStr)!;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);

  // The charts preview the DRAFT: activation resolves against the store's lists
  // plus this container as it would be created, so a paused routine's dots go
  // quiet and an Off program's season goes blank before anything is written.
  const overrides = useMemo(() => {
    const nowIso = new Date().toISOString();
    if (kind === 'routine') {
      return {
        routines: [...routines, { id: DRAFT_ID, ...buildRoutine('', undefined, draft, todayStr, nowIso, tz) }],
        programs: programs.map((p) =>
          draft.programIds.includes(p.id) ? { ...p, routineIds: [...p.routineIds, DRAFT_ID] } : p
        ),
      };
    }
    if (kind === 'program') {
      return { programs: [...programs, { id: DRAFT_ID, ...buildProgram('', undefined, draft) }] };
    }
    return undefined;
  }, [kind, draft, routines, programs, todayStr, tz]);
  const week = useWeekDotsFor(draft.itemIds, overrides);
  const seasonIds =
    kind === 'program'
      ? containerMemberIds({ kind: 'program', program: { id: DRAFT_ID, ...buildProgram('', undefined, draft) } }, items, routines)
      : [];

  const live =
    kind === 'program' &&
    isProgramActiveOn({ id: DRAFT_ID, ...buildProgram('', undefined, draft) }, todayStr);

  const hasNew = (role: NewItemRole) => draft.newItems.some((n) => n.role === role);

  const notes: { key: string; text: string }[] = [];
  if (kind === 'program') {
    const copy = programStateCopy(draft, todayStr);
    if (copy) notes.push({ key: 'state', text: copy });
  }
  if (kind === 'routine' && draft.routinePaused) {
    notes.push({
      key: 'state',
      text: draft.pausedUntil
        ? `Paused from the start — its items come back on ${formatShort(draft.pausedUntil)}.`
        : 'Paused from the start — its items stay hidden until you resume it.',
    });
  }
  if (consequence.hides > 0) {
    notes.push({
      key: 'hides',
      text: `Creating it puts ${plural(consequence.hides, 'item', 'items')} on hold for now. Nothing is deleted.`,
    });
  }
  if (consequence.shows > 0) {
    notes.push({
      key: 'shows',
      text: `${plural(consequence.shows, 'item on hold comes', 'items on hold come')} back.`,
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid={`${p}-fields`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {kind === 'goal' && (
          <ChoiceChip
            label="Status"
            value={draft.goalState}
            options={GOAL_STATES}
            testIdPrefix={`${p}-state`}
            onChange={(goalState) => onChange({ goalState })}
          />
        )}
        {kind === 'routine' && (
          <ChoiceChip
            label="Status"
            value={draft.routinePaused ? 'paused' : 'active'}
            options={ROUTINE_STATES}
            testIdPrefix={`${p}-state`}
            onChange={(next) =>
              onChange({ routinePaused: next === 'paused', pausedUntil: undefined })
            }
          />
        )}
        {kind === 'routine' && draft.routinePaused && (
          <DayChip
            label="Comes back"
            value={draft.pausedUntil}
            testId={`${p}-resume`}
            clearLabel="Clear resume date"
            disabledDays={{ before: tomorrow }}
            onChange={(next) => onChange({ pausedUntil: next })}
          />
        )}
        {kind === 'program' && (
          <ChoiceChip
            label="Status"
            value={draft.programState}
            options={programStates(live)}
            testIdPrefix={`${p}-state`}
            onChange={(programState) => onChange({ programState })}
          />
        )}
        {kind === 'goal' && (
          <DateRangeChip
            label="Window"
            start={draft.startsOn}
            end={draft.endsOn}
            onChange={(startsOn, endsOn) => onChange({ startsOn, endsOn })}
            startLabel="Started"
            endLabel="Target"
            emptyLabel="Target"
            testIdPrefix={`${p}-window`}
          />
        )}
        {/* Under Dates alone, as in the detail pane: On and Off are overrides
            that always win, so a range beside them would do nothing. */}
        {kind === 'program' && draft.programState === 'auto' && (
          <DateRangeChip
            label="Runs"
            start={draft.startsOn}
            end={draft.endsOn}
            onChange={(startsOn, endsOn) => onChange({ startsOn, endsOn })}
            startLabel="Starts"
            endLabel="Ends"
            emptyLabel="Runs"
            testIdPrefix={`${p}-runs`}
          />
        )}
        <ColorChip value={draft.color} onChange={(color) => onChange({ color })} testId={`${p}-color`} />
      </div>

      {notes.length > 0 && (
        <div className="flex flex-col gap-1" data-testid={`${p}-notes`}>
          {notes.map((n) => (
            <p key={n.key} className="text-muted-foreground text-xs" data-testid={`${p}-note-${n.key}`}>
              {n.text}
            </p>
          ))}
        </div>
      )}

      {kind === 'goal' && (
        <NotesField
          value={draft.why}
          onChange={(why) => onChange({ why })}
          placeholder="Why this matters…"
          ariaLabel="Why this goal matters"
          testId={`${p}-why`}
        />
      )}

      {kind === 'goal' && (
        <GoalSchedule
          goal={{ ...draft, targetOn: draft.endsOn }}
          testId={`${p}-schedule`}
        />
      )}
      {kind === 'program' && (
        <section className="flex flex-col gap-2" data-testid={`${p}-season`}>
          <ScheduleHeading label="Season" />
          <SeasonHeatmap
            program={{ state: draft.programState, startsOn: draft.startsOn, endsOn: draft.endsOn }}
            memberIds={seasonIds}
            overrides={overrides}
            testId={`${p}-season-heatmap`}
          />
        </section>
      )}

      <div className="flex flex-col gap-4">
        {kind === 'goal' && (
          <>
            <ItemMemberList
              label="Milestones"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.milestoneIds}
              members={pick(draft.milestoneIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-milestones`}
              orderable
              pickerHint="One-time items only. A repeating item never finishes."
              emptyHint={hasNew('milestone') ? undefined : "Checkpoints on the way — e.g. “Run a 10k” by October."}
              eligible={(i) => isMilestoneEligible(i) && !heldElsewhere(draft, 'milestoneIds', i.id)}
              emptyPoolLabel="Nothing eligible yet — a milestone is a one-shot item."
              onChange={(milestoneIds) => onChange({ milestoneIds })}
              footer={<NewItemRows draft={draft} role="milestone" onChange={onChange} testPrefix={`${p}-create-milestone`} placeholder="Add a new milestone…" />}
            />
            <ItemMemberList
              label="Check-ins"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.checkinIds}
              members={pick(draft.checkinIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-checkins`}
              pickerHint="Repeating items only — a check-in comes round again."
              emptyHint={hasNew('checkin') ? undefined : "A recurring review — e.g. a weekly look back on Sundays."}
              eligible={(i) => isCheckinEligible(i) && !heldElsewhere(draft, 'checkinIds', i.id)}
              emptyPoolLabel="Nothing eligible yet — a check-in is a repeating item."
              onChange={(checkinIds) => onChange({ checkinIds })}
              footer={<NewItemRows draft={draft} role="checkin" onChange={onChange} testPrefix={`${p}-create-checkin`} placeholder="Add a new weekly check-in…" />}
            />
            <ItemMemberList
              label="Supporting work"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.memberIds}
              members={pick(draft.memberIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-supporting`}
              emptyHint={hasNew('member') ? undefined : "The habits and tasks that serve it."}
              eligible={(i) => isCollectible(i) && !heldElsewhere(draft, 'memberIds', i.id)}
              onChange={(memberIds) => onChange({ memberIds })}
              footer={<NewItemRows draft={draft} role="member" onChange={onChange} testPrefix={`${p}-create-member`} placeholder="Add new supporting work…" />}
            />
          </>
        )}
        {kind === 'program' && (
          <RoutineMemberList
            program={{ id: DRAFT_ID, name: ownerName }}
            live={live}
            members={draft.routineIds
              .map((id) => routines.find((r) => r.id === id))
              .filter((r): r is Routine => !!r)}
            candidates={routines.filter((r) => !draft.routineIds.includes(r.id))}
            // No confirm here: the consequence line above says what attaching
            // does before anything is written, which is the confirm's job.
            onRequestAttach={(routine) => onChange({ routineIds: [...draft.routineIds, routine.id] })}
            onRemove={(routineId) =>
              onChange({ routineIds: draft.routineIds.filter((id) => id !== routineId) })
            }
            testPrefix={p}
            emptyHint="Routines this stretch switches on and off with it."
          />
        )}
        {(kind === 'routine' || kind === 'program') && (
          <ItemMemberList
            label="Items"
            ownerId={DRAFT_ID}
            ownerName={ownerName}
            memberIds={draft.itemIds}
            members={pick(draft.itemIds)}
            hiddenIds={NOTHING_HIDDEN}
            testPrefix={`${p}-items`}
            // routine_items keeps an order; program_items does not.
            orderable={kind === 'routine'}
            lead={draft.itemIds.length > 0 ? week.header(MEMBER_ROW_TRAILING_PAD) : undefined}
            row={{ trailing: week.trailing }}
            emptyHint={
              hasNew('items')
                ? undefined
                : kind === 'routine'
                  ? 'The habits you want to run — and pause — together.'
                  : 'Anything that only matters during this stretch.'
            }
            onChange={(itemIds) => onChange({ itemIds })}
            footer={
              <NewItemRows
                draft={draft}
                role="items"
                onChange={onChange}
                testPrefix={`${p}-create-item`}
                placeholder="Add a new item…"
              />
            }
          />
        )}
        {kind === 'routine' && programs.length > 0 && (
          <ProgramPicker draft={draft} onChange={onChange} todayStr={todayStr} testPrefix={p} />
        )}
      </div>
    </div>
  );
}

/**
 * Items typed in as NEW, waiting for the submit that creates them (in order —
 * see createFromDraft), plus the row to type another. Undated tasks, as the
 * goal pane's own add rows make them; a check-in is a weekly Sunday task.
 */
function NewItemRows({
  draft,
  role,
  onChange,
  testPrefix,
  placeholder,
}: {
  draft: ContainerDraft;
  role: NewItemRole;
  onChange: (patch: Partial<ContainerDraft>) => void;
  testPrefix: string;
  placeholder: string;
}) {
  const rows = draft.newItems.filter((n) => n.role === role);
  return (
    <div className="flex flex-col">
      {rows.map((n) => (
        <div key={n.key} className="flex h-[30px] items-center gap-[9px]" data-testid={`${testPrefix}-row`}>
          <span className="text-muted-foreground w-4 shrink-0 text-center text-[10px] font-medium">new</span>
          <span className="font-content text-content text-foreground min-w-0 flex-1 truncate">{n.title}</span>
          <button
            type="button"
            aria-label={`Don't create ${n.title}`}
            data-testid={`${testPrefix}-remove`}
            onClick={() => onChange({ newItems: draft.newItems.filter((x) => x.key !== n.key) })}
            className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-6 place-items-center rounded-[4px]"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <InlineAddRow
        placeholder={placeholder}
        testIdPrefix={testPrefix}
        onAdd={(title) => onChange({ newItems: [...draft.newItems, { key: crypto.randomUUID(), title, role }] })}
      />
    </div>
  );
}

/**
 * A routine's programs, chosen at birth. The hold is written after the
 * routine's own row lands (addRoutine's `programIds`); the consequence line
 * above says when joining an Off program would put its items on hold.
 */
function ProgramPicker({
  draft,
  onChange,
  todayStr,
  testPrefix,
}: {
  draft: ContainerDraft;
  onChange: (patch: Partial<ContainerDraft>) => void;
  todayStr: string;
  testPrefix: string;
}) {
  const programs = usePlannerStore((s) => s.programs);
  return (
    <section className="flex flex-col gap-1.5" data-testid={`${testPrefix}-programs`}>
      <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">In programs</p>
      <div className="flex flex-wrap gap-1.5">
        {programs.map((program) => {
          const on = draft.programIds.includes(program.id);
          return (
            <button
              key={program.id}
              type="button"
              aria-pressed={on}
              data-testid={`${testPrefix}-program`}
              data-program-id={program.id}
              onClick={() =>
                onChange({
                  programIds: on
                    ? draft.programIds.filter((id) => id !== program.id)
                    : [...draft.programIds, program.id],
                })
              }
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-xs transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                on ? 'bg-secondary text-foreground border-transparent' : 'text-muted-foreground border-input border-dashed hover-wash'
              )}
            >
              <CategoryIcon glyph={program.icon} name={program.name} className="size-3" />
              {program.name}
              {!isProgramActiveOn(program, todayStr) && <span className="text-muted-foreground">· off</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
