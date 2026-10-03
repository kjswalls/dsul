'use client';

import { useMemo, useState, type ComponentType } from 'react';
import {
  ChoiceChip,
  ColorChip,
  DateRangeChip,
  type ChoiceOption,
} from '@/components/primitives/organizer-chips';
import { batchHistory, usePlannerStore } from '@/lib/planner-store';
import { InlineAddRow } from '@/components/primitives/organizer-chips';
import { CalendarRange, Flag, Link2, ListChecks, Plus, Repeat, Workflow, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CategoryIcon } from '@/lib/category-icons';
import { isCheckinEligible, isCollectible, isMilestoneEligible } from '@/lib/item-registry';
import { isItemActiveOn, isSeasonActiveOn, resolvePauseWrite } from '@/lib/active';
import { addDaysStr } from '@/lib/container-schedule';
import { resolveGoalStateWrite } from '@/lib/goals';
import {
  defaultWhen,
  newItemPayload,
  previewItem,
  type NewItemWhen,
} from '@/lib/new-item-shape';
import { NewItemWhenChip } from './new-item-when';
import { formatShort, parseDay } from '@/lib/collections';
import { DayChip, NotesField } from './detail-parts';
import {
  ItemMemberList,
  MEMBER_ROW_TRAILING_PAD,
  MemberPicker,
  PickerPopover,
  RoutineMemberList,
} from './member-list';
import {
  GoalSchedule,
  ScheduleHeading,
  SeasonHeatmap,
  useWeekDotsFor,
} from '@/components/planner/schedule/schedule-views';
import { containerMemberIds } from '@/lib/container-schedule';
import type { Goal, GoalRole, Item, Season, Routine, TimeBucket } from '@/lib/planner-types';

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
 *  · a routine's seasons — season_routines rows are written once the
 *    routine's own row has landed (addRoutine's `seasonIds`).
 * `createFromDraft` folds all of it into ONE history entry, so ⌘Z still takes
 * the whole birth back in one press.
 */

export type DraftKind = 'goal' | 'routine' | 'season';

export interface ContainerDraft {
  color?: string;
  /** Goal: the window's start. Season: the run's start. */
  startsOn?: string;
  /** Goal: `targetOn`. Season: `endsOn`. One field, because the chip is one range. */
  endsOn?: string;
  goalState: Goal['state'];
  why: string;
  routinePaused: boolean;
  /** Routine: the resume date, EXCLUSIVE (live again on it). Only read while paused. */
  pausedUntil?: string;
  seasonState: Season['state'];
  itemIds: string[];
  routineIds: string[];
  memberIds: string[];
  milestoneIds: string[];
  checkinIds: string[];
  /** Items typed in as NEW — created (then linked) only when the form is submitted. */
  newItems: NewItemDraft[];
  /** Routine: seasons to hold it from birth. */
  seasonIds: string[];
}

export type NewItemRole = 'items' | GoalRole;

export interface NewItemDraft {
  key: string;
  title: string;
  /** Which section it was typed into: a goal role, or a routine/season's items. */
  role: NewItemRole;
  /** When it happens — seeded by defaultWhen, changed on the row's chip. */
  when: NewItemWhen;
  /** Its part of the day. Anytime unless changed. */
  bucket: TimeBucket;
}

/** The add call each new row becomes — also what the previews draw. */
function payloadFor(kind: DraftKind, n: NewItemDraft, todayStr: string) {
  return newItemPayload(
    { container: kind, role: n.role },
    n.title,
    n.when,
    n.bucket,
    todayStr,
  );
}

/** The draft's new rows as the store WOULD hold them, keyed by the row's key. */
export function draftPreviewItems(kind: DraftKind, newItems: readonly NewItemDraft[], todayStr: string): Item[] {
  return newItems.map((n) => previewItem(n.key, payloadFor(kind, n, todayStr)));
}

/** The draft with its new rows' keys standing in as members — for the previews only. */
function withPreviewMembers(draft: ContainerDraft): ContainerDraft {
  const keys = (role: NewItemRole) => draft.newItems.filter((n) => n.role === role).map((n) => n.key);
  return {
    ...draft,
    itemIds: [...draft.itemIds, ...keys('items')],
    memberIds: [...draft.memberIds, ...keys('member')],
    milestoneIds: [...draft.milestoneIds, ...keys('milestone')],
    checkinIds: [...draft.checkinIds, ...keys('checkin')],
  };
}

/**
 * The defaults — the answers that need no asking. Active, auto-coloured, a
 * goal's window opening TODAY (the user's today, as useToday resolves it), a
 * season on its (absent) dates, which is always-on and hides nothing.
 */
export function initialDraft(kind: DraftKind, todayStr: string, notes?: string): ContainerDraft {
  return {
    color: undefined,
    startsOn: kind === 'goal' ? todayStr : undefined,
    endsOn: undefined,
    goalState: 'active',
    // Notes carried over from an item become a goal's why — or a routine's or
    // season's note (049). One field for every kind, so a trip through the
    // type menu (goal → routine → goal) keeps what was written.
    why: notes ?? '',
    routinePaused: false,
    pausedUntil: undefined,
    seasonState: 'auto',
    itemIds: [],
    routineIds: [],
    memberIds: [],
    milestoneIds: [],
    checkinIds: [],
    newItems: [],
    seasonIds: [],
  };
}

/**
 * Create the container the draft describes, with everything in it, as ONE ⌘Z:
 * the new items first (addTask, each registering its in-flight INSERT), then
 * the container carrying their ids — the store's add waits for those INSERTs
 * before writing the join rows, and for a routine writes its seasons' holds
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
  // addGoal refuses an item in two roles — check BEFORE making any new items,
  // or a refusal would leave them behind while the form says nothing was saved.
  if (kind === 'goal') {
    const linked = [...draft.memberIds, ...draft.milestoneIds, ...draft.checkinIds];
    if (new Set(linked).size !== linked.length) return '';
  }
  const newItemCount = draft.newItems.length;
  let id = '';
  batchHistory(`Add ${kind}: ${name}`, 1 + draft.newItems.length, () => {
    const made: Record<NewItemRole, string[]> = { items: [], member: [], milestone: [], checkin: [] };
    for (const n of draft.newItems) {
      // A routine's rows are habits (always repeating); everything else is a
      // task, one-off or repeating as its row's chip says. The shape rules —
      // no bucket on an undated one-off, an anchor on a repeating task — live
      // in lib/new-item-shape.ts, shared with the previews.
      const payload = payloadFor(kind, n, todayStr);
      made[n.role].push(
        payload.itemType === 'habit'
          ? store.addHabit(payload.data as never)
          : store.addTask(payload.data as never)
      );
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
        ? newItemCount
          ? store.addGoal(buildGoal(name, icon, d, nowIso), { newItemCount })
          : store.addGoal(buildGoal(name, icon, d, nowIso))
        : kind === 'routine'
          ? d.seasonIds.length || newItemCount
            ? store.addRoutine(buildRoutine(name, icon, d, todayStr, nowIso, tz), {
                seasonIds: d.seasonIds,
                newItemCount,
              })
            : store.addRoutine(buildRoutine(name, icon, d, todayStr, nowIso, tz))
          : newItemCount
            ? store.addSeason(buildSeason(name, icon, d), { newItemCount })
            : store.addSeason(buildSeason(name, icon, d));
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
  // The draft's `why` is the routine's note (049): one free-text field per
  // form, and text carried over from an item lands here whichever kind is picked.
  return { name, icon, color: d.color, ...pause, notes: d.why.trim() || undefined, itemIds: d.itemIds };
}

/**
 * The dates travel whatever the state, as they do on the row: under On or Off
 * they wait, unread, until the season is put back on its dates.
 */
export function buildSeason(
  name: string,
  icon: string | undefined,
  d: ContainerDraft,
): Omit<Season, 'id'> {
  return {
    name,
    icon,
    color: d.color,
    state: d.seasonState,
    startsOn: d.startsOn,
    endsOn: d.endsOn,
    notes: d.why.trim() || undefined,
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
 * chip then says what the season is doing, not only how it was set.
 */
export function seasonStates(live: boolean): ChoiceOption<Season['state']>[] {
  return [
    { value: 'active', label: 'On', dot: 'lime' },
    { value: 'paused', label: 'Off', dot: 'muted' },
    { value: 'auto', label: 'Dates', dot: live ? 'lime' : 'muted' },
  ];
}

/* ── the sentences ────────────────────────────────────────────────────── */

/**
 * What a season's dates will do, in words — the Runs chip alone doesn't say
 * that a season on its dates switches ITSELF. Inclusive at both ends, as
 * isSeasonActiveOn reads them; no dates means "on every day", which needs no
 * sentence.
 */
export function seasonRunsCopy(
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

/** The season's state sentence at birth — the manual states need one too. */
function seasonStateCopy(d: ContainerDraft, todayStr: string): string | null {
  // Dates picked under Dates and then hidden by switching to On/Off are still
  // written — so say so, rather than store something the form no longer shows.
  const waiting = d.startsOn || d.endsOn ? ' Its dates are kept, unused, for if you put it back on them.' : '';
  if (d.seasonState === 'active') return `On until you switch it off.${waiting}`;
  if (d.seasonState === 'paused') return `Off from the start — everything it holds is on hold.${waiting}`;
  return seasonRunsCopy(d.startsOn, d.endsOn, todayStr);
}

const DRAFT_ID = '__draft__';

/**
 * What creating this would do to its members' ACTIVATION, asked of the resolver
 * rather than guessed: a paused routine puts its members on hold, a season that
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
  store: { items: readonly Item[]; routines: readonly Routine[]; seasons: readonly Season[] },
  todayStr: string,
  nowIso: string,
  tz: string,
): { hides: number; shows: number } {
  if (kind === 'goal') return { hides: 0, shows: 0 }; // goals never hide anything
  if (d.itemIds.length === 0 && d.routineIds.length === 0) return { hides: 0, shows: 0 };
  const affected = new Set(d.itemIds);
  if (kind === 'season') {
    for (const rid of d.routineIds) store.routines.find((r) => r.id === rid)?.itemIds.forEach((id) => affected.add(id));
  }
  const ctx = { userTimezone: tz, routines: store.routines, seasons: store.seasons };
  const after =
    kind === 'routine'
      ? {
          ...ctx,
          routines: [
            ...store.routines,
            { id: DRAFT_ID, ...buildRoutine('', undefined, d, todayStr, nowIso, tz) },
          ],
          // Joining a season that is off puts the routine's items on hold —
          // the attach discontinuity the season pane confirms, said here.
          seasons: store.seasons.map((p) =>
            d.seasonIds.includes(p.id) ? { ...p, routineIds: [...p.routineIds, DRAFT_ID] } : p
          ),
        }
      : { ...ctx, seasons: [...store.seasons, { id: DRAFT_ID, ...buildSeason('', undefined, d) }] };
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

/* ── the quiet sheet's sections ───────────────────────────────────────── */

type SectionKey = 'milestone' | 'checkin' | 'member' | 'items' | 'routines' | 'seasons';

/** Each kind's sections, in the order they stack once shown. */
const SECTIONS: Record<DraftKind, readonly SectionKey[]> = {
  goal: ['milestone', 'checkin', 'member'],
  routine: ['items', 'seasons'],
  season: ['routines', 'items'],
};

type Adder = { label: string; Icon: ComponentType<{ className?: string }>; hint: string };

/**
 * The verbs on the quiet row. The hint that used to sit on each empty
 * section's heading rides the verb's tooltip instead, so a first-time user
 * hovering "Check-in" still learns what one is.
 */
const SECTION_ADDER: Record<DraftKind, Partial<Record<SectionKey, Adder>>> = {
  goal: {
    milestone: { label: 'Milestone', Icon: Flag, hint: 'Checkpoints on the way' },
    checkin: { label: 'Check-in', Icon: Repeat, hint: 'A regular look back' },
    member: { label: 'Supporting work', Icon: Plus, hint: 'Habits and tasks that serve it' },
  },
  routine: {
    items: { label: 'Items', Icon: ListChecks, hint: 'Habits that run and pause together' },
    seasons: { label: 'Seasons', Icon: CalendarRange, hint: 'Seasons that switch it on and off' },
  },
  season: {
    routines: { label: 'Routines', Icon: Workflow, hint: 'Switch on and off with it' },
    items: { label: 'Items', Icon: ListChecks, hint: 'What only matters for now' },
  },
};

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
  const seasons = usePlannerStore((s) => s.seasons);
  const p = testPrefix;

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is Item => !!i);

  const consequence = useMemo(
    () =>
      draftConsequence(kind, draft, { items, routines, seasons }, todayStr, new Date().toISOString(), tz),
    [kind, draft, items, routines, seasons, todayStr, tz],
  );

  // Local noon on the day after the user's today — the resume picker's floor.
  // pausedUntil is exclusive, so today itself would be a pause that is over.
  const today = parseDay(todayStr)!;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);

  // The charts preview the DRAFT: activation resolves against the store's lists
  // plus this container as it would be created, so a paused routine's dots go
  // quiet and an Off season's calendar goes blank before anything is written.
  //
  // New rows ride along as preview items (their row key as the id), so a habit
  // typed in with its days shows in the week dots and the charts before it
  // exists — as the row the create will actually write.
  const preview = useMemo(() => withPreviewMembers(draft), [draft]);
  // Keyed on the new rows alone: the draft changes on every keystroke in the
  // name or the why, and a fresh list here would rebuild up to 400 days of
  // schedule each time. Undefined when there are none, for the same reason.
  const previewItems = useMemo(
    () => (draft.newItems.length ? draftPreviewItems(kind, draft.newItems, todayStr) : undefined),
    [kind, draft.newItems, todayStr]
  );
  const overrides = useMemo(() => {
    const nowIso = new Date().toISOString();
    if (kind === 'routine') {
      return {
        routines: [...routines, { id: DRAFT_ID, ...buildRoutine('', undefined, preview, todayStr, nowIso, tz) }],
        seasons: seasons.map((p) =>
          draft.seasonIds.includes(p.id) ? { ...p, routineIds: [...p.routineIds, DRAFT_ID] } : p
        ),
        items: previewItems,
      };
    }
    if (kind === 'season') {
      return { seasons: [...seasons, { id: DRAFT_ID, ...buildSeason('', undefined, preview) }], items: previewItems };
    }
    return previewItems ? { items: previewItems } : undefined;
  }, [kind, draft, preview, previewItems, routines, seasons, todayStr, tz]);
  // The coming seven days, not the calendar week: nothing here exists yet, so
  // the days already behind it would only ever read as empty.
  const week = useWeekDotsFor(preview.itemIds, overrides, { ahead: true });
  const calendarIds =
    kind === 'season'
      ? containerMemberIds(
          { kind: 'season', season: { id: DRAFT_ID, ...buildSeason('', undefined, preview) } },
          previewItems ? [...items, ...previewItems] : items,
          routines
        )
      : [];
  // A chart with nothing to draw is noise in a form (Kirby, 2026-09-26): each
  // appears once there is something for it to place.
  const goalHasMembers =
    preview.memberIds.length + preview.milestoneIds.length + preview.checkinIds.length > 0;

  const live =
    kind === 'season' &&
    isSeasonActiveOn({ id: DRAFT_ID, ...buildSeason('', undefined, draft) }, todayStr);

  const hasNew = (role: NewItemRole) => draft.newItems.some((n) => n.role === role);

  // Sections the user asked for on the quiet row, kept even once emptied again
  // (removing the last milestone shouldn't take the add row out from under the
  // pointer). `focusKey` is the one just asked for: its add row mounts focused.
  const [opened, setOpened] = useState<ReadonlySet<SectionKey>>(() => new Set());
  const [focusKey, setFocusKey] = useState<SectionKey | null>(null);
  // The row's Link popover holds the row open: linking into the last hidden
  // section would otherwise unmount the row, and the popover with it, mid-pick.
  const [linkOpen, setLinkOpen] = useState(false);
  const hasContent = (key: SectionKey): boolean => {
    switch (key) {
      case 'milestone':
        return draft.milestoneIds.length > 0 || hasNew('milestone');
      case 'checkin':
        return draft.checkinIds.length > 0 || hasNew('checkin');
      case 'member':
        return draft.memberIds.length > 0 || hasNew('member');
      case 'items':
        return draft.itemIds.length > 0 || hasNew('items');
      case 'routines':
        return draft.routineIds.length > 0;
      case 'seasons':
        return draft.seasonIds.length > 0;
    }
  };
  // Sticky: a section that has held anything stays, so removing its last row
  // never takes the add row, the Link pill and the focused button with it.
  // Adjusted during render, so the frame without it never paints.
  const grown = SECTIONS[kind].filter((key) => !opened.has(key) && hasContent(key));
  if (grown.length > 0) setOpened((o) => new Set([...o, ...grown]));
  // Nothing to hold, nothing to offer: no Seasons verb with no seasons, no
  // Routines verb with no routines.
  const available = (key: SectionKey) =>
    !(key === 'seasons' && seasons.length === 0) && !(key === 'routines' && routines.length === 0);
  const shown = (key: SectionKey): boolean => available(key) && (opened.has(key) || hasContent(key));
  const adders = SECTIONS[kind].filter((key) => available(key) && !shown(key));

  const notes: { key: string; text: string }[] = [];
  if (kind === 'season') {
    const copy = seasonStateCopy(draft, todayStr);
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
        {kind === 'season' && (
          <ChoiceChip
            label="Status"
            value={draft.seasonState}
            options={seasonStates(live)}
            testIdPrefix={`${p}-state`}
            onChange={(seasonState) => onChange({ seasonState })}
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
        {kind === 'season' && draft.seasonState === 'auto' && (
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

      <NotesField
        value={draft.why}
        onChange={(why) => onChange({ why })}
        placeholder={kind === 'goal' ? 'Why this matters…' : 'Add a note…'}
        ariaLabel={kind === 'goal' ? 'Why this goal matters' : `${kind.charAt(0).toUpperCase()}${kind.slice(1)} note`}
        testId={kind === 'goal' ? `${p}-why` : `${p}-note-field`}
      />

      {SECTIONS[kind].some(shown) && (
        <div className="flex flex-col gap-4">
          {kind === 'goal' && shown('milestone') && (
            <ItemMemberList
              label="Milestones"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.milestoneIds}
              members={pick(draft.milestoneIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-milestones`}
              orderable
              picker="popover"
              removeIcon="x"
              pickerHint="One-time items only. A repeating item never finishes."
              eligible={(i) => isMilestoneEligible(i) && !heldElsewhere(draft, 'milestoneIds', i.id)}
              emptyPoolLabel="Nothing eligible yet — a milestone is a one-shot item."
              onChange={(milestoneIds) => onChange({ milestoneIds })}
              footer={<NewItemRows kind={kind} todayStr={todayStr} draft={draft} role="milestone" onChange={onChange} testPrefix={`${p}-create-milestone`} placeholder="Add a milestone…" autoFocus={focusKey === 'milestone'} />}
            />
          )}
          {kind === 'goal' && shown('checkin') && (
            <ItemMemberList
              label="Check-ins"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.checkinIds}
              members={pick(draft.checkinIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-checkins`}
              picker="popover"
              removeIcon="x"
              pickerHint="Repeating items only — a check-in comes round again."
              eligible={(i) => isCheckinEligible(i) && !heldElsewhere(draft, 'checkinIds', i.id)}
              emptyPoolLabel="Nothing eligible yet — a check-in is a repeating item."
              onChange={(checkinIds) => onChange({ checkinIds })}
              footer={<NewItemRows kind={kind} todayStr={todayStr} draft={draft} role="checkin" onChange={onChange} testPrefix={`${p}-create-checkin`} placeholder="Add a weekly check-in…" autoFocus={focusKey === 'checkin'} />}
            />
          )}
          {kind === 'goal' && shown('member') && (
            <ItemMemberList
              label="Supporting work"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.memberIds}
              members={pick(draft.memberIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-supporting`}
              picker="popover"
              removeIcon="x"
              eligible={(i) => isCollectible(i) && !heldElsewhere(draft, 'memberIds', i.id)}
              onChange={(memberIds) => onChange({ memberIds })}
              footer={<NewItemRows kind={kind} todayStr={todayStr} draft={draft} role="member" onChange={onChange} testPrefix={`${p}-create-member`} placeholder="Add supporting work…" autoFocus={focusKey === 'member'} />}
            />
          )}
          {kind === 'season' && shown('routines') && (
            <RoutineMemberList
              season={{ id: DRAFT_ID, name: ownerName }}
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
              picker="popover"
              removeIcon="x"
              // Its adder has no add row to focus, so it opens the list it asked for.
              openOnMount={focusKey === 'routines'}
            />
          )}
          {(kind === 'routine' || kind === 'season') && shown('items') && (
            <ItemMemberList
              label="Items"
              ownerId={DRAFT_ID}
              ownerName={ownerName}
              memberIds={draft.itemIds}
              members={pick(draft.itemIds)}
              hiddenIds={NOTHING_HIDDEN}
              testPrefix={`${p}-items`}
              // routine_items keeps an order; season_items does not.
              orderable={kind === 'routine'}
              picker="popover"
              removeIcon="x"
              lead={preview.itemIds.length > 0 ? week.header(MEMBER_ROW_TRAILING_PAD) : undefined}
              row={{ leading: week.leading, trailing: week.trailing, metaInTooltip: true }}
              onChange={(itemIds) => onChange({ itemIds })}
              footer={
                <NewItemRows
                  kind={kind}
                  todayStr={todayStr}
                  trailing={week.trailing}
                  draft={draft}
                  role="items"
                  onChange={onChange}
                  testPrefix={`${p}-create-item`}
                  placeholder={kind === 'routine' ? 'Add a habit…' : 'Add an item…'}
                  autoFocus={focusKey === 'items'}
                />
              }
            />
          )}
          {kind === 'routine' && shown('seasons') && (
            <SeasonPicker draft={draft} onChange={onChange} todayStr={todayStr} testPrefix={p} />
          )}
        </div>
      )}

      {/* Under the sections, not above them: a chart appearing with the first
          row would otherwise push the add row being typed into down the form. */}
      {kind === 'goal' && goalHasMembers && (
        <GoalSchedule
          goal={{ ...preview, targetOn: draft.endsOn }}
          overrides={overrides}
          testId={`${p}-schedule`}
        />
      )}
      {kind === 'season' && calendarIds.length > 0 && (
        <section className="flex flex-col gap-2" data-testid={`${p}-calendar`}>
          <ScheduleHeading label="Calendar" />
          <SeasonHeatmap
            season={{ state: draft.seasonState, startsOn: draft.startsOn, endsOn: draft.endsOn }}
            memberIds={calendarIds}
            overrides={overrides}
            testId={`${p}-calendar-heatmap`}
            // A season that is off today keeps its (blank) calendar drawn —
            // that is the preview of what off does. A live one with nothing
            // dated is just its tray.
            hideEmptyGrid={live}
          />
        </section>
      )}

      {/* THE QUIET ROW (Kirby, 2026-10-03, direction 1). A section exists only
          once it has something in it or was asked for here, so a new organizer
          opens as name, chips and a note — not a stack of empty headings. Each
          verb leaves this row when its section appears, whose own add row and
          Link pill take over, so nothing is offered twice. */}
      {(adders.length > 0 || linkOpen) && (
        <div className="-mx-1 flex flex-wrap items-center gap-x-0.5 gap-y-1" data-testid={`${p}-adders`}>
          {adders.map((key) => {
            const { label, Icon, hint } = SECTION_ADDER[kind][key]!;
            return (
              <button
                key={key}
                type="button"
                title={hint}
                data-testid={`${p}-adder-${key}`}
                onClick={() => {
                  setOpened((o) => new Set(o).add(key));
                  setFocusKey(key);
                }}
                className="text-muted-foreground hover:text-foreground hover-wash focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-[5px] px-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
              </button>
            );
          })}
          <span className="flex-1" />
          {/* A goal's Link reaches every role from here; a routine's or a
              season's links only into Items, so once Items shows, its own pill
              is the one way in and this one would be the same verb twice. */}
          {(kind === 'goal' || !shown('items') || linkOpen) && (
          <LinkAnything
            kind={kind}
            draft={draft}
            onChange={onChange}
            testPrefix={p}
            open={linkOpen}
            onOpenChange={setLinkOpen}
          />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Items typed in as NEW, waiting for the submit that creates them (in order —
 * see createFromDraft), plus the row to type another. Undated tasks, as the
 * goal pane's own add rows make them; a check-in is a weekly Sunday task.
 */
function NewItemRows({
  kind,
  draft,
  role,
  onChange,
  testPrefix,
  placeholder,
  todayStr,
  trailing,
  autoFocus,
}: {
  kind: DraftKind;
  draft: ContainerDraft;
  role: NewItemRole;
  /** The section was just asked for on the quiet row: type straight into it. */
  autoFocus?: boolean;
  onChange: (patch: Partial<ContainerDraft>) => void;
  testPrefix: string;
  placeholder: string;
  todayStr: string;
  /** The list's week dots, drawn for the row's preview item (routine/season items). */
  trailing?: (item: Item) => React.ReactNode;
}) {
  const rows = draft.newItems.filter((n) => n.role === role);
  const patchRow = (key: string, patch: Partial<NewItemDraft>) =>
    onChange({ newItems: draft.newItems.map((x) => (x.key === key ? { ...x, ...patch } : x)) });
  return (
    <div className="flex flex-col">
      {rows.map((n) => (
        // The member rows' own geometry (px 7, gap 9, a 76px rail slot), so the
        // week dots sit in the same columns as the linked rows' above them.
        // -mx-2 undoes the section foot's px-2 (which centres the add row's
        // plus), so these rows start where the linked rows do.
        <div key={n.key} className="-mx-2 flex h-[30px] items-center gap-[9px] px-[7px]" data-testid={`${testPrefix}-row`}>
          <span className="text-muted-foreground w-[18px] shrink-0 text-center text-[9px] font-semibold tracking-wide uppercase">New</span>
          <span className="font-content text-content text-foreground min-w-0 flex-1 truncate" title={n.title}>{n.title}</span>
          <NewItemWhenChip
            ctx={{ container: kind, role: n.role }}
            when={n.when}
            bucket={n.bucket}
            todayStr={todayStr}
            title={n.title}
            testId={`${testPrefix}-when`}
            onChange={(patch) => patchRow(n.key, patch)}
          />
          {trailing?.({ id: n.key, title: n.title } as Item)}
          {/* The linked rows' control rail is 76px at every width, so this is too. */}
          <span className="flex w-[76px] shrink-0 justify-end">
            <button
              type="button"
              aria-label={`Don't create ${n.title}`}
              data-testid={`${testPrefix}-remove`}
              onClick={() => onChange({ newItems: draft.newItems.filter((x) => x.key !== n.key) })}
              className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring grid size-6 place-items-center rounded-[4px] focus-visible:ring-2 focus-visible:outline-none"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      ))}
      <InlineAddRow
        placeholder={placeholder}
        testIdPrefix={testPrefix}
        autoFocus={autoFocus}
        onAdd={(title) =>
          onChange({
            newItems: [
              ...draft.newItems,
              {
                key: crypto.randomUUID(),
                title,
                role,
                when: defaultWhen({ container: kind, role }),
                bucket: 'anytime',
              },
            ],
          })
        }
      />
    </div>
  );
}

/**
 * The quiet row's Link: one popover for linking an existing item into any of
 * the kind's item sections, so linking never needs its section opened first.
 * A goal picks the role on a switch at the top (Supporting work by default —
 * the widest pool); a routine or season links into its items. Linking makes
 * the section appear, carrying the row with it.
 */
const GOAL_LINK_ROLES = [
  { value: 'member', label: 'Supporting work', key: 'memberIds' },
  { value: 'milestone', label: 'Milestone', key: 'milestoneIds' },
  { value: 'checkin', label: 'Check-in', key: 'checkinIds' },
] as const;

function LinkAnything({
  kind,
  draft,
  onChange,
  testPrefix,
  open,
  onOpenChange,
}: {
  kind: DraftKind;
  draft: ContainerDraft;
  onChange: (patch: Partial<ContainerDraft>) => void;
  testPrefix: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [role, setRole] = useState<(typeof GOAL_LINK_ROLES)[number]['value']>('member');
  const goalRole = GOAL_LINK_ROLES.find((r) => r.value === role)!;
  const ids = kind === 'goal' ? draft[goalRole.key] : draft.itemIds;
  const eligible =
    kind !== 'goal'
      ? isCollectible
      : role === 'milestone'
        ? (i: Item) => isMilestoneEligible(i) && !heldElsewhere(draft, 'milestoneIds', i.id)
        : role === 'checkin'
          ? (i: Item) => isCheckinEligible(i) && !heldElsewhere(draft, 'checkinIds', i.id)
          : (i: Item) => isCollectible(i) && !heldElsewhere(draft, 'memberIds', i.id);
  const hint =
    kind === 'goal' && role === 'milestone'
      ? 'One-time items only. A repeating item never finishes.'
      : kind === 'goal' && role === 'checkin'
        ? 'Repeating items only — a check-in comes round again.'
        : undefined;
  const emptyPool =
    kind === 'goal' && role === 'milestone'
      ? 'Nothing eligible yet — a milestone is a one-shot item.'
      : kind === 'goal' && role === 'checkin'
        ? 'Nothing eligible yet — a check-in is a repeating item.'
        : undefined;

  return (
    <PickerPopover
      open={open}
      onOpenChange={onOpenChange}
      testId={`${testPrefix}-link-popover`}
      trigger={
        <button
          type="button"
          aria-expanded={open}
          data-testid={`${testPrefix}-link`}
          className={cn(
            'text-muted-foreground hover:text-foreground hover-wash focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-[5px] px-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
            open && 'bg-accent text-foreground'
          )}
        >
          <Link2 className="size-3.5" aria-hidden />
          Link<span className="max-sm:hidden"> existing</span>
        </button>
      }
    >
      {kind === 'goal' && (
        <div role="group" aria-label="Link as" className="mb-1 flex gap-0.5 border-b px-0.5 pb-1.5">
          {GOAL_LINK_ROLES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={role === r.value}
              data-testid={`${testPrefix}-link-role-${r.value}`}
              onClick={() => setRole(r.value)}
              className={cn(
                'h-6 rounded-[4px] px-2 text-xs font-medium transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                role === r.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <MemberPicker
        // A new role is a new pool: the query and cursor start over.
        key={role}
        testPrefix={`${testPrefix}-link`}
        memberIds={ids}
        eligible={eligible}
        pickerHint={hint}
        emptyPoolLabel={emptyPool}
        variant="popover"
        // Closes on a pick, unlike a section's picker: the section it linked
        // into appears under it with its own Link pill for the next one, and an
        // open popover would flip above its trigger as the form grew, over the
        // very section that just appeared.
        onPick={(id) => {
          onChange(kind === 'goal' ? { [goalRole.key]: [...ids, id] } : { itemIds: [...ids, id] });
          onOpenChange(false);
        }}
      />
    </PickerPopover>
  );
}

/**
 * A routine's seasons, chosen at birth. The hold is written after the
 * routine's own row lands (addRoutine's `seasonIds`); the consequence line
 * above says when joining an Off season would put its items on hold.
 */
function SeasonPicker({
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
  const seasons = usePlannerStore((s) => s.seasons);
  return (
    <section className="flex flex-col gap-1.5" data-testid={`${testPrefix}-seasons`}>
      <p id={`${testPrefix}-seasons-label`} className="text-muted-foreground text-xs font-medium">
        In seasons
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${testPrefix}-seasons-label`}>
        {seasons.map((season) => {
          const on = draft.seasonIds.includes(season.id);
          return (
            <button
              key={season.id}
              type="button"
              aria-pressed={on}
              data-testid={`${testPrefix}-season`}
              data-season-id={season.id}
              onClick={() =>
                onChange({
                  seasonIds: on
                    ? draft.seasonIds.filter((id) => id !== season.id)
                    : [...draft.seasonIds, season.id],
                })
              }
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-xs transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                on ? 'bg-secondary text-foreground border-transparent' : 'text-muted-foreground border-input border-dashed hover-wash'
              )}
            >
              <CategoryIcon glyph={season.icon} name={season.name} className="size-3" />
              {season.name}
              {!isSeasonActiveOn(season, todayStr) && <span className="text-muted-foreground">· off</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
