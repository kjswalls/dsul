'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Flag, Maximize2, Repeat, Trash2 } from 'lucide-react';
import {
  ChoiceChip,
  ColorChip,
  DateRangeChip,
  InlineAddRow,
} from '@/components/primitives/organizer-chips';
import { usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { isCheckinEligible, isCollectible, isMilestoneEligible } from '@/lib/item-registry';
import { isRecurring } from '@/lib/recurrence';
import { goalProgress, isAchieved, isGoalActive, sortGoalsForDisplay } from '@/lib/goals';
import { GoalProgressTrack } from '@/components/planner/goal-sections';
import {
  byName,
  countLive,
  formatShort,
  matching,
  useLiveItemIds,
  useToday,
} from '@/lib/collections';
import { Eyebrow, ObjectRow } from '../primitives';
import {
  BufferedTextarea,
  CreateForm,
  DetailColumn,
  DetailHead,
  ListColumn,
  NotesField,
  SectionWelcome,
  StatusStrip,
  TitleRow,
} from '../detail-parts';
import { ItemMemberList, type MemberRowParts } from '../member-list';
import { makeIconToken } from '@/lib/category-icons';
import { cn } from '@/lib/utils';
import type { Goal, Item } from '@/lib/planner-types';

/**
 * GOALS — the console's aspire section.
 *
 * The one container whose list row has something to SAY beyond its name: a
 * goal's whole point is that it is going somewhere, so the row carries the
 * milestone fraction and the detail carries the two readings side by side.
 *
 * See memory/plans/long-term-goals.md.
 */

/**
 * Is this item already held by one of the goal's OTHER role arrays?
 *
 * The PK gives an item exactly one role per goal, so a picker that offered an
 * item already held elsewhere would be offering a contradiction — and the write
 * that follows is refused, leaving the store showing the item twice.
 */
function heldElsewhere(
  goal: Goal,
  own: 'memberIds' | 'milestoneIds' | 'checkinIds',
  itemId: string,
): boolean {
  return (['memberIds', 'milestoneIds', 'checkinIds'] as const)
    .filter((k) => k !== own)
    .some((k) => goal[k].includes(itemId));
}

/**
 * One role's section. The heading names the role — Milestone and Check-in are
 * the whole role model, and without headings the pane showed three identical
 * "0 items / Add an item" blocks and never said them — and it is the ONE
 * heading: the member list no longer adds its own count eyebrow beneath it.
 */
function RoleList({
  title,
  count,
  pickerHint,
  goal,
  ids,
  itemsById,
  testPrefix,
  orderable,
  eligible,
  emptyPool,
  lead,
  row,
  footer,
  onChange,
}: {
  title: string;
  count?: React.ReactNode;
  pickerHint?: string;
  goal: Goal;
  ids: string[];
  itemsById: Map<string, Item>;
  testPrefix: string;
  orderable?: boolean;
  eligible: (item: Item) => boolean;
  emptyPool?: string;
  lead?: React.ReactNode;
  row?: MemberRowParts;
  footer?: React.ReactNode;
  onChange: (ids: string[]) => void;
}) {
  return (
    <ItemMemberList
      label={title}
      count={count}
      lead={lead}
      footer={footer}
      pickerHint={pickerHint}
      row={row}
      ownerId={goal.id}
      ownerName={goal.name}
      memberIds={ids}
      members={ids.map((id) => itemsById.get(id)).filter((i): i is Item => !!i)}
      // Goals never suppress, so nothing here is ever dimmed for activation.
      hiddenIds={EMPTY_IDS}
      testPrefix={testPrefix}
      orderable={orderable}
      eligible={eligible}
      emptyPoolLabel={emptyPool}
      onChange={onChange}
    />
  );
}

/** Shared, so a fresh Set per render never churns a memo downstream. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

/* ── the section ──────────────────────────────────────────────────────────── */

export function GoalsSection({
  selectedId,
  onSelect,
  creating,
  onNew,
  onCreated,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The console's "opened straight into making one" signal — see its callers. */
  creating: boolean;
  onNew: () => void;
  onCreated: (id: string | null) => void;
}) {
  const goals = usePlannerStore((s) => s.goals);
  const items = usePlannerStore((s) => s.items);
  const addGoal = usePlannerStore((s) => s.addGoal);
  const addTask = usePlannerStore((s) => s.addTask);
  const deleteTask = usePlannerStore((s) => s.deleteTask);
  const deleteHabit = usePlannerStore((s) => s.deleteHabit);
  const updateGoal = usePlannerStore((s) => s.updateGoal);
  const removeGoal = usePlannerStore((s) => s.removeGoal);
  const setGoalState = usePlannerStore((s) => s.setGoalState);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const confirm = useUIStore((s) => s.confirm);

  // Same three-part gate the other container sections use, and the third part
  // is the one that is easy to miss: creating before the fetch has landed lets
  // initializeStore's set() overwrite `goals` with what came back, erasing the
  // row the user just made while its INSERT usually succeeds — so they make it
  // again and own two. That is the trap the scope rail shipped once.
  const canCreate = goalsAvailable && !!userId && !isLoading;
  const showCreate = canCreate && (creating || goals.length === 0);

  const [query, setQuery] = useState('');
  const liveItemIds = useLiveItemIds();
  const { todayStr } = useToday();

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // Ended goals sink below the live ones rather than interleaving by
  // sort_order. Over the horizon a goal actually spans, a mixed list reads as
  // clutter by year two — and this list is the only place they are browsable.
  const ordered = useMemo(() => sortGoalsForDisplay(goals), [goals]);
  const shown = matching(ordered, query, byName);
  const selected = goals.find((g) => g.id === selectedId) ?? null;

  const firstEndedIndex = shown.findIndex((g) => !isGoalActive(g));

  /**
   * A new checkpoint, created and linked in one gesture.
   *
   * NO `timeBucket`, and the first version of this had one on reasoning that
   * was exactly backwards. `deriveDayItems` tests `startDate` BEFORE it looks
   * at a bucket, so a bucket buys an undated item nothing on a day column —
   * while the braindump excludes on `isScheduled || timeBucket`, and `addTask`
   * derives `isScheduled` from the bucket. So bucketing an undated milestone
   * removed it from the one list undated work lives in and added it to none:
   * it was visible on no planner surface at all.
   *
   * Undated on purpose. A checkpoint's date is a commitment, and guessing one
   * (today? the goal's target?) would put a date on the timeline the user never
   * chose. So it lands in the braindump — which is where the plan already says
   * undated milestones live — carrying its flag, until it is given a day.
   */
  /**
   * A weekly check-in, created and linked in one gesture.
   *
   * Weekly is the seeded default (Kirby's answer to open question 7) and it is
   * a DEFAULT, not a policy: the cadence lives on the item, so the row's own
   * repeat control edits it afterwards like any other recurring task. Nothing
   * about the cadence is stored on the goal — one timing per item, the
   * membership-only principle programs-routines locked.
   *
   * DATED and bucketed, unlike a milestone — and the first version of this was
   * bucketed but undated, on a premise that is exactly backwards. A recurring
   * TASK is gated by its anchor: `deriveDayItems` returns false on
   * `!task.startDate` BEFORE it ever reaches `shouldShowOnDate`, and then
   * requires `startDate <= dateStr`. (Habits are the un-anchored type; check-ins
   * created here are tasks.) So without a start date the check-in rendered on no
   * column at all, while the bucket kept it out of the braindump too — the one
   * combination the item dialog itself cannot produce.
   *
   * Anchored at TODAY: the cadence starts now, and an anchor in the past would
   * back-date occurrences nobody agreed to.
   */
  const createCheckin = (goal: Goal, title: string) => {
    addTask(
      {
        title,
        status: 'pending',
        isScheduled: false,
        order: 0,
        startDate: todayStr,
        timeBucket: 'anytime',
        repeatFrequency: 'custom',
        // Sunday. A weekly review wants the seam between weeks, and picking a
        // weekday would put it inside the week it is meant to be reviewing.
        repeatDays: [0],
        completedDates: [],
        skippedDates: [],
      } as never,
      { goalIds: [goal.id], goalRole: 'checkin' },
    );
  };

  const createMilestone = (goal: Goal, title: string) => {
    addTask(
      {
        title,
        status: 'pending',
        isScheduled: false,
        order: 0,
        completedDates: [],
        skippedDates: [],
      } as never,
      { goalIds: [goal.id], goalRole: 'milestone' },
    );
  };

  /**
   * Supporting work, made in place: an undated task that lands in the braindump
   * as a plain member — the same shape and the same reason as a milestone
   * above, minus the flag.
   */
  const createMember = (goal: Goal, title: string) => {
    addTask(
      {
        title,
        status: 'pending',
        isScheduled: false,
        order: 0,
        completedDates: [],
        skippedDates: [],
      } as never,
      { goalIds: [goal.id], goalRole: 'member' },
    );
  };

  /** One addGoal, carrying whatever the create form asked for — never a create then a patch. */
  const create = (name: string, icon: string | undefined, extra: GoalCreateFields) => {
    const id = addGoal({
      name,
      icon,
      why: extra.why.trim() || undefined,
      startsOn: extra.startsOn,
      targetOn: extra.targetOn,
      state: 'active',
      memberIds: [],
      milestoneIds: [],
      checkinIds: [],
    });
    onCreated(id);
  };

  // BOTH columns, always — the console's contract (organize-console.tsx: "Each
  // section owns both columns"). This used to early-return one or the other,
  // which on desktop unmounted the list, the filter and the create row the
  // moment a goal was clicked; BackRow is `md:hidden`, so above `md` there was
  // then no way back to the list at all without changing rail sections.
  return (
    <>
      <ListColumn
        eyebrow="GOALS"
        count={shown.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter goals…',
          testId: 'goals-filter',
        }}
        onNew={{ onClick: onNew, label: 'New goal', testId: 'goal-new', disabled: !canCreate }}
      >
        {!goalsAvailable ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs" data-testid="goals-unavailable">
            Goals aren&apos;t available on this account yet.
          </p>
        ) : goals.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No goals yet.</p>
        ) : (
          shown.map((goal, i) => {
            const { achieved, total } = goalProgress(goal, itemsById);
            return (
              <div key={goal.id}>
                {i === firstEndedIndex && i > 0 && (
                  <div
                    className="my-1.5 flex items-center gap-2 px-1"
                    data-testid="goals-ended-divider"
                  >
                    <span className="bg-border h-px flex-1" />
                    <Eyebrow>ENDED</Eyebrow>
                    <span className="bg-border h-px flex-1" />
                  </div>
                )}
                <ObjectRow
                  testId="goal-row"
                  idAttr={{ 'data-goal-id': goal.id }}
                  icon={goal.icon}
                  color={goal.color}
                  name={goal.name}
                  selected={selectedId === goal.id}
                  // The pill carries the quiet progress fraction while a goal is
                  // running, and its state once it is not. The numeral column
                  // beside it means "how much is in here" in every other
                  // section, so it counts MEMBERS — a goal holding five habits
                  // and no milestones read "0" there when it counted only
                  // milestones.
                  pill={
                    goal.state === 'achieved'
                      ? 'Achieved'
                      : goal.state === 'abandoned'
                        ? 'Set aside'
                        : total > 0
                          ? `${achieved}/${total}`
                          : null
                  }
                  pillTestId="goal-state-pill"
                  count={countLive(
                    [...goal.memberIds, ...goal.milestoneIds, ...goal.checkinIds],
                    liveItemIds,
                  )}
                  onSelect={() => onSelect(goal.id)}
                />
              </div>
            );
          })
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <GoalCreateForm
            autoFocus={creating}
            onCreate={create}
            onCancel={goals.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          <GoalDetail
            goal={selected}
            itemsById={itemsById}
            onBack={() => onSelect(null)}
            onChange={(updates) => updateGoal(selected.id, updates)}
            onState={(state) => setGoalState(selected.id, state)}
            onCreateMilestone={(title) => createMilestone(selected, title)}
            onCreateCheckin={(title) => createCheckin(selected, title)}
            onCreateMember={(title) => createMember(selected, title)}
            onRetire={(item) =>
              confirm({
                title: `Delete ${item.title}?`,
                description:
                  'It stops repeating and moves to the trash for 30 days. Its history goes ' +
                  'with it. To keep the history and just pause it, open the item and put it ' +
                  'in a program instead.',
                confirmLabel: 'Delete',
                destructive: true,
                onConfirm: () =>
                  item.type === 'habit' ? deleteHabit(item.id) : deleteTask(item.id),
              })
            }
            onDelete={() =>
              confirm({
                title: `Delete ${selected.name}?`,
                // The sentence that has to be here. "Delete Learn Chinese"
                // sounds like it takes a year of work with it, and it does not.
                description:
                  `The goal moves to the trash for 30 days. Its habits, tasks and milestones ` +
                  `are ordinary items and stay exactly where they are — only the goal and its ` +
                  `links go.`,
                confirmLabel: 'Delete goal',
                destructive: true,
                onConfirm: () => {
                  removeGoal(selected.id);
                  onSelect(null);
                },
              })
            }
          />
        ) : (
          <SectionWelcome section="goals">
            A goal is the reason a stretch of work exists — learning a language, building
            something over years. It holds the habits and tasks that serve it, the checkpoints
            along the way, and a recurring check-in. It never hides anything.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

/* ── making one ───────────────────────────────────────────────────────────── */

interface GoalCreateFields {
  why: string;
  startsOn?: string;
  targetOn?: string;
}

/**
 * "+ New" for a goal. The name, and the two things that DEFINE a goal beyond
 * it — why it matters and the window it runs in — asked at birth, the same
 * fields the "new" dialog's goal mode asks. The window starts today: a goal is
 * usually begun the day it is named, and a target is the half worth asking.
 */
function GoalCreateForm({
  autoFocus,
  onCreate,
  onCancel,
}: {
  autoFocus: boolean;
  onCreate: (name: string, icon: string | undefined, extra: GoalCreateFields) => void;
  onCancel?: () => void;
}) {
  const [why, setWhy] = useState('');
  // The USER's today, as the "new" dialog seeds it — the browser's would stamp
  // a different start for the same goal near midnight when the two zones differ.
  const { todayStr } = useToday();
  const [startsOn, setStartsOn] = useState<string | undefined>(todayStr);
  const [targetOn, setTargetOn] = useState<string | undefined>(undefined);
  return (
    <CreateForm
      eyebrow="NEW GOAL"
      placeholder="Name your goal…"
      addLabel="Create goal"
      icon={makeIconToken('Target')}
      testPrefix="goal"
      autoFocus={autoFocus}
      hint="A goal is the reason a stretch of work exists. It holds the habits and tasks that serve it, the checkpoints along the way, and a recurring check-in — and it never hides anything."
      fields={
        <>
          <NotesField
            value={why}
            onChange={setWhy}
            placeholder="Why this matters…"
            ariaLabel="Why this goal matters"
            testId="goal-new-why"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <DateRangeChip
              label="Window"
              start={startsOn}
              end={targetOn}
              startLabel="Started"
              endLabel="Target"
              emptyLabel="Target"
              testIdPrefix="goal-new-window"
              onChange={(start, end) => {
                setStartsOn(start);
                setTargetOn(end);
              }}
            />
          </div>
        </>
      }
      onCreate={(name, icon) => onCreate(name, icon, { why, startsOn, targetOn })}
      onCancel={onCancel}
    />
  );
}

/* ── the detail pane ──────────────────────────────────────────────────────── */

const GOAL_STATES = [
  { value: 'active', label: 'Active', dot: 'lime' },
  { value: 'achieved', label: 'Achieved', dot: 'muted' },
  { value: 'abandoned', label: 'Set aside', dot: 'muted' },
] as const satisfies readonly { value: Goal['state']; label: string; dot: string }[];

/** The latest day a recurring item was done, or undefined. yyyy-MM-dd sorts as text. */
function lastDone(item: Item): string | undefined {
  const dates = 'completedDates' in item ? (item.completedDates ?? []) : [];
  return dates.reduce<string | undefined>((max, d) => (!max || d > max ? d : max), undefined);
}

/**
 * The goal, in the item edit pane's grammar (2026-09-25): a whisper and ⋯, a
 * serif title, one row of chips (status, window, colour), the why as serif
 * notes, then one section per role. Making a goal in the "new" dialog and
 * editing it here are the same body, so the two read as one object.
 */
function GoalDetail({
  goal,
  itemsById,
  onBack,
  onChange,
  onState,
  onCreateMilestone,
  onCreateCheckin,
  onCreateMember,
  onRetire,
  onDelete,
}: {
  goal: Goal;
  itemsById: Map<string, Item>;
  onBack: () => void;
  onCreateMilestone: (title: string) => void;
  onCreateCheckin: (title: string) => void;
  onCreateMember: (title: string) => void;
  onRetire: (item: Item) => void;
  onChange: (updates: Partial<Goal>) => void;
  onState: (state: Goal['state']) => void;
  onDelete: () => void;
}) {
  const toggleTaskStatus = usePlannerStore((s) => s.toggleTaskStatus);
  const { achieved, total } = goalProgress(goal, itemsById);

  // Membership patches always carry all three arrays. The reconcile would
  // accept one, but sending the whole set makes the write independent of which
  // list the user touched — and identical to what create sends.
  const members = (patch: Partial<Record<'memberIds' | 'milestoneIds' | 'checkinIds', string[]>>) =>
    onChange({
      memberIds: goal.memberIds,
      milestoneIds: goal.milestoneIds,
      checkinIds: goal.checkinIds,
      ...patch,
    });

  /**
   * A milestone row can be TICKED — the one exception to "a member row is an
   * address" in this console, and a deliberate one: reaching a checkpoint is
   * the gesture a goal exists to record, and sending the user off to find the
   * item on some day column to do it made the goal the last place you could.
   * The tick is the item's own store action, the one its row's checkbox calls
   * (a milestone is one-shot by eligibility, so it never needs a date).
   */
  const milestoneRow: MemberRowParts = {
    done: isAchieved,
    leading: (item) => {
      const done = isAchieved(item);
      return (
        <button
          type="button"
          onClick={() => toggleTaskStatus(item.id)}
          data-testid="goal-milestone-check"
          aria-pressed={done}
          aria-label={done ? `Mark ${item.title} not reached` : `Mark ${item.title} reached`}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
            done
              ? 'border-primary bg-primary'
              : 'border-muted-foreground/45 bg-surface-3 hover:border-primary'
          )}
        >
          {done && <Check className="text-primary-foreground size-2.5" aria-hidden />}
        </button>
      );
    },
    meta: (item) => ({
      text: 'startDate' in item && item.startDate ? formatShort(item.startDate) : '',
      numeric: true,
    }),
  };

  const checkinRow: MemberRowParts = {
    leading: () => <Repeat className="text-muted-foreground size-3.5" aria-hidden />,
    meta: (item) => {
      const last = lastDone(item);
      return { text: last ? `last ${formatShort(last)}` : '', numeric: false };
    },
  };

  return (
    <div className="flex flex-col gap-4" data-testid="goal-detail" data-goal-id={goal.id}>
      <DetailHead
        kind="Goal"
        color={goal.color}
        name={goal.name}
        testPrefix="goal"
        back={{ label: 'Goals', testId: 'goal-back', onBack }}
        actions={
          /* The console EDITS a goal; the page READS one. On a phone this is the
             only link to the page from inside the console, so it is a plain,
             always-visible link rather than a hover affordance. next/link, not a bare <a>: a hard document load would
             tear down the hydrated store and re-run every fetch. */
          <Link
            href={`/goal/${goal.id}`}
            data-testid="goal-open-page"
            /* Shuts the console on the way out. These links are the console's
               own EXITS, and they leave the route that mounts it — so without
               this the dialog slot stays armed at a console that no longer
               exists, and the breadcrumb back to dsul springs it open unasked.
               That is the same stale-slot ambush lib/console-door.ts exists to
               end, arriving from the other direction.

               `onNavigate`, NOT `onClick`: next/link runs an onClick handler
               first and unconditionally, before it has decided whether this
               click is a navigation at all — so ⌘-clicking to read the goal in
               a background tab would slam the console shut in this one,
               selection and all. onNavigate fires only once a real client-side
               navigation is going ahead. */
            onNavigate={() => useUIStore.getState().closeDialog()}
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 text-[11px] transition-colors"
          >
            <Maximize2 className="size-3" aria-hidden />
            Open as page
          </Link>
        }
        menu={[
          /* The delete, one tap behind ⋯ — no filled red zone. A goal goes to
             the trash and its members stay put, so it is not the console's one
             irreversible delete (that is the item type's). */
          {
            label: 'Delete goal',
            icon: <Trash2 className="size-3.5" />,
            testId: 'delete-goal',
            destructive: true,
            onSelect: onDelete,
          },
        ]}
      />

      <TitleRow
        id={goal.id}
        name={goal.name}
        icon={goal.icon}
        label="Goal"
        testPrefix="goal"
        onPatch={onChange}
      />

      {goal.state !== 'active' && (
        <EndedNotice goal={goal} itemsById={itemsById} onDelete={onRetire} />
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceChip
          label="Status"
          value={goal.state}
          options={GOAL_STATES}
          testIdPrefix="goal-state"
          onChange={onState}
        />
        {/* One range, fenced so start ≤ target. An inverted range fails
            SILENTLY — timeElapsed returns null, so the elapsed readout simply
            stops existing. */}
        <DateRangeChip
          start={goal.startsOn}
          end={goal.targetOn}
          startLabel="Started"
          endLabel="Target"
          emptyLabel="Target"
          testIdPrefix="goal-window"
          onChange={(startsOn, targetOn) => onChange({ startsOn, targetOn })}
        />
        <ColorChip
          value={goal.color}
          testId="goal-color"
          onChange={(color) => onChange({ color })}
        />
      </div>

      {/*
        The WHY, and it is a first-class field rather than a note: a goal that
        survives three years survives on the reason, and this is the line Beacon
        is handed when it is asked what the user is working towards. Buffered,
        like every other typed field in this console — live-bound it armed a
        history label, a set() and a PATCH per KEYSTROKE, and one sentence would
        have evicted the user's entire 50-deep undo stack.
      */}
      <BufferedTextarea
        value={goal.why ?? ''}
        onCommit={(next) => onChange({ why: next.trim() || undefined })}
        placeholder="Why this matters…"
        ariaLabel="Why this goal matters"
        testId="goal-why"
      />

      {/*
        Each picker excludes the OTHER two arrays as well as its own. Otherwise
        the natural "this member is really a milestone" gesture offers an item
        that is already a member, sends a patch naming it twice, and the write
        is refused — leaving the store showing it in two lists and every
        subsequent membership edit on this goal failing the same way.

        Two ways to add per section, now labelled apart: "Link existing" by the
        heading picks an item you already have; the row at the foot makes a new
        one and links it — the flow `Memberships.goalRole` was built for.
      */}
      <div className="mt-1.5 flex flex-col gap-5">
        <RoleList
          title="Milestones"
          count={total > 0 ? `${achieved} of ${total}` : undefined}
          pickerHint="One-time items only. A repeating item never finishes."
          goal={goal}
          ids={goal.milestoneIds}
          itemsById={itemsById}
          testPrefix="goal-milestone"
          orderable
          eligible={(i) => isMilestoneEligible(i) && !heldElsewhere(goal, 'milestoneIds', i.id)}
          emptyPool="Nothing eligible yet — a milestone is a one-shot item."
          lead={<GoalProgressTrack goal={goal} achieved={achieved} total={total} />}
          row={milestoneRow}
          onChange={(ids) => members({ milestoneIds: ids })}
          footer={
            <InlineAddRow
              placeholder="Add milestone…"
              testIdPrefix="goal-new-milestone"
              onAdd={onCreateMilestone}
            />
          }
        />

        <RoleList
          title="Check-ins"
          pickerHint="Repeating items only — a check-in comes round again."
          goal={goal}
          ids={goal.checkinIds}
          itemsById={itemsById}
          testPrefix="goal-checkin"
          eligible={(i) => isCheckinEligible(i) && !heldElsewhere(goal, 'checkinIds', i.id)}
          emptyPool="Nothing eligible yet — a check-in is a repeating item."
          row={checkinRow}
          onChange={(ids) => members({ checkinIds: ids })}
          footer={
            <InlineAddRow
              placeholder="Add weekly check-in…"
              testIdPrefix="goal-new-checkin"
              onAdd={onCreateCheckin}
            />
          }
        />

        <RoleList
          title="Supporting work"
          goal={goal}
          ids={goal.memberIds}
          itemsById={itemsById}
          testPrefix="goal-member"
          // isCollectible AND not-held-elsewhere. A custom `eligible` REPLACES
          // the picker's default (`eligible ?? isCollectible` in member-list),
          // so omitting it here silently widened the pool to subtasks and
          // non-collectible types — against locked decision 3, which says plain
          // `member` reuses isCollectible with its subtask exclusion.
          eligible={(i) => isCollectible(i) && !heldElsewhere(goal, 'memberIds', i.id)}
          onChange={(ids) => members({ memberIds: ids })}
          footer={
            <InlineAddRow
              placeholder="Add supporting work…"
              testIdPrefix="goal-new-member"
              onAdd={onCreateMember}
            />
          }
        />
      </div>
    </div>
  );
}

/**
 * The wind-down (decision 5).
 *
 * An ended goal stops appearing in chips and lists, but its RECURRING members
 * do not stop: the weekly check-in it created keeps arriving in every Sunday
 * EOD with the reason stripped away, and nothing else in the app will ever
 * mention the goal again. Naming them here — at the moment the state was
 * changed — is the only point where the connection is still obvious.
 *
 * It names them and offers the two verbs that actually end a recurrence, and it
 * performs NEITHER on the goal's behalf: the goal writes nothing to its members
 * ever, so Delete is the ordinary store action and "Open" is the ordinary item
 * surface, where the Program chip is how you park something without losing it.
 * A goal that quietly deleted a year of habits because you marked it achieved
 * would be the single worst thing this feature could do.
 *
 * It sits where the item pane puts its paused note, above the chips.
 */
function EndedNotice({
  goal,
  itemsById,
  onDelete,
}: {
  goal: Goal;
  itemsById: Map<string, Item>;
  onDelete: (item: Item) => void;
}) {
  const recurring = [...goal.checkinIds, ...goal.memberIds, ...goal.milestoneIds]
    .map((id) => itemsById.get(id))
    .filter((i): i is Item => !!i && isRecurring(i));

  if (recurring.length === 0) return null;

  return (
    <StatusStrip testId="goal-wind-down" icon={<Flag className="size-3.5" aria-hidden />}>
      <p className="max-w-[58ch]">
        {recurring.length === 1
          ? 'This still repeats on its own schedule.'
          : `${recurring.length} of its items still repeat on their own schedules.`}{' '}
        Nothing was changed for you — {goal.state === 'achieved' ? 'an achieved' : 'a set-aside'}{' '}
        goal never edits its members. Keep them as they are, open one to park it in a program,
        or delete it for good.
      </p>
      <div className="mt-2 flex flex-col gap-1">
        {recurring.map((item) => (
          <div
            key={item.id}
            className="text-foreground flex items-center gap-2 text-[13px]"
            data-testid="goal-wind-down-row"
          >
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {/* LABELLED. Decision 5's third affordance — park it in a program
                rather than end it — used to be prose inside the DELETE confirm,
                which meant discovering the non-destructive option required
                opening a dialog whose button says Delete. */}
            <Link
              href={`/item/${item.id}`}
              data-testid="goal-wind-down-open"
              /* Shuts the console behind you — see `goal-open-page` above,
                 including why this is onNavigate and not onClick. */
              onNavigate={() => useUIStore.getState().closeDialog()}
              className="text-muted-foreground hover:text-foreground shrink-0 text-[11px] transition-colors"
            >
              Open
            </Link>
            <button
              type="button"
              onClick={() => onDelete(item)}
              data-testid="goal-wind-down-delete"
              className="text-muted-foreground hover:text-destructive shrink-0 text-[11px] transition-colors"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </StatusStrip>
  );
}
