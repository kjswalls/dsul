'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useIsMobile } from '@/hooks/use-mobile';
import { addDays, format, parseISO, startOfDay, subDays } from 'date-fns';
import {
  CalendarClock,
  CalendarIcon,
  Check,
  Clock,
  Flag,
  Flame,
  Moon,
  Bell,
  Pause as PauseIcon,
  Play as PlayIcon,
  ArrowLeftToLine,
  Maximize2,
  Minus,
  MoreHorizontal,
  Plus,
  Redo2,
  Repeat,
  Repeat2,
  RotateCcw,
  SkipForward,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  ResponsiveModalTitle,
  ResponsiveModalDescription,
} from '@/components/ui/responsive-modal';
import {
  ADD_MODAL_CLASS,
  ColorSquare,
  EnterHint,
  NewTypeMenu,
  SERIF_NOTES_CLASS,
  SERIF_TITLE_CLASS,
  SurfaceA11yHeader,
  SurfaceContent,
  SurfaceRoot,
} from '@/components/planner/surface';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconPicker } from '@/components/primitives/icon-picker';
import { AddIconButton } from '@/components/primitives/add-icon-button';
import { ClearingFooter, ItemDetailSections } from '@/components/planner/item-detail-sections';
import {
  ChipOption,
  ChipSectionLabel,
  PropertyChip,
} from '@/components/primitives/property-chip';
import { usePlannerStore } from '@/lib/planner-store';
import { useGoalsEnabled, useOrganizeEnabled, useStreaksEnabled } from '@/lib/extension-gates';
import { accentColorForName } from '@/lib/accent-colors';
import { goalItemIds, milestoneItemIds, nextMilestone } from '@/lib/goals';
import { formatShort } from '@/lib/collections';
import { useUIStore, openBulkAdd, openNewContainer } from '@/lib/ui-store';
import { useOpenConsole } from '@/lib/console-door';
import { isBulkPaste } from '@/lib/bulk-add';
import type {
  HabitItem,
  Item,
  Priority,
  RepeatFrequency,
  Task,
  TimeBucket,
} from '@/lib/planner-types';
import { REPEAT_FREQUENCY_LABELS, WEEKDAY_LABELS } from '@/lib/planner-types';
import {
  ALL_ITEM_TYPES,
  getItemTypeConfig,
  itemTypeName,
  isPausable,
  isCollectible,
  isRemindable,
  isSkippable,
} from '@/lib/item-registry';
import {
  CONVERT_REPEAT_CHOICES,
  conversionBlock,
  conversionHint,
  summarizeConversion,
  type ConvertRepeat,
} from '@/lib/item-convert';
import {
  canMoveToNextDay,
  canSendToBraindump,
  formatTargetDay,
  nextDayLabel,
  nextDayTarget,
} from '@/lib/row-moves';
import { RowControl, RowControlDivider, RowControlGroup } from '@/components/primitives/row-control';
import {
  CONTAINER_KINDS,
  classifyKindForItemType,
  type ContainerKind,
} from '@/lib/container-registry';
import { membershipSummary, visibleContainerBands } from '@/lib/item-bands';
import {
  currentDayOfWeek,
  isCompletedOnDate,
  isRecurring,
  isSkippedOnDate,
  shouldShowOnDate,
  toDateStr,
} from '@/lib/recurrence';
import { isPausedOn, suppressionReason, suppressionLabel } from '@/lib/active';
import { makeIconToken } from '@/lib/category-icons';
import { heldByTrash, useTrashedNames } from '@/components/planner/organize/use-trashed-names';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * The one add/edit dialog for every item type, replacing AddTaskDialog /
 * EditTaskDialog / EditHabitDialog. Which fields render is driven by the
 * type-capability registry (lib/item-registry.ts); the per-type save adapters
 * at the bottom keep the store contract (schedule* second pass, explicit
 * `undefined` clears) byte-compatible with the pre-unification dialogs.
 */

const PRIORITY_ORDER = ['none', 'low', 'medium', 'high'] as const;
const PRIORITY_LABELS: Record<Priority | 'none', string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const BUCKET_ORDER: TimeBucket[] = ['anytime', 'morning', 'afternoon', 'evening'];
const BUCKET_LABELS: Record<TimeBucket, string> = {
  anytime: 'Anytime',
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
};

const DURATION_ORDER = ['15', '30', '45', '60', '90', '120'];
const DURATION_LABELS: Record<string, string> = {
  '15': '15 min',
  '30': '30 min',
  '45': '45 min',
  '60': '1 hour',
  '90': '1.5 hours',
  '120': '2 hours',
};

const DATE_SHORTCUTS = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
];

/**
 * The "create one from here" affordance inside a membership chip's popover (C2).
 *
 * A "New routine…" row that opens into a name + icon field, mirroring the
 * project container chip's inline create. It owns its OWN open/name/icon state
 * rather than parking a draft on ItemDraft the way the single-select container
 * chip does — the membership chips are multi-select and this create is transient
 * UI, not part of the item being built, so a local hook keeps it self-contained
 * and off the draft's carry-across-type-switch path.
 *
 * On submit it calls `onCreate(name, icon)` — which creates the container and
 * ticks it on — then collapses back to the row. The popover stays open (unlike
 * the single-select container chip, which closes on create): you have just
 * added one member and may well add another, and the new one is now in the list
 * above, checked.
 */
export function InlineCreate({
  label,
  defaultIcon,
  testId,
  onCreate,
}: {
  label: string;
  defaultIcon: string;
  testId: string;
  onCreate: (name: string, icon: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState(defaultIcon);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, icon);
    setName('');
    setIcon(defaultIcon);
    setOpen(false);
  };

  if (!open) {
    return (
      <ChipOption tone="primary" onSelect={() => setOpen(true)} testId={`${testId}-open`}>
        <Plus className="size-3.5" />
        {label}
      </ChipOption>
    );
  }

  return (
    <div className="flex gap-1 p-1">
      <IconPicker value={icon} name={name} onSelect={setIcon} />
      <Input
        autoFocus
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-9 flex-1 text-sm"
        // Enter creates here, never submitting the whole dialog — same guard the
        // container chip's field carries.
        data-sub-input
        data-testid={`${testId}-name`}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          submit();
        }}
      />
      <AddIconButton size="input" onClick={submit} aria-label={label} data-testid={`${testId}-add`} />
    </div>
  );
}

/** Last 14 days of a habit's completion history, oldest first. */
function recentStreakDays(habit: HabitItem): boolean[] {
  const today = startOfDay(new Date());
  return Array.from({ length: 14 }, (_, i) =>
    habit.completedDates.includes(format(subDays(today, 13 - i), 'yyyy-MM-dd'))
  );
}
// ── The two shapes of the surface ────────────────────────────────────────────
// SurfaceRoot / SurfaceContent / SurfaceA11yHeader live in ./surface, shared
// with ContainerDialog so an organizer's "new" body wears this exact shell.

/** `type` is the registry name ('task', 'habit', or a custom slug like 'goal'). */
export type ItemDialogState =
  | { mode: 'add'; type: string; bucket?: TimeBucket; date?: Date; title?: string }
  | { mode: 'edit'; item: Item };

interface ItemDialogProps {
  /** null = closed. Must be referentially stable per open (memoize upstream). */
  state: ItemDialogState | null;
  onOpenChange: (open: boolean) => void;
  /** /item/[id] mounts its own dialog NEXT TO the same sections — it passes
   *  false so the panel doesn't render a second live copy of them. */
  withDetailSections?: boolean;
  /**
   * How the surface presents itself. 'modal' is the Radix dialog (desktop) /
   * vaul drawer (mobile). 'panel' is the non-modal docked inspector: no portal,
   * no overlay, no focus trap, no scroll lock — it is a layout sibling of the
   * canvas, so the shell compresses the day rather than covering it, and you
   * can keep working behind it. Edit-only; add is always a modal.
   */
  presentation?: 'modal' | 'panel';
  /**
   * Docked-panel only. When true the panel drops its card chrome (bg, border,
   * radius) and sits flat on the app backdrop — the plane BELOW the <main>
   * card, matching the braindump column. The shell passes it; the /item page
   * leaves it false because its panel is a fixed overlay that must stay framed.
   */
  flat?: boolean;
}

/** Local form state. 'none' / '' are UI sentinels, translated to `undefined`
 *  at save time — they must never reach the store. */
export interface ItemDraft {
  title: string;
  /** Free text the user and the agents both read. '' saves as `undefined`. */
  notes: string;
  priority: Priority | 'none';
  /** Container NAME (containers are name-referenced pre-Phase-6). */
  container: string;
  startDate: Date | undefined;
  timeBucket: TimeBucket | 'none';
  startTime: string;
  duration: string;
  repeatFrequency: RepeatFrequency;
  repeatDays: number[];
  repeatMonthDay: number;
  timesPerDay: string;
  /** HH:mm for this item's daily cue, or '' for no reminder (migration 032). */
  reminderTime: string;
  /** The implementation-intention phrase the cue is worded around. */
  reminderAnchor: string;
  /**
   * Routine ids, ADD MODE ONLY. In edit mode the chip writes membership live
   * through the store, because a routine is not a column on the item — it is a
   * join row, and the panel's scoped-write machinery only knows about columns.
   * Deliberately absent from DRAFT_KEYS for the same reason.
   */
  routineIds: string[];
  /** Program ids, ADD MODE ONLY — same two-write-paths reasoning as routineIds. */
  programIds: string[];
  /**
   * Goal ids, ADD MODE ONLY — same reasoning again.
   *
   * No role travels with them: the chip only ever adds a PLAIN MEMBER. The two
   * roles that constrain their items (a milestone must be one-shot, a check-in
   * must recur) are granted from the goal's own detail pane, where the picker
   * can filter by the registry predicate and the user is looking at the goal's
   * timeline. Offering roles on a chip attached to a half-typed item would
   * grant a role the demotion rule might take straight back.
   */
  goalIds: string[];
  newContainer: { show: boolean; name: string; icon: string };
}

/** Every draft key that maps to stored data — `newContainer` is transient UI. */
export const DRAFT_KEYS = [
  'title',
  'notes',
  'priority',
  'container',
  'startDate',
  'timeBucket',
  'startTime',
  'duration',
  'repeatFrequency',
  'repeatDays',
  'repeatMonthDay',
  'timesPerDay',
  'reminderTime',
  'reminderAnchor',
] as const satisfies readonly (keyof ItemDraft)[];

/** Typed, not picked — these wait for blur instead of saving on every pause. */
const TYPED_KEYS: readonly string[] = ['title', 'notes', 'reminderAnchor'];

/**
 * The store payload for the draft fields named in `keys`, and nothing else.
 *
 * Scoping the write is what makes a non-modal surface safe: the canvas behind
 * the panel stays live, so a full-property write on every autosave would revert
 * whatever the grid, an undo, or an agent did to the same item while it was
 * open. The modal passes DRAFT_KEYS and gets the original whole-item save.
 *
 * Exported for tests/unit/item-panel-writes.test.ts — this is the invariant.
 */
export function taskUpdatesFromDraft(d: ItemDraft, keys: readonly string[]): Partial<Task> {
  const wants = (...fields: string[]) => fields.some((f) => keys.includes(f));
  const updates: Partial<Task> = {};
  if (wants('title')) updates.title = d.title.trim();
  if (wants('notes')) updates.notes = d.notes.trim() || undefined;
  if (wants('priority')) updates.priority = d.priority === 'none' ? undefined : d.priority;
  if (wants('container')) updates.project = d.container === 'none' ? undefined : d.container;
  // Save date as yyyy-MM-dd string to avoid timezone issues
  if (wants('startDate'))
    updates.startDate = d.startDate ? format(d.startDate, 'yyyy-MM-dd') : undefined;
  if (wants('duration')) updates.duration = d.duration ? parseInt(d.duration) : undefined;
  if (wants('startTime')) updates.startTime = d.startTime || undefined;
  // The three repeat fields are one control; touching any means writing all.
  if (wants('repeatFrequency', 'repeatDays', 'repeatMonthDay')) {
    updates.repeatFrequency = d.repeatFrequency !== 'none' ? d.repeatFrequency : undefined;
    updates.repeatDays = d.repeatFrequency === 'custom' ? d.repeatDays : undefined;
    updates.repeatMonthDay = d.repeatFrequency === 'monthly' ? d.repeatMonthDay : undefined;
  }
  // Reminder fields are one control, so touching either writes both — the same
  // rule the three repeat fields follow. '' means "no reminder": the DB column
  // is null-means-off, and undefined is what the allowlist turns into null.
  if (wants('reminderTime', 'reminderAnchor')) {
    updates.reminderTime = d.reminderTime || undefined;
    updates.reminderAnchor = d.reminderTime ? d.reminderAnchor.trim() || undefined : undefined;
  }
  return updates;
}

export function habitUpdatesFromDraft(d: ItemDraft, keys: readonly string[]): Partial<HabitItem> {
  const wants = (...fields: string[]) => fields.some((f) => keys.includes(f));
  const updates: Partial<HabitItem> = {};
  if (wants('title')) updates.title = d.title.trim();
  if (wants('notes')) updates.notes = d.notes.trim() || undefined;
  // `project`, not `group` — one CLASSIFY kind since 039.
  if (wants('container')) updates.project = d.container;
  if (wants('timesPerDay')) updates.timesPerDay = parseInt(d.timesPerDay) || 1;
  if (wants('startTime')) updates.startTime = d.startTime || undefined;
  if (wants('duration')) updates.duration = d.duration ? parseInt(d.duration) : undefined;
  if (wants('repeatFrequency', 'repeatDays', 'repeatMonthDay')) {
    updates.repeatFrequency = d.repeatFrequency;
    updates.repeatDays = d.repeatFrequency === 'custom' ? d.repeatDays : undefined;
    updates.repeatMonthDay = d.repeatFrequency === 'monthly' ? d.repeatMonthDay : undefined;
  }
  // Reminder fields are one control, so touching either writes both — the same
  // rule the three repeat fields follow. '' means "no reminder": the DB column
  // is null-means-off, and undefined is what the allowlist turns into null.
  if (wants('reminderTime', 'reminderAnchor')) {
    updates.reminderTime = d.reminderTime || undefined;
    updates.reminderAnchor = d.reminderTime ? d.reminderAnchor.trim() || undefined : undefined;
  }
  return updates;
}

interface AddSeed {
  bucket?: TimeBucket;
  date?: Date;
  defaultTimeBucket: TimeBucket;
  /** The one container list, since 039 collapsed the two CLASSIFY kinds. */
  containers: { name: string }[];
}

function makeAddDraft(type: string, seed: AddSeed): ItemDraft {
  const config = getItemTypeConfig(type);
  return {
    title: '',
    notes: '',
    priority: 'none',
    // Required containers fall back like the old add dialog: first container,
    // else legacy lowercase 'personal' (NOT orphanContainerFallback — changing
    // this changes where a fresh account's habits land). The lowercase spelling
    // is exactly why `CONTAINER_KINDS.project.caseFold` is true: this value is
    // written against a seeded 'Personal' whenever the list has not loaded.
    container: config.containerRequired
      ? seed.containers[0]?.name || 'personal'
      : 'none',
    startDate: config.dateAnchored ? seed.date : undefined,
    timeBucket: seed.bucket ?? seed.defaultTimeBucket ?? 'anytime',
    startTime: '',
    // The type's own default block length. All three currently say 30, which is
    // what this literal was — so a new type can change it without touching here.
    duration: config.schedule.defaultBlockMinutes.toString(),
    repeatFrequency: config.defaultFrequency,
    repeatDays: [],
    repeatMonthDay: 1,
    timesPerDay: '1',
    // Off by default. A reminder is a thing dsul does to you unprompted, so
    // it is opted into per item rather than seeded on for every new one.
    reminderTime: '',
    reminderAnchor: '',
    routineIds: [],
    goalIds: [],
    programIds: [],
    newContainer: {
      show: false,
      name: '',
      icon: makeIconToken(config.form.newContainerIcon),
    },
  };
}

function buildAddDrafts(seed: AddSeed): Record<string, ItemDraft> {
  return Object.fromEntries(ALL_ITEM_TYPES.map((t) => [t, makeAddDraft(t, seed)]));
}

function draftFromItem(item: Item): ItemDraft {
  const config = getItemTypeConfig(itemTypeName(item));
  // Parse date string as local date, not UTC
  // "2026-03-22" should be March 22 local time, not UTC midnight which shows as March 21
  let startDate: Date | undefined;
  if (item.type !== 'habit' && item.startDate) {
    // startDate is always a string; handle legacy ISO format just in case
    const dateStr = item.startDate.includes('T')
      ? item.startDate.split('T')[0]
      : item.startDate;
    const [year, month, day] = dateStr.split('-').map(Number);
    startDate = new Date(year, month - 1, day); // month is 0-indexed
  }
  return {
    title: item.title,
    notes: item.notes || '',
    priority: item.type !== 'habit' ? item.priority || 'none' : 'none',
    container: item.project || (config.containerRequired ? '' : 'none'),
    startDate,
    timeBucket: item.timeBucket || 'none',
    startTime: item.startTime || '',
    // Every type carries a duration now, so this reads the item's own value
    // rather than pinning habits to a hardcoded '30' they could never change.
    duration: item.duration?.toString() || config.schedule.defaultBlockMinutes.toString(),
    repeatFrequency: item.repeatFrequency ?? config.defaultFrequency,
    repeatDays: item.repeatDays || [],
    repeatMonthDay: item.repeatMonthDay || 1,
    timesPerDay: item.type === 'habit' ? item.timesPerDay?.toString() || '1' : '1',
    reminderTime: item.reminderTime || '',
    reminderAnchor: item.reminderAnchor || '',
    // Always empty, and that is not an oversight: in edit mode the membership
    // chips read the LIVE join off the store and write through
    // updateRoutine/updateProgram, so a draft copy would be a second source of
    // truth that the panel's scoped-write machinery would then try to persist
    // as a column. Present so the object satisfies ItemDraft; deliberately
    // never read on the edit path.
    routineIds: [],
    goalIds: [],
    programIds: [],
    newContainer: {
      show: false,
      name: '',
      icon: makeIconToken(config.form.newContainerIcon),
    },
  };
}

/**
 * How long a CLOSED body keeps rendering, so the exit animation has content.
 *
 * The wrapper below unmounts the body after close, but not ON close: the modal
 * plays a 200ms exit and the mobile drawer ~500ms, and both paint the latched
 * payload (`last`) through those frames. Unmounting at the moment `state` goes
 * null would blank the surface mid-animation. The panel presentation unmounts
 * its content instantly (SurfaceContent returns null when closed), so the only
 * cost of the grace is a few idle renders of a null aside.
 */
const CLOSE_ANIMATION_GRACE_MS = 600;

/**
 * Thin permanent shell around the real surface.
 *
 * Both shell instances of this dialog (app-shell's modal, desktop-shell's
 * docked panel) are mounted for the whole session, and the body below is
 * ~2,300 lines that subscribe to the whole planner store and build every chip's
 * element tree on each pass. Mounting the body only while the surface is open
 * (plus the exit grace above) is what makes a closed dialog actually free —
 * no store subscription, no hooks, no element building.
 *
 * Two contracts survive the unmount on purpose:
 *  · "A cancelled dialog deliberately keeps its other draft fields" — the add
 *    drafts are stashed in a ref up here (per instance, so the /item page's
 *    copy can't bleed into the shell's) and re-seed the body's state on the
 *    next open.
 *  · A queued panel autosave flushes on unmount — the body's own
 *    `return () => flush.current()` cleanup already runs when it unmounts.
 */
export function ItemDialog(props: ItemDialogProps) {
  const { state } = props;
  const [present, setPresent] = useState(!!state);
  // Render-phase, not an effect: the body must mount in the SAME commit that
  // opens the dialog, or the open gains a frame of empty portal.
  if (state && !present) setPresent(true);

  // Resolved HERE, where a whole-session mount has let it settle, because the
  // body below mounts fresh per open: useIsMobile starts undefined and settles
  // in an effect, so a fresh ResponsiveModal deciding for itself would
  // first-commit the desktop Dialog on a phone and then swap Root to the
  // Drawer — remounting the entire open surface and double-firing autoFocus.
  const isMobile = useIsMobile();

  useEffect(() => {
    if (state || !present) return;
    const t = setTimeout(() => setPresent(false), CLOSE_ANIMATION_GRACE_MS);
    return () => clearTimeout(t);
  }, [state, present]);

  // Survives the body's unmount so cancelled add drafts keep their fields.
  // Handed down as a read/write pair rather than the ref itself: the compiler
  // lint can't see that a ref-typed PROP is safe to mutate, and it's right to
  // be suspicious — this keeps the mutation in the ref's own component.
  const draftStash = useRef<Record<string, ItemDraft> | null>(null);
  const readDraftStash = useCallback(() => draftStash.current, []);
  const writeDraftStash = useCallback((drafts: Record<string, ItemDraft>) => {
    draftStash.current = drafts;
  }, []);

  if (!present) return null;
  return (
    <ItemDialogInner
      {...props}
      isMobile={isMobile}
      readDraftStash={readDraftStash}
      writeDraftStash={writeDraftStash}
    />
  );
}

function ItemDialogInner({
  state,
  onOpenChange,
  withDetailSections = true,
  presentation = 'modal',
  flat = false,
  isMobile,
  readDraftStash,
  writeDraftStash,
}: ItemDialogProps & {
  isMobile: boolean;
  readDraftStash: () => Record<string, ItemDraft> | null;
  writeDraftStash: (drafts: Record<string, ItemDraft>) => void;
}) {
  const {
    items,
    addItem,
    addTask,
    addHabit,
    updateTask,
    updateHabit,
    deleteTask,
    deleteHabit,
    changeItemType,
    moveTaskToDate,
    setItemSkipped,
    toggleHabitStatus,
    scheduleTask,
    unscheduleTask,
    scheduleHabit,
    resetHabitStreak,
    projects,
    getProjectColor,
    addProject,
    defaultTimeBucket,
    itemTypes,
    userTimezone,
    setItemPaused,
    routines,
    programs,
    collectionsAvailable,
    updateRoutine,
    updateProgram,
    goals,
    goalsAvailable,
    updateGoal,
    // Inline container creation from the membership chips (C2): each returns the
    // new id, which toggleRoutine/Program/Goal then ticks on in whichever mode
    // the dialog is in.
    addRoutine,
    addProgram,
    addGoal,
  } = usePlannerStore();
  /**
   * The two extension gates this dialog answers to.
   *
   * The dialog is a READOUT, not a feature — the weight ledger's word for it —
   * so nothing here is gated for its own sake. `goalsOn` takes the Goal chip
   * because the chip IS goal membership; `organizeOn` takes the three
   * "Organize …" rows because each is a door to a console that will not open.
   * A door to a shut room is worse than no door: it is the one kind of dead
   * control that looks like a bug rather than a choice.
   */
  const goalsOn = useGoalsEnabled();
  const organizeOn = useOrganizeEnabled();
  // Streaks off hides the whole streak strip AND the reset controls below: a
  // reset for a number you cannot see is a control with nothing to act on.
  const streaksOn = useStreaksEnabled();

  // Hoisted out of renderChips, which runs on every render of a component that
  // subscribes to the whole store — so this rebuilt an N-item Map on every
  // keystroke in the title field.
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  /**
   * The names a trashed container is still holding.
   *
   * Gated on `state`, and that is not only about cost. This body now mounts on
   * open (see the wrapper above), which already spares the closed instances the
   * fetch — but the gate stays: the body lingers mounted through the close
   * grace, and without the gate those closing frames would re-ask for a
   * surface that is on its way out. Asking on open also makes the answer
   * FRESHER than a mount-time read could be, which is what the previous note
   * here was apologising for.
   *
   * Still not a guarantee: a container binned while this is open is invisible to
   * the fetched list. The union in the hook covers same-session deletes, and the
   * store's rollback (undoFailedCreate) covers the rest. This is the polite
   * refusal; that is the net.
   */
  const trashedNames = useTrashedNames({ enabled: !!state });

  const router = useRouter();
  const pathname = usePathname();

  /* Every "Organize …" door below goes through this rather than arming the
     dialog slot directly. This component renders in three shells and only two
     of them mount the console — see lib/console-door.ts. */
  const openConsole = useOpenConsole();

  // Tab order: built-ins first (pinned), then user-defined types.
  const typeNames = useMemo(
    () => [...ALL_ITEM_TYPES, ...itemTypes.map((t) => t.name)],
    [itemTypes]
  );

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // The type a switch is waiting on the confirm for, and the repeat a one-off
  // picks up when it becomes a repeat-only type (lib/item-convert.ts).
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [convertRepeat, setConvertRepeat] = useState<ConvertRepeat>('daily');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPauseUntil, setShowPauseUntil] = useState(false);
  // Clearing layout only: the unset properties the user has summoned back from
  // the "+ Add property" seed. A property leaves this set the moment it holds a
  // value (it is then set, and shows for that reason); until then it stays a
  // dashed chip in the field rather than folding back into the seed mid-edit.
  // Keyed by property id ('date', 'repeat', 'routine', …). Reset per item below.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const revealProp = (key: string) =>
    setRevealed((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  // The property just picked from the seed, for the ONE commit that mounts its
  // chip: the chip reads it as `defaultOpen`, so the picker you asked for is
  // already open with focus inside it rather than waiting on a second click.
  // Cleared right after that commit — `defaultOpen` is only read at mount, and
  // a stale key would reopen the chip on any later remount.
  const [autoOpenProp, setAutoOpenProp] = useState<string | null>(null);
  useEffect(() => {
    if (autoOpenProp) setAutoOpenProp(null);
  }, [autoOpenProp]);

  // Latch the last payload so content doesn't flicker to defaults while the
  // close animation plays (same render-phase pattern app-shell used for add).
  // A new payload also disarms any confirm left open for the previous one —
  // the streak-reset AlertDialog unmounts with its flag stuck true otherwise.
  const [last, setLast] = useState<ItemDialogState | null>(state);
  if (state && state !== last) {
    setLast(state);
    setShowDeleteConfirm(false);
    setShowResetConfirm(false);
    // Disarmed with its siblings for the same reason: a picker left open across
    // a payload change would pause the wrong item.
    setShowPauseUntil(false);
    // A revealed property is about THIS item; a fresh payload starts calm again.
    setRevealed(new Set());
    setAutoOpenProp(null);
  }
  const open = !!state;
  const mode = last?.mode ?? 'add';
  const isPanel = presentation === 'panel';
  /** Only the docked panel saves itself; the modal still commits on submit. */
  const autosaves = isPanel && mode === 'edit';
  /**
   * The "Clearing" layout — a label-less field of only the properties that are
   * SET, plus one "+ Add property" seed, the title and notes in serif — is now
   * the layout of EVERY item surface: the docked edit panel, the /item editor,
   * the add-capture modal and the mobile drawer. It shipped gated on the two
   * autosaving surfaces and that gate is gone, so there is no `clearing` flag
   * any more; what still differs between surfaces is persistence, and that is
   * `autosaves` asked directly at the two places it decides something:
   *
   *  · the top rail carries Done (flush + close) only where there is nothing to
   *    submit, and the footer carries the status + submit row everywhere else;
   *  · Activity stays in the body wherever ClearingFooter isn't there to fold it
   *    into its history line.
   *
   * The one remaining layout question is `mode`: add offers the type as a
   * control, edit only whispers it.
   */
  const addPayload = last?.mode === 'add' ? last : null;

  // The payload carries a SNAPSHOT (ui-store stamps it at open time). Re-resolve
  // it against the store so the surface shows live truth — the streak strip, the
  // agent block, and a title changed by a drag elsewhere all used to sit stale
  // until reopen. The snapshot stays the fallback: after a delete, `items` no
  // longer has the row and the latch is what keeps the closing frame painted.
  const latched = last?.mode === 'edit' ? last.item : null;
  const editItem = latched
    ? (items.find((i) => i.id === latched.id) ?? latched)
    : null;
  const editConfig = editItem ? getItemTypeConfig(itemTypeName(editItem)) : null;

  // Resolved at TODAY, not selectedDate — pausing is dateless (plan decision 3),
  // and `editItem` is re-read from the store every render, so this flips the
  // moment a pause lands, in all three presentations.
  const activationTz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Deliberately ITEM-LEVEL, and it must stay that way: this drives the
  // Pause/Resume menu, and setItemPaused early-returns when the item's own
  // state already matches. Widening it to include container causes would offer
  // "Resume" on a routine-suppressed item, and that Resume would be a genuine
  // silent no-op — the item stays hidden because its routine is what hid it.
  const pausedNow = !!editItem && isPausedOn(editItem, toDateStr(new Date(), activationTz), activationTz);
  // The full reason, for the note only. Covers the container causes the menu
  // can't act on, so the user at least learns why nothing they do here shows up.
  const activationReason = editItem
    ? suppressionReason(editItem, toDateStr(new Date(), activationTz), {
        userTimezone: activationTz,
        routines,
        programs,
      })
    : null;
  const canPause = !!editItem && isPausable(editItem);
  // Goal milestones, for the type switch's refusals and the Braindump gate
  // (a milestone's date is its target — lib/row-moves.ts).
  const typeSwitchMilestones = useMemo(() => milestoneItemIds(goals ?? []), [goals]);

  const [activeType, setActiveType] = useState<string>('task');
  // Re-seeded from the wrapper's stash: this component unmounts after close,
  // and the drafts a cancelled dialog keeps must outlive it.
  const [addDrafts, setAddDrafts] = useState<Record<string, ItemDraft>>(
    () => readDraftStash() ?? buildAddDrafts({ defaultTimeBucket, containers: projects })
  );
  useEffect(() => {
    writeDraftStash(addDrafts);
  }, [addDrafts, writeDraftStash]);
  const [editDraft, setEditDraft] = useState<ItemDraft | null>(null);

  // ── Autosave bookkeeping (panel only; the modal still commits on submit) ────
  // `pending` carries the (item, draft) pair rather than reading them off the
  // latch, so a queued save can still be flushed for an item the panel has
  // already retargeted away from.
  /** Autosave has no button to press, so the surface says so out loud. */
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ item: Item; draft: ItemDraft; keys: string[] } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useRef<() => void>(() => {});

  // Edit mode: re-init the whole draft from the item. Render-phase rather than
  // an effect so switching edit targets (habit → task) never paints one frame of
  // the previous item's draft in the new type's form.
  //
  // Keyed on the item's ID, not its identity. `editItem` is live now, so every
  // write to it — including the panel's own autosave — hands back a new object;
  // re-seeding on identity would rewrite the draft mid-keystroke and drop
  // whatever was typed during the save. Closing releases the seed so reopening
  // the same item re-reads it (the `!state` branch is `else if` for a reason:
  // both firing in one render would re-seed and loop).
  const [seededId, setSeededId] = useState<string | null>(null);
  const [syncedItem, setSyncedItem] = useState<Item | null>(null);
  if (state?.mode === 'edit' && editItem && editItem.id !== seededId) {
    setSeededId(editItem.id);
    setSyncedItem(editItem);
    setEditDraft(draftFromItem(editItem));
    // Whatever was pending belongs to the item being left; the retarget effect
    // flushes it, and the fresh target starts clean.
    setSaving(false);
  } else if (autosaves && editItem && editItem !== syncedItem) {
    // The item moved under an OPEN panel — dragged on the canvas, resized,
    // undone, or written by an agent. Non-modal means that is a normal event,
    // not a conflict, so the panel follows along. Skipped while a save is
    // queued: that draft is the newer truth and re-seeding would eat the
    // keystrokes it hasn't committed yet.
    setSyncedItem(editItem);
    if (!saving) setEditDraft(draftFromItem(editItem));
  } else if (!state && seededId !== null) {
    setSeededId(null);
  }

  // Add mode: each open re-seeds only the type, buckets, and the anchored date.
  // A cancelled dialog deliberately keeps its other draft fields (full reset
  // happens on successful save) — pre-unification behavior.
  //
  // Render-phase, like the edit seeding above, and for a sharper reason than
  // flicker: with one form instead of a tab per type, the title input mounts
  // ONCE. `autoFocus` only fires on mount, so seeding the type in an effect
  // committed the first frame with the previous open's type — and if that type
  // wasn't 'task', the input mounted unfocused and React ignored the prop flip.
  // Opening Add Task right after Add Habit left focus parked on the type chip.
  const [seededAdd, setSeededAdd] = useState<ItemDialogState | null>(null);
  if (addPayload && addPayload !== seededAdd) {
    setSeededAdd(addPayload);
    setActiveType(addPayload.type);
    const bucket = addPayload.bucket ?? defaultTimeBucket ?? 'anytime';
    setAddDrafts((drafts) => {
      const next = { ...drafts };
      // typeNames/projects are read fresh here, which is safe now that this
      // runs on a new payload identity rather than on an effect's dep list.
      for (const t of typeNames) {
        // Custom types hydrate after mount — seed a fresh draft on first sight.
        const base = drafts[t] ?? makeAddDraft(t, { defaultTimeBucket, containers: projects });
        next[t] = {
          ...base,
          // A quick-add hand-off seeds the title; a plain open keeps whatever
          // draft title was already there (cancels preserve the draft).
          title: addPayload.title ?? base.title,
          timeBucket: bucket,
          ...(getItemTypeConfig(t).dateAnchored ? { startDate: addPayload.date } : null),
        };
      }
      return next;
    });
  }

  /**
   * Switching type carries the draft across rather than swapping in whatever
   * was last typed under the target type. With tabs, per-type drafts read as
   * two parallel forms; with one form and a type switcher, losing the title you
   * just typed reads as a bug.
   *
   * Container is STILL not carried, and the reason changed with 039 rather than
   * disappearing: it is one namespace now, but the target's own default (the
   * first container, for a type that requires one) is what a type that requires
   * a container must land on — carrying 'none' across from a task would produce
   * a habit filed nowhere. Fields the target type has no use for ride along
   * harmlessly: its save adapter never reads them.
   */
  const switchType = (next: string) => {
    if (next === activeType) return;
    const from = draftFor(activeType);
    const fromConfig = getItemTypeConfig(activeType);
    const config = getItemTypeConfig(next);

    // Carry a field only if the SOURCE type actually exposed it. Copying a
    // field the source never rendered means copying its default, which
    // silently overwrites whatever the target draft already held — that is how
    // a hop through Habit erased a task's seeded date and turned a one-shot
    // task into a daily one.
    const exposed = (field: string) => fromConfig.fields.includes(field);
    // Likewise a frequency: only a value the user actually chose travels. A
    // habit sitting at its 'daily' default must not make the next task daily.
    const chosenFrequency =
      from.repeatFrequency !== fromConfig.defaultFrequency &&
      (config.allowedFrequencies as readonly string[]).includes(from.repeatFrequency);

    setAddDrafts((drafts) => {
      const base = drafts[next] ?? makeAddDraft(next, { defaultTimeBucket, containers: projects });
      return {
        ...drafts,
        [next]: {
          ...base,
          title: from.title,
          notes: exposed('notes') ? from.notes : base.notes,
          priority: exposed('priority') ? from.priority : base.priority,
          startDate:
            config.dateAnchored && fromConfig.dateAnchored ? from.startDate : base.startDate,
          timeBucket: from.timeBucket,
          startTime: from.startTime,
          // Carried like every other typed-in field: someone who set a cue and
          // then realised this is really a habit has not changed their mind
          // about the cue.
          reminderTime: from.reminderTime,
          reminderAnchor: from.reminderAnchor,
          duration: exposed('duration') ? from.duration : base.duration,
          timesPerDay: fromConfig.counters.dailyCounts ? from.timesPerDay : base.timesPerDay,
          repeatFrequency: chosenFrequency ? from.repeatFrequency : base.repeatFrequency,
          repeatDays: chosenFrequency ? from.repeatDays : base.repeatDays,
          repeatMonthDay: chosenFrequency ? from.repeatMonthDay : base.repeatMonthDay,
          // Membership is type-agnostic — a routine holds whatever is
          // collectible — so a chosen container survives the hop, unlike the
          // per-type fields above. It is dropped only when the TARGET can't
          // hold membership at all, which would otherwise write join rows for
          // an item whose chip is hidden.
          routineIds: config.collectible ? from.routineIds : [],
          goalIds: config.collectible ? from.goalIds : [],
          programIds: config.collectible ? from.programIds : [],
        },
      };
    });
    setActiveType(next);
  };

  /** Draft for a type, with a default for custom types not yet seeded. */
  const draftFor = (type: string): ItemDraft =>
    addDrafts[type] ?? makeAddDraft(type, { defaultTimeBucket, containers: projects });

  const patchDraft = (type: string, updates: Partial<ItemDraft>) => {
    if (last?.mode === 'edit') {
      if (!editDraft) return;
      const next = { ...editDraft, ...updates };
      setEditDraft(next);
      if (autosaves) scheduleSave(editDraft, next, updates);
    } else {
      setAddDrafts((d) => ({
        ...d,
        [type]: { ...(d[type] ?? makeAddDraft(type, { defaultTimeBucket, containers: projects })), ...updates },
      }));
    }
  };

  const resetAddDrafts = () => {
    const seed = { bucket: addPayload?.bucket, defaultTimeBucket, containers: projects };
    setAddDrafts(
      Object.fromEntries(typeNames.map((t) => [t, makeAddDraft(t, seed)]))
    );
  };

  // ── Save adapters — faithful ports of the per-type dialogs' handlers ──────

  const handleAddSave = (type: string) => {
    // Guard on the LIVE state, not the latch — the latch stays populated
    // through the close animation and must never re-arm a save (the old
    // dialogs disarmed instantly when their item prop went null).
    if (!state || state.mode !== 'add') return;
    const d = draftFor(type);
    if (!d.title.trim()) return;

    if (type !== 'habit') {
      const effectiveTimeBucket = d.startDate
        ? d.timeBucket === 'none'
          ? 'anytime'
          : d.timeBucket
        : undefined;
      // Task-shaped payload; custom types dispatch to the generic addItem.
      const create = type === 'task' ? addTask : addItem.bind(null, type);
      create({
        title: d.title.trim(),
        notes: d.notes.trim() || undefined,
        priority: d.priority === 'none' ? undefined : d.priority,
        project: d.container === 'none' ? undefined : d.container,
        startDate: d.startDate ? format(d.startDate, 'yyyy-MM-dd') : undefined,
        duration: d.duration ? parseInt(d.duration) : undefined,
        timeBucket: effectiveTimeBucket,
        startTime: d.startTime || undefined,
        repeatFrequency: d.repeatFrequency !== 'none' ? d.repeatFrequency : undefined,
        repeatDays: d.repeatFrequency === 'custom' ? d.repeatDays : undefined,
        repeatMonthDay: d.repeatFrequency === 'monthly' ? d.repeatMonthDay : undefined,
        reminderTime: d.reminderTime || undefined,
        reminderAnchor: d.reminderTime ? d.reminderAnchor.trim() || undefined : undefined,
      // One gesture, one history entry: the item row and its join rows land in
      // the same set(), so ⌘Z reverses the whole add rather than half of it.
      }, { routineIds: d.routineIds, programIds: d.programIds, goalIds: d.goalIds });
    } else {
      addHabit({
        title: d.title.trim(),
        notes: d.notes.trim() || undefined,
        project: d.container,
        timeBucket: d.timeBucket === 'none' ? 'anytime' : d.timeBucket,
        startTime: d.startTime || undefined,
        duration: d.duration ? parseInt(d.duration) : undefined,
        repeatFrequency: d.repeatFrequency,
        repeatDays: d.repeatFrequency === 'custom' ? d.repeatDays : undefined,
        repeatMonthDay: d.repeatFrequency === 'monthly' ? d.repeatMonthDay : undefined,
        timesPerDay: parseInt(d.timesPerDay) || 1,
        reminderTime: d.reminderTime || undefined,
        reminderAnchor: d.reminderTime ? d.reminderAnchor.trim() || undefined : undefined,
      }, { routineIds: d.routineIds, programIds: d.programIds, goalIds: d.goalIds });
    }

    resetAddDrafts();
    onOpenChange(false);
  };

  /**
   * The edit write, as a pure function of (item, draft, touched fields).
   *
   * Pure in `item` because the panel autosaves: a queued save has to be
   * flushable for the item the panel already moved OFF of, which a closure over
   * `editItem` could no longer name.
   *
   * Scoped by `keys` because the panel is NON-MODAL, which makes the draft a
   * claim about the fields you touched rather than about the whole item. The
   * canvas behind the panel is live — you can drag the very block you have open
   * — so writing the full property set back would silently revert that drag (and
   * an undo, and an agent's write) on the next keystroke's save. The modal has
   * no such window and still passes DRAFT_KEYS for a byte-identical full save.
   *
   * Scheduling compares against the LIVE item, not the seeded snapshot: after
   * the first autosave the snapshot's isScheduled/startTime are stale, and a
   * stale comparison re-runs scheduleTask — which unconditionally clears
   * inProjectBlock and the previous-slot fields — on every subsequent save.
   */
  const commitEdit = (item: Item, d: ItemDraft, keys: readonly string[]) => {
    if (!d.title.trim()) return;
    const wants = (...fields: string[]) => fields.some((f) => keys.includes(f));
    const startTime = d.startTime || undefined;

    // Habit first; task and custom items share the task-shaped save path
    // (the store's task actions operate on any task-like item).
    if (item.type !== 'habit') {
      const found = usePlannerStore.getState().items.find((i) => i.id === item.id);
      const live = found && found.type !== 'habit' ? found : item;

      const updates = taskUpdatesFromDraft(d, keys);
      if (Object.keys(updates).length > 0) updateTask(item.id, updates);

      // Scheduling is a second pass through scheduleTask/unscheduleTask — they
      // own isScheduled and the project-block/previous-slot clears — and only
      // runs when something schedule-shaped actually moved.
      if (wants('startDate', 'timeBucket', 'startTime')) {
        const effectiveTimeBucket = d.startDate
          ? d.timeBucket === 'none'
            ? 'anytime'
            : d.timeBucket
          : undefined;
        if (d.startDate && effectiveTimeBucket) {
          if (effectiveTimeBucket !== live.timeBucket || !live.isScheduled) {
            scheduleTask(item.id, effectiveTimeBucket, startTime);
            // `''` is the draft's sentinel for "no specific time"; the store says
            // `undefined`. Comparing them raw made this branch fire on every
            // save for every bucket-only task.
          } else if (startTime !== live.startTime) {
            updateTask(item.id, { startTime });
          }
        } else if (!d.startDate && live.isScheduled) {
          unscheduleTask(item.id);
        }
      }
    } else {
      const found = usePlannerStore.getState().items.find((i) => i.id === item.id);
      const live = found && found.type === 'habit' ? found : item;

      const updates = habitUpdatesFromDraft(d, keys);
      if (Object.keys(updates).length > 0) updateHabit(item.id, updates);

      // Same second pass, and the same reason for the equality guard the task
      // branch has always had: scheduleHabit writes unconditionally.
      if (wants('timeBucket', 'startTime')) {
        if (d.timeBucket !== 'none') {
          if (d.timeBucket !== live.timeBucket || startTime !== live.startTime) {
            scheduleHabit(item.id, d.timeBucket, startTime);
          }
        } else if (live.timeBucket !== undefined) {
          updateHabit(item.id, { timeBucket: undefined, startTime: undefined });
        }
      }
    }
  };

  const handleEditSave = () => {
    if (!state || state.mode !== 'edit') return;
    if (!editItem || !editDraft || !editDraft.title.trim()) return;
    // In the panel this button is "Done", not "Save": everything is already
    // written or queued, so flush what's outstanding and leave. Committing
    // unconditionally here would re-send a payload the timer already sent —
    // a second round trip, a second webhook, a second activity row.
    if (autosaves) {
      flushNow();
      onOpenChange(false);
      return;
    }
    commitEdit(editItem, editDraft, DRAFT_KEYS);
    onOpenChange(false);
  };

  const handleSubmit = () => {
    if (mode === 'add') handleAddSave(activeType);
    else handleEditSave();
  };

  const handleDeleteConfirm = () => {
    if (!state || state.mode !== 'edit' || !editItem) return;
    if (editItem.type === 'habit') deleteHabit(editItem.id);
    else deleteTask(editItem.id);
    setShowDeleteConfirm(false);
    onOpenChange(false);
  };

  /**
   * Switch the item's type. Whatever the surface is holding goes first — the
   * panel's queued autosave, or the modal's unsaved draft — so the switch
   * carries it rather than dropping it, and the form then re-seeds from the
   * item in its new shape (the draft's repeat and container were the old
   * type's). A switch that costs nothing happens at once; anything else waits
   * on the confirm.
   */
  const applyTypeChange = (toType: string, repeat?: ConvertRepeat) => {
    if (!state || state.mode !== 'edit' || !editItem) return;
    if (autosaves) flushNow();
    else if (editDraft && editDraft.title.trim()) commitEdit(editItem, editDraft, DRAFT_KEYS);
    changeItemType(editItem.id, toType, { repeat });
    setPendingType(null);
    setSeededId(null);
  };

  const requestTypeChange = (toType: string) => {
    if (!editItem) return;
    const summary = summarizeConversion(editItem, toType);
    if (summary.drops.length === 0 && summary.changes.length === 0 && !summary.needsRepeat) {
      applyTypeChange(toType);
      return;
    }
    setConvertRepeat('daily');
    setPendingType(toType);
  };

  const pendingConfig = pendingType ? getItemTypeConfig(pendingType) : null;
  const pendingSummary = pendingType && editItem ? summarizeConversion(editItem, pendingType) : null;
  const handleConfirmTypeChange = () => {
    if (!pendingType) return;
    applyTypeChange(pendingType, pendingSummary?.needsRepeat ? convertRepeat : undefined);
  };

  const handleResetStreak = () => {
    if (!state || state.mode !== 'edit' || !editItem) return;
    resetHabitStreak(editItem.id);
    setShowResetConfirm(false);
  };

  /**
   * Pause / resume — a direct store call, deliberately NOT a draft property.
   *
   * Routing it through ItemDraft/DRAFT_KEYS would make pausing a whole-item
   * save, which is exactly what the panel's scoped-write rule forbids: it would
   * stamp every other field back over whatever a drag, a resize, an undo or an
   * agent wrote since the panel opened. Delete and Reset streak are direct
   * calls for the same reason.
   */
  const handleSetPaused = (paused: boolean, until?: string) => {
    if (!state || state.mode !== 'edit' || !editItem) return;
    setItemPaused(editItem.id, paused, until);
    setShowPauseUntil(false);
  };

  /**
   * Priority — the one chip that is neither a time nor a container, so it rides
   * the identity row beside the type instead of standing alone in a band of its
   * own. A band would have cost a whole labelled row to say "Priority" twice:
   * once in the label, once in the chip's own unset state.
   */
  const renderPriorityChip = (type: string, d: ItemDraft) => {
    const config = getItemTypeConfig(type);
    const patch = (updates: Partial<ItemDraft>) => patchDraft(type, updates);
    return config.fields.includes('priority') ? (
      <PropertyChip
        icon={Flag}
        label="Priority"
        defaultOpen={autoOpenProp === 'priority'}
        value={d.priority === 'none' ? undefined : PRIORITY_LABELS[d.priority]}
        swatch={d.priority === 'none' ? undefined : `var(--priority-${d.priority})`}
        contentClassName="w-48"
      >
        {(close) =>
          PRIORITY_ORDER.map((p) => (
            <ChipOption
              key={p}
              selected={d.priority === p}
              onSelect={() => {
                // Picking "None" EMPTIES the property, and the field hides what
                // is unset — so without this the chip you just used folds back
                // into the seed. See `clearProp` in renderChips.
                if (p === 'none') revealProp('priority');
                patch({ priority: p });
                close();
              }}
            >
              <span
                className={cn('size-2 shrink-0 rounded-full', p === 'none' && 'opacity-50')}
                style={{
                  background:
                    p === 'none' ? 'var(--muted-foreground)' : `var(--priority-${p})`,
                }}
              />
              {PRIORITY_LABELS[p]}
              {d.priority === p && <Check className="ml-auto size-3.5" />}
            </ChipOption>
          ))
        }
      </PropertyChip>
    ) : null;
  };
  // ── Registry-driven properties ────────────────────────────────────────────

  /**
   * Every optional property of an item, as ONE label-less field.
   *
   * Which chips exist has always been the type's capability config — a new
   * custom type gets a correct dialog with no work here. The LAYOUT was not a
   * capability question, and went through two answers before this one. Ten chips
   * in one flat source-order row (Project beside Routine beside Goal, the three
   * container roles reaching the user as no distinction at all), then a stack of
   * labelled BANDS that fixed the ordering and paid for it in empty rows, then
   * this: the bands' derivation kept, their labels dropped, and everything unset
   * folded behind one "+ Add property" seed. See the field below.
   *
   * Two consequences worth stating, because both reverse an earlier rule:
   *
   *  · An unset chip carries the NOUN again ("Routine"), not the verb ("Add").
   *    Under the bands the label two inches left was the noun and the chip was
   *    free to be a verb; with no label beside it, "Add" would be a nameless
   *    control. The ACCESSIBLE name was the noun throughout and still is.
   *  · Priority is back among the properties rather than riding the identity
   *    line. A band of its own would have said "Priority" twice; the field says
   *    it once, and only when it applies.
   */
  const renderChips = (type: string, d: ItemDraft) => {
    const config = getItemTypeConfig(type);
    const patch = (updates: Partial<ItemDraft>) => patchDraft(type, updates);
    /**
     * Emptying a property from inside its own popover, WITHOUT the chip
     * vanishing from under the pointer.
     *
     * `shows` keeps a property while it is set, required, or revealed — so a
     * cleared value fails all three and folds straight back into the seed,
     * taking the control you are mid-edit on with it and costing two clicks to
     * reach again. (Clearing a task's date takes the Time chip too, since
     * `showTime` is a capability question — that part is correct and stays.)
     *
     * Clearing is a deliberate act on a property you are actively using, which
     * is the same thing summoning one from the seed means, so it writes the same
     * `revealed` set: the chip stays put, empty, for the rest of this item's
     * session. Only the "no value" options route through here; an ordinary pick
     * is a plain `patch` and shows because it is set.
     */
    const clearProp = (key: string, updates: Partial<ItemDraft>) => {
      revealProp(key);
      patch(updates);
    };
    // ONE list and ONE colour resolver since 039 — the two-way pick here was
    // the last place the dialog had to know which classify kind a type used.
    const containers = projects;
    // The same color the rows' TagDot and the schedule rail resolve for this
    // container — the dialog joins that vocabulary instead of the gray icon.
    const containerColor = getProjectColor;

    const toggleDay = (day: number) => {
      patch({
        repeatDays: d.repeatDays.includes(day)
          ? d.repeatDays.filter((x) => x !== day)
          : [...d.repeatDays, day].sort(),
      });
    };

    // ── routine membership ────────────────────────────────────────────────
    // Edit reads the live join (so a change made in the manager shows here
    // immediately); add reads the draft, which the create payload carries.
    const editingItem = editItem;
    const memberRoutines = editingItem
      ? routines.filter((r) => r.itemIds.includes(editingItem.id))
      : routines.filter((r) => d.routineIds.includes(r.id));
    const memberIds = memberRoutines.map((r) => r.id);
    const routineChipValue = membershipSummary(memberRoutines.map((r) => r.name));
    // A subtask can't join a routine (the registry's rule), and in add mode
    // there is no item yet — the type's capability is the whole answer.
    const collectible = editingItem
      ? isCollectible(editingItem)
      : getItemTypeConfig(type).collectible;

    // Same shape, same reason. See the Remind chip below.
    const remindable = editingItem ? isRemindable(editingItem) : config.remindable;
    // A cue can only fire on a day the item OCCURS on, and a date-anchored type
    // with no date occurs on none — so the control has to say so rather than
    // accept a time that will never fire. Habits are un-anchored and never hit
    // this; an undated braindump task always does.
    const reminderNeedsDate = config.dateAnchored && !d.startDate;

    const toggleRoutine = (routineId: string, on: boolean) => {
      if (!editingItem) {
        patch({
          routineIds: on
            ? [...d.routineIds, routineId]
            : d.routineIds.filter((x) => x !== routineId),
        });
        return;
      }
      // LIVE state, not the render-closure `routines`: inline create (C2) makes
      // a routine and toggles it on in the SAME handler, so the just-created row
      // is in the store but not yet in this render's array — the closure lookup
      // would miss it and silently skip the attach.
      const routine = usePlannerStore.getState().routines.find((r) => r.id === routineId);
      if (!routine) return;
      updateRoutine(routineId, {
        itemIds: on
          ? [...routine.itemIds, editingItem.id]
          : routine.itemIds.filter((x) => x !== editingItem.id),
      });
    };

    // ── goal membership ───────────────────────────────────────────────────
    const activeGoals = goals.filter((g) => g.state === 'active');
    // Plain members only. A goal's chip adds the item to the goal; it never
    // grants a milestone or check-in role, which are the goal's own decision
    // and are made where its timeline is visible.
    const memberGoals = editingItem
      ? goals.filter((g) => g.state === 'active' && goalItemIds(g).includes(editingItem.id))
      : goals.filter((g) => d.goalIds.includes(g.id));
    const memberGoalIds = memberGoals.map((g) => g.id);
    // The goals this item served that have since ended. Shown under their own
    // divider rather than dropped: a still-scheduled milestone of a set-aside
    // goal is otherwise a row with no explanation anywhere in the app.
    const endedGoals = editingItem
      ? goals.filter((g) => g.state !== 'active' && goalItemIds(g).includes(editingItem.id))
      : [];
    /**
     * An item can serve ONLY goals that have since ended, and that is precisely
     * the case the Ended divider exists for. The field shows what is SET, so a
     * value read from the ACTIVE list alone would be empty here — the chip would
     * fold into the seed and take the only explanation for a still-scheduled
     * milestone with it, which is the sentence above describing its own defeat.
     *
     * So it falls back to the ended names — and MARKS them. An ended membership
     * rendered as a bare name is indistinguishable from a live one, which trades
     * a missing explanation for a wrong one. "(ended)" is the popover's own word
     * for that divider, so the chip and the menu it opens agree.
     *
     * Only the fallback is marked: once ANY active goal exists the chip is a
     * live membership and says so plainly, with the ended ones still listed
     * under the divider inside.
     */
    const goalChipValue =
      membershipSummary(memberGoals.map((g) => g.name)) ??
      (endedGoals.length > 0
        ? `${membershipSummary(endedGoals.map((g) => g.name))} (ended)`
        : undefined);

    const toggleGoal = (goalId: string, on: boolean) => {
      if (!editingItem) {
        patch({
          goalIds: on ? [...d.goalIds, goalId] : d.goalIds.filter((x) => x !== goalId),
        });
        return;
      }
      // LIVE state, not the render-closure `goals`: inline create (C2) makes a
      // goal and toggles it on in the same handler — see toggleRoutine.
      const goal = usePlannerStore.getState().goals.find((g) => g.id === goalId);
      if (!goal) return;
      // All three arrays travel, always. Removing has to clear whichever role
      // the item actually held — untick a milestone through this chip and it
      // must leave the goal, not quietly demote to a member nobody can see.
      const without = (ids: string[]) => ids.filter((x) => x !== editingItem.id);
      updateGoal(goalId, {
        memberIds: on ? [...goal.memberIds, editingItem.id] : without(goal.memberIds),
        milestoneIds: on ? goal.milestoneIds : without(goal.milestoneIds),
        checkinIds: on ? goal.checkinIds : without(goal.checkinIds),
      });
    };

    // ── program membership ────────────────────────────────────────────────
    // Only DIRECT membership, deliberately. An item can also be inside a
    // program through a routine, but this chip both reads and WRITES, and
    // unticking an indirect program here could only mean "pull the routine
    // out", which would silently rescope every other member of that routine.
    // The manager is where a routine's programs are edited.
    const memberPrograms = editingItem
      ? programs.filter((p) => p.itemIds.includes(editingItem.id))
      : programs.filter((p) => d.programIds.includes(p.id));
    const memberProgramIds = memberPrograms.map((p) => p.id);
    const programChipValue = membershipSummary(memberPrograms.map((p) => p.name));

    const toggleProgram = (programId: string, on: boolean) => {
      if (!editingItem) {
        patch({
          programIds: on
            ? [...d.programIds, programId]
            : d.programIds.filter((x) => x !== programId),
        });
        return;
      }
      // LIVE state, not the render-closure `programs`: inline create (C2) makes
      // a program and toggles it on in the same handler — see toggleRoutine.
      const program = usePlannerStore.getState().programs.find((p) => p.id === programId);
      if (!program) return;
      updateProgram(programId, {
        itemIds: on
          ? [...program.itemIds, editingItem.id]
          : program.itemIds.filter((x) => x !== editingItem.id),
      });
    };

    /**
     * Returns false when the name was refused, so the caller keeps the popover
     * open — a field that clears and closes on a create that did not happen is
     * how this bug stayed invisible.
     *
     * The bin is consulted here for the MESSAGE. `addProject` now rolls a
     * refused create back on its own, so the item is never lost either way; but
     * the rollback arrives a round trip later as a toast, and a container you
     * watched appear and then vanish is a worse answer than one that was never
     * accepted. See use-trashed-names.ts for why the store cannot check this
     * itself: the lookup is async and the action is not.
     */
    const createContainer = (): boolean => {
      const name = d.newContainer.name.trim();
      if (!name) return false;
      const held = heldByTrash(
        trashedNames.projects,
        name,
        CONTAINER_KINDS.project.label.toLowerCase(),
      );
      if (held) {
        toast.error(held);
        return false;
      }
      addProject(name, d.newContainer.icon);
      patch({
        container: name,
        newContainer: {
          show: false,
          name: '',
          icon: makeIconToken(config.form.newContainerIcon),
        },
      });
      return true;
    };

    // A dated item with no bucket still lands somewhere — 'anytime' — which is
    // what the save adapters write. The chip says so rather than reading unset.
    const effectiveBucket: TimeBucket | 'none' =
      config.dateAnchored && d.startDate && d.timeBucket === 'none' ? 'anytime' : d.timeBucket;
    const showTime = !config.dateAnchored || !!d.startDate;
    // Purely a capability question now. The `config.dateAnchored &&` this used to
    // carry was doing two jobs: keeping duration behind a date for tasks — which
    // `showTime` already does, since the chip this lives inside doesn't render
    // without one — and hiding it from habits, which had no `duration` field to
    // show. They do now, and an un-anchored type reaches its duration through the
    // chip that is always open to it.
    const hasDuration = config.fields.includes('duration');
    const timeParts = [
      effectiveBucket === 'none' ? null : BUCKET_LABELS[effectiveBucket],
      effectiveBucket !== 'none' && effectiveBucket !== 'anytime' && d.startTime
        ? d.startTime
        : null,
      hasDuration ? DURATION_LABELS[d.duration] ?? `${d.duration} min` : null,
    ].filter(Boolean);

    const repeatValue = () => {
      if (d.repeatFrequency === 'none') return undefined;
      if (d.repeatFrequency === 'custom') {
        return d.repeatDays.length > 0
          ? d.repeatDays.map((i) => WEEKDAY_LABELS[i]).join(' ')
          : REPEAT_FREQUENCY_LABELS.custom;
      }
      if (d.repeatFrequency === 'monthly') return `Day ${d.repeatMonthDay}`;
      return REPEAT_FREQUENCY_LABELS[d.repeatFrequency];
    };

    const containerControl = (
      <PropertyChip
        icon={Plus}
        swatch={d.container === 'none' ? undefined : containerColor(d.container)}
        swatchShape="square"
        // No band label carries the noun any more, so the chip carries it
        // itself: an unset (revealed or required) container reads as its kind
        // rather than as a nameless "Add". The accessible name says the same
        // whether or not a value is set.
        label={config.form.containerLabel}
        ariaLabel={
          d.container === 'none'
            ? config.form.containerLabel
            : `${config.form.containerLabel}: ${d.container}`
        }
        testId="item-dialog-container-chip"
        defaultOpen={autoOpenProp === 'project'}
        value={d.container === 'none' ? undefined : d.container}
        // NO `capitalize`. The habit-group side of the axis carried it,
        // because `makeAddDraft`'s fallback writes a lowercase 'personal';
        // one kind means one rule, and applying it to every container is
        // the worse half — Tailwind's `capitalize` upper-cases EVERY word,
        // so a project called "e2e tests" renders as "E2e Tests". A stray
        // lowercase name reading as typed is only untidy.
        contentClassName="w-64"
      >
        {(close) =>
          d.newContainer.show ? (
            <div className="flex gap-1 p-1">
              <IconPicker
                value={d.newContainer.icon}
                name={d.newContainer.name}
                onSelect={(icon) => patch({ newContainer: { ...d.newContainer, icon } })}
              />
              <Input
                autoFocus
                placeholder="Name"
                value={d.newContainer.name}
                onChange={(e) =>
                  patch({ newContainer: { ...d.newContainer, name: e.target.value } })
                }
                className="h-9 flex-1 text-sm"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  // Closing only on acceptance: a refused name has to stay
                  // on screen next to the message explaining it.
                  if (createContainer()) close();
                }}
                data-sub-input
              />
              <AddIconButton
                size="input"
                onClick={() => {
                  if (createContainer()) close();
                }}
                aria-label={`Add ${config.form.containerLabel.toLowerCase()}`}
              />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto" data-chip-scroll>
              {!config.containerRequired && (
                <ChipOption
                  selected={d.container === 'none'}
                  onSelect={() => {
                    clearProp('project', { container: 'none' });
                    close();
                  }}
                  tone="muted"
                >
                  No {config.form.containerLabel.toLowerCase()}
                </ChipOption>
              )}
              {containers.map((c) => (
                <ChipOption
                  key={c.name}
                  selected={d.container === c.name}
                  onSelect={() => {
                    patch({ container: c.name });
                    close();
                  }}
                >
                  <ColorSquare color={containerColor(c.name)} />
                  <span className="truncate">{c.name}</span>
                  {d.container === c.name && <Check className="ml-auto size-3.5 shrink-0" />}
                </ChipOption>
              ))}
              <ChipOption
                tone="primary"
                onSelect={() => patch({ newContainer: { ...d.newContainer, show: true } })}
              >
                <Plus className="size-3.5" />
                {config.form.newContainerLabel}
              </ChipOption>
            </div>
          )
        }
      </PropertyChip>
    );

    /* Routine membership. Multi-valued, so this is check-rows rather than
       the single-select the container chip uses — joining a second routine
       is an additional reason to appear, never a replacement.

       Two write paths on purpose. In ADD mode the ids sit on the draft and
       ride the create as a `memberships` payload, so one gesture is one
       history entry. In EDIT mode they write LIVE through updateRoutine,
       because membership is a join row rather than a column on the item,
       and the panel's scoped-write draft machinery only tracks columns —
       routing it through there would either drop the write or widen the
       panel's write surface, and that invariant is load-bearing. */
    const routineControl = (
      <PropertyChip
        icon={Plus}
        // No band label carries the noun any more, so the chip carries it
        // itself — an unset membership reads as its kind, not as a nameless
        // "Add" — and the accessible name says the same either way.
        label={CONTAINER_KINDS.routine.label}
        defaultOpen={autoOpenProp === 'routine'}
        ariaLabel={
          routineChipValue
            ? `${CONTAINER_KINDS.routine.label}: ${routineChipValue}`
            : CONTAINER_KINDS.routine.label
        }
        value={routineChipValue}
        // The same resolver the option rows below use. Reading `color` raw left
        // an un-coloured routine with no swatch at all, which handed the chip
        // back to its icon — and the icon is now the "add" plus.
        swatch={
          memberRoutines[0]
            ? memberRoutines[0].color ?? accentColorForName(memberRoutines[0].name)
            : undefined
        }
        swatchShape="square"
        contentClassName="w-56"
        testId="item-dialog-routine-chip"
      >
        {(close) => (
          <div className="max-h-64 overflow-y-auto" data-chip-scroll>
            {routines.map((routine) => {
              const on = memberIds.includes(routine.id);
              return (
                <ChipOption
                  key={routine.id}
                  selected={on}
                  onSelect={() => toggleRoutine(routine.id, !on)}
                  testId="item-dialog-routine-option"
                  value={routine.id}
                >
                  <ColorSquare color={routine.color ?? accentColorForName(routine.name)} />
                  <span className="truncate">{routine.name}</span>
                  {on && <Check className="ml-auto size-3.5 shrink-0" />}
                </ChipOption>
              );
            })}
            {/* Make one without leaving the dialog (C2). No trashed-name guard
                like the project chip's: routines carry no unique name, so there
                is no bin slot to collide with. */}
            {CONTAINER_KINDS.routine.newLabel && (
              <InlineCreate
                label={CONTAINER_KINDS.routine.newLabel}
                defaultIcon={makeIconToken('Repeat')}
                testId="item-dialog-routine-new"
                onCreate={(name, icon) =>
                  toggleRoutine(addRoutine({ name, icon, itemIds: [] }), true)
                }
              />
            )}
            {/* The manager's home. It is NOT in the braindump header —
                that row is width-critical at the 280px minimum — so the
                routes in are here, the palette, and mobile's sheet.

                Gone entirely while the Organize console is off, rather than
                disabled: this is a door, and a door that cannot open is not
                worth the row it costs inside a 264px popover. The console's
                catalogue row, its settings pane and its (greyed) palette
                commands are where it stays findable. */}
            {organizeOn && (
              <ChipOption
                tone="muted"
                onSelect={() => {
                  close();
                  // Replaces this dialog rather than stacking on it —
                  // openDialog swaps the single active slot. Same escape the
                  // type chip's "Organize types…" row makes. And on a route
                  // with no console mounted it goes where the console is,
                  // instead of arming a slot nothing reads (console-door.ts).
                  openConsole({ section: 'routines' });
                }}
                testId="item-dialog-routine-manage"
              >
                <Plus className="size-3.5" />
                Organize routines…
              </ChipOption>
            )}
          </div>
        )}
      </PropertyChip>
    );

    /* Programs get their own chip rather than sharing the routine one.
       They are different questions — "which routine is this part of" vs
       "which stretch of life does this belong to" — and a merged picker
       would have to invent a grouping the user never asked for.

       Both chips name GATES, so ticking either can switch the item off on
       the very date it belongs to. Nothing here announces that, and only
       ADD mode has an answer elsewhere: the store's landing receipt on the
       undo toast — `newMemberReceipt` in lib/planner-store.ts, resolved at
       the item's own start date, in the same words the bulk "Add to …"
       verb uses for the identical write. That is the mode that behaves
       correctly.

       EDIT mode does not, and it is an open follow-up rather than
       something this chip should paper over. Its write goes through
       `updateProgram`, whose label is `Edit program:` with no receipt and
       no SIGNIFICANT_ACTIONS match, so the toast never fires; and the
       activation note above resolves at TODAY (decision 3 — pausing is
       dateless), not at the item's date. So ticking a program whose window
       excludes an item's future date, while today sits inside that window,
       is silent here and spoken in add mode. The fix is the note taking the
       item's date, not a warning in this popover. */
    const programControl = (
      <PropertyChip
        icon={Plus}
        // No band label carries the noun any more, so the chip carries it
        // itself — an unset membership reads as its kind, not as a nameless
        // "Add" — and the accessible name says the same either way.
        label={CONTAINER_KINDS.program.label}
        defaultOpen={autoOpenProp === 'program'}
        ariaLabel={
          programChipValue
            ? `${CONTAINER_KINDS.program.label}: ${programChipValue}`
            : CONTAINER_KINDS.program.label
        }
        value={programChipValue}
        swatch={
          memberPrograms[0]
            ? memberPrograms[0].color ?? accentColorForName(memberPrograms[0].name)
            : undefined
        }
        swatchShape="square"
        contentClassName="w-56"
        testId="item-dialog-program-chip"
      >
        {(close) => (
          <div className="max-h-64 overflow-y-auto" data-chip-scroll>
            {programs.map((program) => {
              const on = memberProgramIds.includes(program.id);
              return (
                <ChipOption
                  key={program.id}
                  selected={on}
                  onSelect={() => toggleProgram(program.id, !on)}
                  testId="item-dialog-program-option"
                  value={program.id}
                >
                  <ColorSquare color={program.color ?? accentColorForName(program.name)} />
                  <span className="truncate">{program.name}</span>
                  {on && <Check className="ml-auto size-3.5 shrink-0" />}
                </ChipOption>
              );
            })}
            {/* Make one without leaving the dialog (C2). New programs are
                'auto' with no dates, exactly as the console's create row makes
                them — a program you just made must not hide anything. */}
            {CONTAINER_KINDS.program.newLabel && (
              <InlineCreate
                label={CONTAINER_KINDS.program.newLabel}
                defaultIcon={makeIconToken('CalendarRange')}
                testId="item-dialog-program-new"
                onCreate={(name, icon) =>
                  toggleProgram(
                    addProgram({ name, icon, state: 'auto', itemIds: [], routineIds: [] }),
                    true
                  )
                }
              />
            )}
            {/* A door, gone while the console is off — see the routine
                chip's row above for the whole argument. */}
            {organizeOn && (
              <ChipOption
                tone="muted"
                onSelect={() => {
                  close();
                  openConsole({ section: 'programs' });
                }}
                testId="item-dialog-program-manage"
              >
                <Plus className="size-3.5" />
                Organize programs…
              </ChipOption>
            )}
          </div>
        )}
      </PropertyChip>
    );

    /* GOALS — and note the gate: `goalsAvailable && collectible`, with NO
       `goals.length > 0`.

       The two chips above carry that extra condition and it is the
       programs feature's own recorded failure: with zero containers the
       chip vanishes, and the chip's popover is one of the few doors to the
       manager — so the surface that would let you make your first one is
       hidden until you already have one. On mobile there is no palette and
       no omnibar, which leaves the braindump's folder button as the only
       other route. A goal is the container a user is most likely to want
       before they own any, so its chip renders from zero and its popover
       leads with the door. */
    const goalControl = (
      <PropertyChip
        icon={Plus}
        // No band label carries the noun any more, so the chip carries it
        // itself — an unset membership reads as its kind, not as a nameless
        // "Add" — and the accessible name says the same either way.
        label={CONTAINER_KINDS.goal.label}
        defaultOpen={autoOpenProp === 'goal'}
        ariaLabel={
          goalChipValue
            ? `${CONTAINER_KINDS.goal.label}: ${goalChipValue}`
            : CONTAINER_KINDS.goal.label
        }
        value={goalChipValue}
        swatch={
          memberGoals[0]
            ? memberGoals[0].color ?? accentColorForName(memberGoals[0].name)
            : undefined
        }
        swatchShape="square"
        contentClassName="w-64"
        testId="item-dialog-goal-chip"
      >
        {(close) => (
          <div className="max-h-64 overflow-y-auto" data-chip-scroll>
            {activeGoals.map((goal) => {
              const on = memberGoalIds.includes(goal.id);
              const next = nextMilestone(goal, itemsById);
              return (
                <ChipOption
                  key={goal.id}
                  selected={on}
                  onSelect={() => toggleGoal(goal.id, !on)}
                  testId="item-dialog-goal-option"
                  value={goal.id}
                >
                  <ColorSquare color={goal.color ?? accentColorForName(goal.name)} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{goal.name}</span>
                    {/* The one ambient piece of forward pressure a dated
                        milestone gets. Between creation and its target day
                        it renders on no surface the user passes, so the
                        first unprompted encounter would otherwise be the
                        waiting tray, after it has already been missed. */}
                    {next && (
                      <span className="text-muted-foreground truncate text-[11px]">
                        next: {next.title}
                        {'startDate' in next && next.startDate
                          ? ` · ${formatShort(next.startDate)}`
                          : ''}
                      </span>
                    )}
                  </span>
                  {on && <Check className="ml-auto size-3.5 shrink-0" />}
                </ChipOption>
              );
            })}

            {endedGoals.length > 0 && (
              <>
                <div className="text-muted-foreground px-2 pt-2 pb-1 text-[10px] font-medium tracking-wide">
                  ENDED
                </div>
                {endedGoals.map((goal) => (
                  <ChipOption
                    key={goal.id}
                    selected
                    onSelect={() => toggleGoal(goal.id, false)}
                    testId="item-dialog-goal-ended-option"
                    value={goal.id}
                  >
                    <ColorSquare color={goal.color ?? accentColorForName(goal.name)} />
                    <span className="text-muted-foreground truncate">{goal.name}</span>
                    <Check className="ml-auto size-3.5 shrink-0" />
                  </ChipOption>
                ))}
              </>
            )}

            {/* Make one without leaving the dialog (C2). This is the "new habit,
                new goal" gesture: the goal is created active and empty and the
                item joins it as a plain MEMBER — milestone and check-in roles
                are the goal's own decision, made where its timeline shows, and
                the door below is the way to that. */}
            {CONTAINER_KINDS.goal.newLabel && (
              <InlineCreate
                label={CONTAINER_KINDS.goal.newLabel}
                defaultIcon={makeIconToken('Target')}
                testId="item-dialog-goal-new"
                onCreate={(name, icon) =>
                  toggleGoal(
                    addGoal({
                      name,
                      icon,
                      state: 'active',
                      memberIds: [],
                      milestoneIds: [],
                      checkinIds: [],
                    }),
                    true
                  )
                }
              />
            )}
            {/* The Goals section of the console rides EXT_GOALS, not
                EXT_ORGANIZE (lib/extension-gates.ts), so this door stays
                open with the console switched off — otherwise Goals would
                be an extension you can switch on and then never use. */}
            <ChipOption
              tone="muted"
              onSelect={() => {
                close();
                openConsole({ section: 'goals' });
              }}
              testId="item-dialog-goal-manage"
            >
              <Plus className="size-3.5" />
              {activeGoals.length === 0 ? 'Set up a goal…' : 'Organize goals…'}
            </ChipOption>
          </div>
        )}
      </PropertyChip>
    );

    const dateChip = config.dateAnchored && (
      <PropertyChip
        icon={CalendarIcon}
        label="Date"
        defaultOpen={autoOpenProp === 'date'}
        testId="item-dialog-date-chip"
        value={d.startDate ? format(d.startDate, 'MMM d') : undefined}
        contentClassName="w-auto p-0"
      >
        {(close) => (
          <div>
            <div className="p-1">
              {DATE_SHORTCUTS.map(({ label, days }) => {
                const date = addDays(startOfDay(new Date()), days);
                return (
                  <ChipOption
                    key={label}
                    testId="item-dialog-date-shortcut"
                    value={label.toLowerCase().replace(/\s+/g, '-')}
                    onSelect={() => {
                      patch({ startDate: date });
                      close();
                    }}
                  >
                    {label}
                    <span className="text-muted-foreground ml-auto text-xs">
                      {format(date, 'MMM d')}
                    </span>
                  </ChipOption>
                );
              })}
            </div>
            <div className="border-t">
              <Calendar
                mode="single"
                selected={d.startDate}
                onSelect={(date) => {
                  patch({ startDate: date });
                  close();
                }}
                initialFocus
              />
            </div>
            {d.startDate && (
              <div className="border-t p-1">
                <ChipOption
                  tone="muted"
                  onSelect={() => {
                    clearProp('date', { startDate: undefined });
                    close();
                  }}
                >
                  <X className="size-3.5" />
                  No date
                </ChipOption>
              </div>
            )}
          </div>
        )}
      </PropertyChip>
    );

    const timeChip = showTime && (
      <PropertyChip
        icon={Clock}
        label="Time"
        defaultOpen={autoOpenProp === 'time'}
        value={timeParts.length > 0 ? timeParts.join(' · ') : undefined}
        contentClassName="w-56"
      >
        {(close) => (
          <>
            {mode === 'edit' && !config.dateAnchored && (
              <ChipOption
                tone="muted"
                selected={d.timeBucket === 'none'}
                onSelect={() => {
                  clearProp('time', { timeBucket: 'none', startTime: '' });
                  close();
                }}
              >
                No specific bucket
              </ChipOption>
            )}
            {BUCKET_ORDER.map((b) => (
              <ChipOption
                key={b}
                selected={effectiveBucket === b}
                onSelect={() => patch({ timeBucket: b })}
              >
                {BUCKET_LABELS[b]}
                {effectiveBucket === b && <Check className="ml-auto size-3.5" />}
              </ChipOption>
            ))}

            {effectiveBucket !== 'none' && effectiveBucket !== 'anytime' && (
              <>
                <ChipSectionLabel>Specific time</ChipSectionLabel>
                <div className="px-2 pb-2">
                  <Input
                    type="time"
                    value={d.startTime}
                    onChange={(e) => patch({ startTime: e.target.value })}
                    className="h-9 text-sm"
                    data-sub-input
                  />
                </div>
              </>
            )}

            {hasDuration && (
              <>
                <ChipSectionLabel>Duration</ChipSectionLabel>
                <div className="pb-1">
                  {DURATION_ORDER.map((value) => (
                    <ChipOption
                      key={value}
                      selected={d.duration === value}
                      onSelect={() => {
                        patch({ duration: value });
                        close();
                      }}
                    >
                      {DURATION_LABELS[value]}
                      {d.duration === value && <Check className="ml-auto size-3.5" />}
                    </ChipOption>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </PropertyChip>
    );

    const timesPerDayChip = config.counters.dailyCounts && (
      <PropertyChip
        icon={Repeat2}
        label="Times per day"
        value={`${d.timesPerDay}×`}
        contentClassName="w-40"
      >
        {(close) =>
          ['1', '2', '3', '4', '5'].map((n) => (
            <ChipOption
              key={n}
              selected={d.timesPerDay === n}
              onSelect={() => {
                patch({ timesPerDay: n });
                close();
              }}
            >
              {n}× a day
              {d.timesPerDay === n && <Check className="ml-auto size-3.5" />}
            </ChipOption>
          ))
        }
      </PropertyChip>
    );

    const repeatChip = config.allowedFrequencies.length > 1 && (
      <PropertyChip
        icon={Repeat}
        label="Repeat"
        defaultOpen={autoOpenProp === 'repeat'}
        value={repeatValue()}
        contentClassName="w-[19rem]"
      >
        {(close) => (
          <>
            {Object.entries(REPEAT_FREQUENCY_LABELS)
              .filter(([value]) =>
                (config.allowedFrequencies as readonly string[]).includes(value)
              )
              .map(([value, label]) => (
                <div key={value}>
                  <ChipOption
                    selected={d.repeatFrequency === value}
                    onSelect={() => {
                      // 'none' is this chip's clear — see `clearProp` above.
                      if (value === 'none') revealProp('repeat');
                      patch({
                        repeatFrequency: value as RepeatFrequency,
                        // Newly switching into Custom days with nothing
                        // chosen yet pre-selects today — but an item that
                        // already has custom days saved (or that the user
                        // already started picking) keeps them untouched.
                        ...(value === 'custom' && d.repeatDays.length === 0
                          ? {
                              repeatDays: [
                                currentDayOfWeek(
                                  userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
                                ),
                              ],
                            }
                          : null),
                      });
                      // The detail pickers live in this popover; only the
                      // frequencies that carry no detail dismiss it.
                      if (value !== 'custom' && value !== 'monthly') close();
                    }}
                  >
                    {label}
                    {d.repeatFrequency === value && <Check className="ml-auto size-3.5" />}
                  </ChipOption>

                  {value === 'custom' && d.repeatFrequency === 'custom' && (
                    <div className="px-2 pt-1 pb-2">
                      <div className="flex gap-1">
                        {WEEKDAY_LABELS.map((day, index) => (
                          <button
                            key={day}
                            type="button"
                            onClick={() => toggleDay(index)}
                            aria-pressed={d.repeatDays.includes(index)}
                            className={cn(
                              'size-9 rounded-md text-xs font-medium transition-all',
                              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                              d.repeatDays.includes(index)
                                ? 'bg-primary text-primary-foreground translate-y-px shadow-[var(--shadow-key-pressed)]'
                                : 'bg-secondary text-secondary-foreground shadow-[var(--shadow-key-rest)] hover-wash'
                            )}
                          >
                            {day}
                          </button>
                        ))}
                      </div>
                      {d.repeatDays.length === 0 && (
                        <p className="text-destructive mt-1.5 text-xs">
                          Select at least one day
                        </p>
                      )}
                    </div>
                  )}

                  {value === 'monthly' && d.repeatFrequency === 'monthly' && (
                    <div className="px-2 pt-1 pb-2">
                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                          <button
                            key={day}
                            type="button"
                            onClick={() => patch({ repeatMonthDay: day })}
                            className={cn(
                              'h-7 rounded-sm text-xs font-medium tabular-nums transition-colors',
                              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                              d.repeatMonthDay === day
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover-wash'
                            )}
                          >
                            {day}
                          </button>
                        ))}
                      </div>
                      <p className="text-muted-foreground mt-1.5 text-[10px]">
                        For months with fewer days, it will occur on the last day.
                      </p>
                    </div>
                  )}
                </div>
              ))}
          </>
        )}
      </PropertyChip>
    );

    /* Remind — the cue itself. Gated on the registry capability rather
       than on `type === 'habit'`, so a custom type that declares
       `remindable` gets the control without a branch here.
       In EDIT mode it asks isRemindable(item), which adds the subtask
       rule — the isCollectible pattern above, and for the same reason: a
       subtask surfaces only inside its parent, so the scan discards a
       reminder set on one and the control would have promised nothing. */
    const remindChip = remindable && (
      <PropertyChip
        icon={Bell}
        label="Remind"
        defaultOpen={autoOpenProp === 'remind'}
        value={d.reminderTime || undefined}
        contentClassName="w-[19rem]"
      >
        {(close) => (
          <>
            <ChipSectionLabel>Nudge me at</ChipSectionLabel>
            <div className="px-2 pb-2">
              <Input
                type="time"
                value={d.reminderTime}
                onChange={(e) => patch({ reminderTime: e.target.value })}
                className="h-9 text-sm"
                data-sub-input
              />
            </div>

            {d.reminderTime && reminderNeedsDate && (
              <p className="text-muted-foreground px-2 pb-2 text-[10px]">
                Give this a date and it will fire. Without one there is no day
                for the reminder to land on.
              </p>
            )}

            {d.reminderTime && (
              <>
                <ChipSectionLabel>Right after</ChipSectionLabel>
                <div className="px-2 pb-2">
                  <Input
                    value={d.reminderAnchor}
                    onChange={(e) => patch({ reminderAnchor: e.target.value })}
                    placeholder="I pour my coffee"
                    className="h-9 text-sm"
                    data-sub-input
                  />
                  {/* The one piece of copy in this dialog that is trying to
                      change what the user types. An event you already do is
                      a better cue than a clock, and this field is what the
                      notification actually says — so the hint has to appear
                      where the sentence is being written, not in a doc. */}
                  <p className="text-muted-foreground mt-1.5 text-[10px]">
                    Optional, and worth it. Something you already do beats a
                    time — it&apos;s what the reminder will say.
                  </p>
                </div>
                <ChipOption
                  tone="muted"
                  onSelect={() => {
                    clearProp('remind', { reminderTime: '', reminderAnchor: '' });
                    close();
                  }}
                >
                  No reminder
                </ChipOption>
              </>
            )}
          </>
        )}
      </PropertyChip>
    );

    /**
     * WHICH CONTAINERS THIS ITEM MAY JOIN, and in what order — still
     * lib/item-bands.ts's answer, and still not a list anyone writes here. It
     * iterates the container registry, orders by ROLE (what the item is about →
     * what can switch it off → what it is for) and labels by KIND, so the noun
     * on screen is `CONTAINER_KINDS[kind].label` and nothing in this file spells
     * 'Project'. A fifth kind arrives with no edit here.
     *
     * The module is named for the BANDS it used to lay out, and the ordering is
     * why it survives them: the field below wraps into one row and the seed menu
     * is a flat list, so role order is the only thing left deciding what the eye
     * meets first. What a kind's presence answers to is capability, never
     * content — with the one gate exception documented in
     * `visibleContainerBands` — which is exactly the question the seed asks of
     * an item that has joined nothing at all.
     */
    const bands = visibleContainerBands({
      classifyKind: classifyKindForItemType(config.containerKind),
      collectible,
      collectionsAvailable,
      goalsAvailable,
      goalsEnabled: goalsOn,
      organizeEnabled: organizeOn,
      counts: {
        project: containers.length,
        routine: routines.length,
        program: programs.length,
        goal: goals.length,
      },
    });
    /**
     * NOT `Partial`. container-registry.ts warns that widening `ContainerKind`
     * lights up almost nothing — there are no switches over it — so this record
     * is deliberately one of the few places that WILL fail to compile: a fifth
     * kind reaches the field from the registry for free, and an unlisted control
     * would put its noun in the seed menu with nothing behind it — a property
     * you can summon and then cannot set.
     */
    const bandControls: Record<ContainerKind, ReactNode> = {
      project: containerControl,
      routine: routineControl,
      program: programControl,
      goal: goalControl,
    };
    // ── The field: the SET properties, plus one seed for the rest ───────────
    //
    // ONE label-less wrapping row, on every surface. It shows only what the item
    // actually carries: a set property renders its value chip, an unset one is
    // absent, folded into the "+ Add property" seed at the tail. So the field's
    // height tracks what the item IS, not what its type COULD be, and there is
    // no column of nouns to read before the two values you came to change.
    //
    // This replaced a stack of labelled BANDS — one per container kind, plus
    // "When" — which rendered whether or not they held anything, on the rule
    // that the surface's shape should be what the item CAN be. That rule cost
    // most on the capture modal, where NOTHING is set yet and the whole ladder
    // was therefore empty: five rows of nouns between the title and the button.
    // The seed answers the same "what may I add here?" in one chip, and it
    // answers it by NAME, which an empty band's bare "+ Add" never did.
    // (The bands live on in components/planner/item-bands.tsx, where they are
    // still right: /item/[id]'s ContainerBandsReadout is a readout, not a form.)
    //
    // The exceptions to "hidden while unset": a property the user just summoned
    // from the seed (`revealed`), and a mandatory container (`required`, a
    // habit's project) — a required-but-empty field that vanished would be a
    // bug, not calm.

    const containerSet: Record<ContainerKind, boolean> = {
      project: d.container !== 'none',
      routine: memberRoutines.length > 0,
      program: memberPrograms.length > 0,
      // Ended counts. A membership that has outlived its goal is still the
      // reason this item is on the grid, so it holds the chip open — see
      // `goalChipValue`, which is what the chip then says.
      goal: memberGoals.length > 0 || endedGoals.length > 0,
    };

    interface ClearingProp {
      key: string;
      /** Scan order: priority leads, the When cluster follows, containers last. */
      group: 'lead' | 'when' | 'container';
      /** The noun, for the seed menu — the bands supplied it before. */
      label: string;
      /** Does the type expose this property at all? */
      can: boolean;
      /** Is it set? Set properties show at rest. */
      set: boolean;
      node: ReactNode;
      icon: LucideIcon;
      /** A mandatory container stays visible even while empty. */
      required?: boolean;
    }

    const props: ClearingProp[] = [
      {
        key: 'priority',
        group: 'lead',
        label: 'Priority',
        can: config.fields.includes('priority'),
        set: d.priority !== 'none',
        node: renderPriorityChip(type, d),
        icon: Flag,
      },
      { key: 'date', group: 'when', label: 'Date', can: !!dateChip, set: !!d.startDate, node: dateChip, icon: CalendarIcon },
      { key: 'time', group: 'when', label: 'Time', can: !!timeChip, set: timeParts.length > 0, node: timeChip, icon: Clock },
      {
        key: 'timesPerDay',
        group: 'when',
        label: 'Times per day',
        can: !!timesPerDayChip,
        // Always carries a value (defaults to 1×), so it is never in the seed.
        set: true,
        node: timesPerDayChip,
        icon: Repeat2,
      },
      { key: 'repeat', group: 'when', label: 'Repeat', can: !!repeatChip, set: d.repeatFrequency !== 'none', node: repeatChip, icon: Repeat },
      { key: 'remind', group: 'when', label: 'Remind', can: !!remindChip, set: !!d.reminderTime, node: remindChip, icon: Bell },
      ...bands.map(
        (band): ClearingProp => ({
          key: band.kind,
          group: 'container',
          label: band.label,
          can: true,
          set: containerSet[band.kind],
          node: bandControls[band.kind],
          icon: Plus,
          required: band.kind === 'project' && config.containerRequired,
        })
      ),
    ];

    const shows = (p: ClearingProp) => p.can && (p.set || p.required || revealed.has(p.key));
    const visible = props.filter(shows);
    const leadWhen = visible.filter((p) => p.group !== 'container');
    const containerVisible = visible.filter((p) => p.group === 'container');
    const seedItems = props.filter((p) => p.can && !p.set && !p.required && !revealed.has(p.key));

    return (
      <div className="flex flex-wrap items-center gap-1.5" data-testid="item-clearing-field">
        {leadWhen.map((p) => (
          <Fragment key={p.key}>{p.node}</Fragment>
        ))}
        {/* One hairline groups the When cluster off from the containers, so
            the two families stay legible even when the wrap scatters them. */}
        {leadWhen.length > 0 && containerVisible.length > 0 && (
          <span aria-hidden className="bg-border mx-0.5 inline-block h-3.5 w-px shrink-0" />
        )}
        {containerVisible.map((p) => (
          <Fragment key={p.key}>{p.node}</Fragment>
        ))}
        {seedItems.length > 0 && (
          <PropertyChip
            icon={Plus}
            // The noun-carrying "Add property" when the field is empty; a bare
            // "+" once anything is set, because the chips beside it are the
            // context the words would only repeat.
            label={visible.length > 0 ? '' : 'Add property'}
            ariaLabel="Add property"
            testId="item-clearing-seed"
            contentClassName="w-60"
            // Picking a property opens that property's own picker, which takes
            // focus as it mounts. Radix would then hand focus back to this
            // seed's trigger on close and strand the new picker unfocused, so
            // the return is skipped whenever focus already sits inside another
            // open popover. Escape still hands focus back to the seed.
            onCloseAutoFocus={(e) => {
              if (document.activeElement?.closest('[data-radix-popper-content-wrapper]')) {
                e.preventDefault();
              }
            }}
          >
            {(close) => (
              <div className="max-h-72 overflow-y-auto" data-chip-scroll>
                {seedItems.map((p) => (
                  <ChipOption
                    key={p.key}
                    testId="item-clearing-seed-option"
                    value={p.key}
                    onSelect={() => {
                      revealProp(p.key);
                      setAutoOpenProp(p.key);
                      close();
                    }}
                  >
                    <p.icon className="size-3.5 shrink-0" />
                    {p.label}
                  </ChipOption>
                ))}
              </div>
            )}
          </PropertyChip>
        )}
      </div>
    );
  };


  const invalidCustomDays = (d: ItemDraft | null) =>
    !!d && d.repeatFrequency === 'custom' && d.repeatDays.length === 0;

  // ── Autosave ───────────────────────────────────────────────────────────────
  // The panel has no moment of commitment: you click a row on the grid behind it
  // and expect the edit kept. So the surface saves itself, and Save becomes Done.

  // Latest-value ref, so effect cleanups and timers can flush without having to
  // list a new-every-render callback as a dependency (which would re-subscribe,
  // and re-flush, on every render). Assigned in an effect, not during render.
  useEffect(() => {
    flush.current = () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const p = pending.current;
      pending.current = null;
      if (p) commitEdit(p.item, p.draft, p.keys);
    };
  });

  /** Flush from a user gesture, where clearing the indicator is also correct. */
  const flushNow = () => {
    flush.current();
    setSaving(false);
  };

  /**
   * Queue the write for a draft change. Driven by the gesture that made the
   * change rather than by an effect watching the draft — an effect would have to
   * re-derive what changed, and would setState during render-sync.
   */
  const scheduleSave = (prev: ItemDraft, next: ItemDraft, updates: Partial<ItemDraft>) => {
    if (!editItem) return;
    const changed = Object.keys(updates).filter(
      (k) =>
        k !== 'newContainer' &&
        JSON.stringify(prev[k as keyof ItemDraft]) !== JSON.stringify(next[k as keyof ItemDraft])
    );
    // Re-picking the value already set, or just opening the new-project input,
    // is not a change worth a round trip and an activity row.
    if (changed.length === 0) return;
    // A titleless or half-specified item is a state you're passing through, not
    // a save. Whatever was already pending stays pending.
    if (!next.title.trim() || invalidCustomDays(next)) return;

    // Accumulate across the whole queued batch: pick a project, then type a
    // note, and one commit must carry both — but still only those two.
    const carried =
      pending.current && pending.current.item.id === editItem.id ? pending.current.keys : [];
    pending.current = {
      item: editItem,
      draft: next,
      keys: Array.from(new Set([...carried, ...changed])),
    };
    setSaving(true);

    // Every commit that changes anything pushes a deep clone of the WHOLE items
    // array onto a 50-deep undo stack (planner-store.ts, the subscribe() at the
    // bottom). Saving on each typing pause would spend a session's entire
    // history recording one sentence, evicting every real action — so typed
    // fields settle on blur, with a long backstop for the note you wander away
    // from mid-thought. Picked values land right away, because the row behind
    // the panel should reflect the chip you just clicked.
    const typedOnly = changed.every((k) => TYPED_KEYS.includes(k));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(
      () => {
        saveTimer.current = null;
        flush.current();
        setSaving(false);
      },
      typedOnly ? 4000 : 500
    );
  };

  // Retargeting to another item — or unmounting — commits what's pending for the
  // one being left. `pending` holds its own (item, draft), so the write still
  // lands on the right row after the panel has already moved on.
  useEffect(() => {
    if (!autosaves) return;
    return () => flush.current();
  }, [autosaves, editItem?.id]);

  useEffect(() => {
    if (!autosaves) return;
    const onHide = () => flush.current();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [autosaves]);

  // Deleting the open item — from the grid, another tab, or an agent — has to
  // close the panel. Nothing else would: the latch keeps painting the row that
  // no longer exists, while updateItemAction silently drops every write for a
  // missing id, so the footer would go on reporting saves that reach nothing.
  useEffect(() => {
    if (!autosaves || !latched) return;
    if (items.some((i) => i.id === latched.id)) return;
    pending.current = null;
    onOpenChange(false);
  }, [autosaves, latched, items, onOpenChange]);

  // ⌘\ (workspace.focusItemPanel) is the keyboard's way in. Token-bumped from
  // the ui-store, the same pattern the omnibar uses, so the command doesn't
  // need a handle on this component.
  const itemPanelFocusToken = useUIStore((s) => s.itemPanelFocusToken);
  useEffect(() => {
    if (!isPanel || !open || itemPanelFocusToken === 0) return;
    document.querySelector<HTMLElement>('[data-testid="item-dialog"]')?.focus();
  }, [isPanel, open, itemPanelFocusToken]);

  // Escape closes the panel. Radix owned this for the modal; a plain <aside>
  // has to say so itself.
  useEffect(() => {
    if (presentation !== 'panel' || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Radix renders every popover and menu inside this wrapper. While one is
      // up it owns Escape, and the panel must not close out from under it.
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      // Non-modal means focus usually lives OUTSIDE the panel, so a bare window
      // listener would make Escape-out-of-the-braindump close the inspector
      // too. Claim the key only from inside the panel, or when nothing else
      // holds focus.
      const active = document.activeElement;
      const inPanel = !!active?.closest('[data-testid="item-dialog"]');
      if (!inPanel && active && active !== document.body) return;
      flush.current();
      setSaving(false);
      onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presentation, open, onOpenChange]);

  /**
   * WHERE THE CURSOR GOES WHEN THE PANEL CLOSES.
   *
   * Radix's FocusScope used to return focus for the modal; the bare <aside>
   * (Phase 8) has nothing that does, so closing the panel dropped the cursor on
   * <body> and the next Tab restarted at the top of the document — several
   * hundred stops away from the row the user was working on. Logged in the
   * plan's "Open after Phase 8" list; this is that entry.
   *
   * Two rules, and both are about NOT stealing:
   *
   *  · Captured on the closed→open edge only. The panel RETARGETS to another
   *    item without ever closing (the ui-store dialog slot is the selection),
   *    so re-capturing on every payload change would remember the third row you
   *    clicked rather than where the session actually started.
   *  · Restored only when nothing else has claimed the cursor. By the time this
   *    runs the panel's subtree is gone and the browser has already parked focus
   *    on <body>; anything ELSE holding it means the user moved on themselves —
   *    clicked a braindump row, pressed a toolbar button — and pulling the
   *    cursor back off that is a worse bug than the one being fixed.
   *
   * `focus()` unqualified, matching ConfirmDialog: the opener is a row on the
   * canvas the panel was docked beside, so it is almost always still on screen,
   * and a focus ring the user cannot see is not a restoration.
   *
   * SAYS WHAT IT PINS: the edge rule is held by TWO things — this dependency
   * list (which does not re-run on a retarget) and the `!returnFocusTo.current`
   * guard — and neither is discriminable on its own, measured rather than
   * assumed: mutating either alone leaves tests/unit/item-bands.test.tsx green,
   * mutating both turns the retarget case red. Either mechanism suffices; both
   * are kept because the deps list is the kind of thing a later edit widens
   * without noticing, and then the guard is the only thing left. The `!== body`
   * half is defensive in the same way: focusing `<body>` is a no-op, so it costs
   * a property read to keep the handler's contract readable.
   */
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!isPanel) return;
    if (open) {
      const opener = document.activeElement as HTMLElement | null;
      if (!returnFocusTo.current && opener && opener !== document.body) {
        returnFocusTo.current = opener;
      }
      return;
    }
    const target = returnFocusTo.current;
    // Released either way, so a closed panel never pins a removed row in memory.
    returnFocusTo.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (!target?.isConnected) return;
    target.focus();
  }, [isPanel, open]);

  // One form renders at a time now: the active tab in add mode, the item's own
  // type in edit mode (the registry NAME, not the envelope discriminant).
  const activeTypeName = mode === 'add' ? activeType : editItem ? itemTypeName(editItem) : 'task';
  const activeConfig = getItemTypeConfig(activeTypeName);
  const activeDraft = mode === 'add' ? draftFor(activeTypeName) : editDraft;
  const titleId = mode === 'add' ? `${activeTypeName}-title` : `edit-${activeTypeName}-title`;
  const streakDays =
    editItem && editItem.type === 'habit' ? recentStreakDays(editItem) : [];

  // Notes starts one line tall and grows with what you type. `field-sizing-content`
  // alone would do it in Chrome; measuring keeps Safari from trapping a long note
  // inside a single scrolling row. 'auto' first so it also SHRINKS on delete.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = notesRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [activeDraft?.notes, activeTypeName, open]);

  // ── Header pieces ────────────────────────────────────────────────────────
  // Extracted so the docked panel can LEAD with the title — putting its heading
  // in the same top band the canvas and braindump headers occupy — while the
  // modal (and mobile drawer) keep the type-first layout unchanged.

  // The autosaving panel's explicit exit — flush pending writes, then close,
  // exactly what the footer's "Done" did. In the Clearing layout it rides the
  // top rail (and stands in for the close-X, which Clearing drops) so the
  // footer's bottom-right corner is free for the history line.
  const doneButton = (
    <Button
      // Autosave means there is nothing to "submit" — Done just flushes what's
      // queued and closes, exactly as the old close-X did. Never disabled: a
      // titleless draft (which autosave won't persist anyway) must still be
      // dismissable, since Clearing drops the X.
      onClick={() => {
        flushNow();
        onOpenChange(false);
      }}
      data-testid="item-dialog-submit"
      variant="outline"
      size="sm"
      className="h-7 px-3 text-xs"
    >
      Done
    </Button>
  );

  // ── The row's controls, in the header ────────────────────────────────────
  // The same capsule, icons, order and gates as a row's hover cluster
  // (task-row.tsx), so the pane and the row never disagree about what can be
  // done to an item. A row is drawn for a day; the pane is not, so the
  // per-day verbs answer for TODAY (skip, the count) and the put-it-off pair for
  // the day the item sits on. Only what a row offers is here: Pause, Pause
  // until and Reset streak stay in the ⋯ menu.
  const paneToday = toDateStr(new Date(), activationTz);
  const paneHabit = editItem?.type === 'habit' ? editItem : null;
  const paneRecurring = !!editItem && isRecurring(editItem);
  const occursToday =
    !!editItem &&
    paneRecurring &&
    shouldShowOnDate(editItem, paneToday, activationTz) &&
    (editItem.type === 'habit' || !editItem.startDate || editItem.startDate.slice(0, 10) <= paneToday);
  const doneToday = !!editItem && paneRecurring && isCompletedOnDate(editItem as Task, paneToday);
  const canSkipToday =
    !!editItem && isSkippable(editItem) && occursToday && !doneToday && !isSkippedOnDate(editItem, paneToday) && !pausedNow;
  // The day a one-off task sits on; an unscheduled one is already in the braindump.
  const paneDay =
    editItem && editItem.type !== 'habit' && editItem.isScheduled && editItem.startDate
      ? editItem.startDate.slice(0, 10)
      : null;
  const paneNextDay = paneDay ? nextDayTarget(paneDay, paneToday) : null;
  const canPaneNextDay = !!editItem && !!paneDay && canMoveToNextDay(editItem, 'task', paneDay);
  const canPaneBraindump =
    !!editItem && !!paneDay && canSendToBraindump(editItem, 'task', paneDay, typeSwitchMilestones);
  const paneTarget = paneHabit?.timesPerDay && paneHabit.timesPerDay > 1 ? paneHabit.timesPerDay : 0;
  const paneCountRaw = paneHabit ? ((paneHabit.dailyCounts ?? {})[paneToday] ?? 0) : 0;
  const paneCount = paneHabit && paneHabit.completedDates.includes(paneToday) ? paneCountRaw || paneTarget || 1 : paneCountRaw;
  const stepCount = (next: number) => {
    if (!paneHabit) return;
    if (next >= paneTarget) toggleHabitStatus(paneHabit.id, 'done', paneTarget, new Date());
    else toggleHabitStatus(paneHabit.id, 'pending', Math.max(0, next), new Date());
  };

  const rowControls =
    mode === 'edit' && editItem ? (
      <RowControlGroup data-testid="item-dialog-row-controls" className="mr-1">
        {paneTarget > 0 && occursToday && (
          <>
            <RowControl
              icon={Minus}
              label="Decrease count"
              testId="item-dialog-stepper-dec"
              disabled={paneCount <= 0}
              onClick={() => stepCount(paneCount - 1)}
            />
            <RowControl
              icon={Plus}
              label="Increase count"
              testId="item-dialog-stepper-inc"
              disabled={paneCount >= paneTarget}
              onClick={() => stepCount(paneCount + 1)}
            />
            <RowControlDivider />
          </>
        )}
        {canPaneNextDay && paneNextDay && (
          <RowControl
            icon={Redo2}
            label={nextDayLabel(paneNextDay, paneToday)}
            detail={formatTargetDay(paneNextDay)}
            testId="item-dialog-tomorrow"
            onClick={() => {
              flushNow();
              moveTaskToDate(editItem.id, paneNextDay);
              // The modal commits its whole draft on Save and never re-reads
              // the item underneath it, so its date follows the move here —
              // or Save would put the task straight back.
              if (!autosaves) {
                const [y, m, d] = paneNextDay.split('-').map(Number);
                setEditDraft((dr) => dr && { ...dr, startDate: new Date(y, m - 1, d) });
              }
            }}
          />
        )}
        {canPaneBraindump && (
          <RowControl
            icon={ArrowLeftToLine}
            label="Move to Braindump"
            testId="item-dialog-unschedule"
            onClick={() => {
              flushNow();
              unscheduleTask(editItem.id);
              // Same as the carry above: Save must not reschedule it.
              if (!autosaves) {
                setEditDraft((dr) => dr && { ...dr, startDate: undefined, timeBucket: 'none', startTime: '' });
              }
            }}
          />
        )}
        {canSkipToday && (
          <RowControl
            icon={SkipForward}
            label="Skip today"
            testId="item-dialog-skip"
            onClick={() => setItemSkipped(editItem.id, true, new Date())}
          />
        )}
        {/* Pause lives here too, beside the other "not now" verbs (a row has
            no room for it; the pane does). Never the destructive tone: setting
            something aside is a plan, not a failure. */}
        {canPause &&
          (pausedNow ? (
            <RowControl
              icon={PlayIcon}
              label="Resume"
              testId="item-dialog-resume"
              onClick={() => handleSetPaused(false)}
            />
          ) : (
            <>
              <RowControl
                icon={PauseIcon}
                label="Pause"
                testId="item-dialog-pause"
                onClick={() => handleSetPaused(true)}
              />
              <RowControl
                icon={CalendarClock}
                label="Pause until…"
                testId="item-dialog-pause-until"
                onClick={() => setShowPauseUntil(true)}
              />
            </>
          ))}
        <RowControl
          icon={Trash2}
          label={`Delete ${activeConfig.label.toLowerCase()}`}
          testId="item-dialog-delete"
          destructive
          onClick={() => setShowDeleteConfirm(true)}
        />
      </RowControlGroup>
    ) : null;
  const hasMoreActions = streaksOn && !!editConfig?.counters.streak;

  const headerActions = (
    <div className="ml-auto flex items-center gap-0.5">
      {rowControls}
      {mode === 'edit' && editItem && pathname !== `/item/${editItem.id}` && (
        <Button
          variant="ghost"
          size="icon"
          data-testid="item-dialog-open-page"
          className="text-muted-foreground size-7"
          onClick={() => {
            onOpenChange(false);
            router.push(`/item/${editItem.id}`);
          }}
        >
          <Maximize2 className="size-3.5" />
          <span className="sr-only">Open as page</span>
        </Button>
      )}

      {mode === 'edit' && hasMoreActions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              data-testid="item-dialog-more"
              className="text-muted-foreground size-7"
            >
              <MoreHorizontal className="size-4" />
              <span className="sr-only">More actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {streaksOn && editConfig?.counters.streak && (
              <DropdownMenuItem
                data-testid="item-dialog-reset-streak"
                onSelect={() => setShowResetConfirm(true)}
              >
                <RotateCcw className="size-3.5" />
                Reset streak
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* The modal gets Radix's own close button; the panel has to bring one —
          and it must flush before it goes. An autosaving panel doesn't: its
          top-rail "Done" already flushes + closes, so a second dismiss control
          doing the identical thing would just be noise beside it. */}
      {isPanel && !autosaves && (
        <Button
          variant="ghost"
          size="icon"
          data-testid="item-dialog-close"
          className="text-muted-foreground size-7"
          onClick={() => {
            flushNow();
            onOpenChange(false);
          }}
        >
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </Button>
      )}
    </div>
  );

  // Add's Zone 0 identity mark, and add's alone: choosing task vs habit is the
  // decision that reshapes the whole form, so it is worn as a filled chip with a
  // chevron rather than whispered. Edit gets `typeWhisper` — it shows the type
  // and never offers to change it, because converting an item is a data decision
  // (streaks, completion history), not a control.
  const typeControl = (
    <PropertyChip
      swatch={activeConfig.accent}
      swatchShape="square"
      label={activeConfig.label}
      value={activeConfig.label}
      testId="item-dialog-type-chip"
      alwaysChevron
      className="font-medium"
      contentClassName="w-60"
    >
      {(close) => (
        // Shared with ContainerDialog: the organizers ride this same menu, and
        // picking one hands the title and notes typed so far to that dialog
        // (the single slot swaps; this one closes). Never offered on a seeded
        // open — a bucket's or a day's "+" is asking for an item there.
        <NewTypeMenu
          active={activeTypeName}
          showOrganizers={!addPayload?.bucket && !addPayload?.date}
          onPickType={switchType}
          onPickOrganizer={(kind) => {
            // The text MOVES to the organizer, so it leaves the add drafts —
            // every type's, since switchType and a seeded open copy the title
            // across them. Drafts outlive a close (the stash), and a title left
            // behind would be waiting in the next plain "new", one Enter from a
            // duplicate item; a successful save clears them for the same reason.
            // Switching back re-seeds it through openAddDialog's title. The
            // stash is written directly too, not left to the effect, since the
            // slot swap may unmount this body before the effect runs.
            const title = activeDraft?.title || undefined;
            const notes = activeDraft?.notes || undefined;
            const next = Object.fromEntries(
              Object.entries(addDrafts).map(([t, d]) => [t, { ...d, title: '', notes: '' }])
            );
            setAddDrafts(next);
            writeDraftStash(next);
            openNewContainer(kind, title, notes);
          }}
          close={close}
        />
      )}
    </PropertyChip>
  );

  // Edit's Zone 0 identity mark: the same chip Add wears, and it changes the
  // type of the item you're looking at. Each type in its menu says what the
  // switch keeps or costs; a type the item can't become says why and is
  // disabled. Conversion rules live in lib/item-convert.ts.
  const typeSwitch = editItem ? (
    <PropertyChip
      swatch={activeConfig.accent}
      swatchShape="square"
      label={activeConfig.label}
      value={activeConfig.label}
      ariaLabel={`Type: ${activeConfig.label}. Change type`}
      testId="item-dialog-type-switch"
      alwaysChevron
      className="font-medium"
      contentClassName="w-72"
    >
      {(close) => (
        <>
          <ChipSectionLabel>Change type</ChipSectionLabel>
          {typeNames.map((t) => {
            const config = getItemTypeConfig(t);
            const current = t === activeTypeName;
            const blocked = current
              ? null
              : conversionBlock(editItem, t, { items, milestoneIds: typeSwitchMilestones });
            return (
              <button
                key={t}
                type="button"
                disabled={!!blocked}
                data-testid="item-dialog-type-switch-option"
                data-value={t}
                data-selected={current || undefined}
                onClick={() => {
                  close();
                  if (!current) requestTypeChange(t);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                  blocked ? 'cursor-not-allowed opacity-50' : 'hover-wash',
                  current && 'font-medium'
                )}
              >
                <span className="mt-[5px] flex">
                  <ColorSquare color={config.accent} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">{config.label}</span>
                  {!current && (
                    <span className="text-muted-foreground block text-xs leading-snug">
                      {blocked ?? conversionHint(editItem, t)}
                    </span>
                  )}
                </span>
                {current && <Check className="mt-0.5 size-3.5" />}
              </button>
            );
          })}
        </>
      )}
    </PropertyChip>
  ) : null;

  // The title — the only required field, so it carries the dialog.
  const titleInput = activeDraft ? (
    <Input
      id={titleId}
      data-testid="item-dialog-title-input"
      placeholder={activeConfig.form.titlePlaceholder}
      value={activeDraft.title}
      onChange={(e) => patchDraft(activeTypeName, { title: e.target.value })}
      // A multi-line paste into a single title is a list wearing the wrong
      // coat — hand it to the bulk-add dialog, carrying the type, project,
      // date and bucket already chosen here so the hop drops nothing. Add
      // mode only (an edit's title is one item's name), and never for
      // habits: their config doesn't fit one-per-line, so the paste stays a
      // native paste there.
      onPaste={
        mode === 'add' && activeTypeName !== 'habit'
          ? (e) => {
              const pasted = e.clipboardData.getData('text/plain');
              if (isBulkPaste(pasted)) {
                e.preventDefault();
                openBulkAdd({
                  text: pasted,
                  itemType: activeTypeName,
                  project: activeDraft.container !== 'none' ? activeDraft.container : undefined,
                  date: activeDraft.startDate
                    ? format(activeDraft.startDate, 'yyyy-MM-dd')
                    : undefined,
                  bucket:
                    activeDraft.startDate && activeDraft.timeBucket !== 'none'
                      ? activeDraft.timeBucket
                      : undefined,
                });
              }
            }
          : undefined
      }
      onBlur={autosaves ? flushNow : undefined}
      // The panel doesn't grab focus: it retargets on every row you click, and
      // stealing the caret each time would fight the canvas you're still in.
      autoFocus={presentation === 'modal' && (mode === 'edit' || activeTypeName === 'task')}
      // Serif at a heading size — prose against the sans + mono metadata below
      // it, and the one element that makes the surface read as a document
      // rather than a form. dark:bg-transparent is load-bearing: Input carries
      // dark:bg-input/30, which tailwind-merge keeps (different modifier) and
      // which outranks bg-transparent on specificity.
      className={SERIF_TITLE_CLASS}
    />
  ) : null;

  return (
    <>
      <SurfaceRoot panel={isPanel} open={open} onOpenChange={onOpenChange} isMobile={isMobile}>
        <SurfaceContent
          panel={isPanel}
          open={open}
          flat={isPanel && flat}
          panelLabel={`${activeConfig.label} details`}
          data-testid="item-dialog"
          data-mode={mode}
          data-item-type={activeTypeName}
          // A settle signal for tests and anything else that needs to know the
          // panel has stopped owing the database a write.
          data-autosave={autosaves ? (saving ? 'pending' : 'idle') : undefined}
          // Two presentations of the one surface (item-surface-growth Phase 1),
          // both plain className overrides on the primitive's centered base —
          // tailwind-merge drops the conflicting top/left/translate pair:
          //  · add  — top-[14vh]: a quick capture is a command, not a
          //    ceremony, and the omnibar's latitude keeps your eyes near the
          //    day you're adding to. max-h 80vh so 14vh + dialog never presses
          //    the viewport bottom.
          //  · edit — the right-docked panel, the item's home: full height,
          //    slides in from the canvas edge, and the frost is dropped
          //    (overlayClassName) so the app stays lit behind it. zoom-*-100
          //    neutralizes the base zoom-*-95 by CASCADE order, not merge —
          //    tw-animate utilities have no tailwind-merge class group.
          // Desktop only — the mobile drawer ignores both.
          className={
            mode === 'add'
              ? ADD_MODAL_CLASS
              : 'inset-y-3 right-3 left-auto w-[460px] max-w-[calc(100vw-1.5rem)] translate-x-0 translate-y-0 content-start rounded-[20px] overflow-y-auto overflow-x-hidden data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100 data-[state=open]:slide-in-from-right-6 data-[state=closed]:slide-out-to-right-6'
          }
          overlayClassName={
            mode === 'edit'
              ? 'bg-transparent backdrop-blur-none backdrop-saturate-100'
              : undefined
          }
          onKeyDown={(e) => {
            // defaultPrevented: Radix menu/select items preventDefault their own
            // Enter. Those events still bubble through the portal in React's
            // tree, so without this an Enter on "Delete" both opened the confirm
            // AND saved-and-closed the dialog underneath it — leaving the
            // confirm floating over nothing with an inert button, because
            // handleDeleteConfirm bails on the now-null `state`.
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.defaultPrevented &&
              !(e.target as HTMLElement).closest('[data-sub-input]') &&
              // A focused control owns its own Enter. preventDefault here would
              // cancel the browser's Enter→click for anything that only listens
              // for click — every chip trigger, "Open as page", Done — so
              // keyboard users got a save instead of the button they pressed.
              !(e.target as HTMLElement).closest('button')
            ) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
          {/* The visible heading is the title field itself; Radix still needs a
              real title and description in the a11y tree. The panel doesn't —
              it labels itself, and DialogTitle outside a Dialog would throw. */}
          <SurfaceA11yHeader panel={isPanel}>
            <ResponsiveModalTitle>
              {mode === 'add' ? 'Add New' : `Edit ${editConfig?.label ?? 'Item'}`}
            </ResponsiveModalTitle>
            <ResponsiveModalDescription>
              {mode === 'add'
                ? 'Add a new task or habit to your daily planner.'
                : editConfig?.form.editDescription}
            </ResponsiveModalDescription>
          </SurfaceA11yHeader>

          {activeDraft && (
            <div className="flex flex-col gap-4">
              {/* Header + title, the same two zones on every surface. The
                  docked panel's reason came first — leading with the title puts
                  its cap-top on the same line as the braindump and date headings
                  — and it turned out to be the better reading order everywhere:
                  the name of the thing, then what it carries. */}
              <div className="flex flex-col gap-3">
                {/* Zone 0 — identity on the left, actions and the exit on the
                    right. Add offers the type as a CONTROL (choosing task vs
                    habit is the decision that reshapes the whole form); edit
                    only whispers it, because converting an item is a data
                    decision, not a control. "Done" rides here where there is
                    nothing to submit, standing in for the close-X; every other
                    surface keeps its submit button in the footer. */}
                <div
                  className={cn(
                    'flex items-center gap-2',
                    // The desktop Dialog parks Radix's own close X absolutely at
                    // top-4/right-4, straight through this row's right end —
                    // where `headerActions` puts "Open as page" and the overflow
                    // menu. The type-first header this replaced carried the same
                    // pr-8 for the same reason. Not on the panel (it has no such
                    // X) and not on the drawer (vaul's handle is centered ABOVE
                    // the content, so it costs no width).
                    !isPanel && !isMobile && 'pr-8'
                  )}
                >
                  {mode === 'add' ? typeControl : typeSwitch}
                  {headerActions}
                  {autosaves && doneButton}
                </div>
                {/* Zone 1 — the title. Priority and the mode label are not here:
                    priority rides the chip field below with every other
                    property, and the mode label is gone (the type control, the
                    placeholder and the button all already say which mode this
                    is). */}
                {titleInput}
              </div>

              {/* Streak — the habit's history in the row's own dot vocabulary,
                  reading the open-time snapshot (stale after a reset until
                  reopen, as before). */}
              {/* Why an item you can see isn't anywhere else. Without this, a
                  paused item found through search opens, edits and schedules
                  normally while never appearing on the grid — every gesture a
                  silent no-op with nothing on screen to explain it. Muted, no
                  warning colour: it states a fact, it doesn't scold. */}
              {mode === 'edit' && editItem && activationReason && (
                <div
                  data-testid="item-dialog-paused-note"
                  data-reason={activationReason.kind}
                  className="flex items-center gap-2.5 rounded-md bg-surface-2 px-2.5 py-2"
                >
                  <Moon className="size-4 shrink-0 text-muted-foreground" />
                  {/* suppressionLabel, not a local ternary. A hand-rolled one
                      here had only a `routine` arm, so a program-caused
                      suppression fell through to the item-pause wording and
                      told the user "Paused until Sep 1" about an item they
                      never paused — while the overflow menu beside it offered
                      Pause, not Resume. Every new cause the resolver learns has
                      to reach this line without anyone remembering to come. */}
                  <span className="text-xs text-muted-foreground">
                    {suppressionLabel(activationReason, { long: true })}
                  </span>
                </div>
              )}

              {streaksOn && editConfig?.counters.streak && editItem && (
                <div className="bg-warning/10 flex items-center gap-2.5 rounded-md px-2.5 py-2">
                  <Flame className="text-warning size-4 shrink-0" />
                  <span className="text-warning-text text-xs font-semibold">
                    {(editItem as HabitItem).streak} day streak
                  </span>
                  {/* Same vocabulary as the row's DayDots: a done day is a
                      solid bead in the -text role (which flips bright in dark),
                      a missed day is a 1px RING — which is what --day-off's
                      per-theme alpha was tuned for. As a fill it made the
                      misses the loudest marks in the strip in light mode. */}
                  <span className="ml-auto flex items-center gap-[3px]">
                    {streakDays.map((done, i) => (
                      <span
                        key={i}
                        className={cn(
                          'box-border size-[5px] rounded-full',
                          done ? 'bg-warning-text' : 'border border-day-off'
                        )}
                      />
                    ))}
                  </span>
                </div>
              )}

              {renderChips(activeTypeName, activeDraft)}

              {/* Notes — the field that existed in the schema, the API and the
                  Beacon context from the start and had never had a surface. It
                  reads as part of the item rather than a labelled control: same
                  borderless treatment as the title, one line until you use it.
                  data-sub-input so Enter makes a newline; ⌘/Ctrl+Enter still
                  saves, since the footer promises Enter does. */}
              {activeConfig.fields.includes('notes') && (
                <Textarea
                  ref={notesRef}
                  rows={1}
                  data-sub-input
                  data-testid="item-dialog-notes"
                  placeholder="Notes"
                  value={activeDraft.notes}
                  onChange={(e) => patchDraft(activeTypeName, { notes: e.target.value })}
                  onBlur={autosaves ? flushNow : undefined}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  // min-h-0 unpins the primitive's min-h-16; the rest is the
                  // title Input's borderless recipe, dark:bg-transparent
                  // included (dark:bg-input/30 survives tailwind-merge).
                  // Paired with the serif title as "what you wrote", set
                  // against the sans + mono metadata around it.
                  className={SERIF_NOTES_CLASS}
                />
              )}

              {/* The sections the modal never had room for — Phase 1 of the
                  growth plan. Live data (subtasks/agent state read the store),
                  while the property draft above stays snapshot-based. */}
              {withDetailSections && mode === 'edit' && editItem && (
                <ItemDetailSections item={editItem} withThread withActivity={!autosaves} />
              )}

              {/* An autosaving surface has no moment of commitment, so its
                  footer is a status line: "Saves as you go" on the left, the
                  edit history folded into one expandable line on the right, and
                  Done lifted to the top rail. Everything that still commits on
                  submit — the capture modal, the mobile drawer — keeps the
                  Enter hint and the button. */}
              {autosaves ? (
                editItem && (
                  <ClearingFooter
                    key={editItem.id}
                    itemId={editItem.id}
                    saving={saving}
                    showHistory={withDetailSections}
                  />
                )
              ) : (
                // Reached only when `autosaves` is false, so there is no
                // saving-indicator arm here: this surface commits on submit and
                // the button is the whole promise.
                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <EnterHint verb={mode === 'add' ? 'add' : 'save'} />
                  <Button
                    onClick={handleSubmit}
                    data-testid="item-dialog-submit"
                    disabled={invalidCustomDays(activeDraft) || !activeDraft.title.trim()}
                    className="h-9 max-sm:w-full"
                  >
                    {mode === 'add' ? `Add ${activeConfig.label}` : 'Save Changes'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SurfaceContent>
      </SurfaceRoot>

      {streaksOn && editConfig?.counters.streak && (
        <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
          <AlertDialogContent data-testid="reset-streak-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>Reset Streak?</AlertDialogTitle>
              <AlertDialogDescription>
                This will reset your streak counter to 0 days. Your completion history stays — days you already checked off remain checked.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="reset-streak-confirm-accept"
                onClick={handleResetStreak}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Reset Streak
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {/* Mounted out here with the other satellites, so it renders nothing at
          all while closed — the docked panel deliberately carries no dialog
          role, and the e2e suite asserts on that. */}
      {canPause && (
        <AlertDialog open={showPauseUntil} onOpenChange={setShowPauseUntil}>
          <AlertDialogContent data-testid="pause-until-picker">
            <AlertDialogHeader>
              <AlertDialogTitle>Pause until…</AlertDialogTitle>
              <AlertDialogDescription>
                It comes back on the day you pick, on its own. Nothing is lost
                meanwhile — your streak and history stay exactly as they are.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex justify-center">
              <Calendar
                mode="single"
                // v9 prop (`fromDate` is v8 and silently inert here). The bound
                // is TOMORROW, not today: v9's `before` matcher disables only
                // strictly-earlier days, and "pause until today" is a no-op —
                // the upper bound is exclusive, so isPausedOn reads it back as
                // not paused. The row would take a pausedAt, the action log a
                // "Pause" entry, and nothing would hide.
                disabled={{ before: addDays(new Date(), 1) }}
                onSelect={(date) =>
                  // A picked day is a wall-calendar choice, not an instant —
                  // read its local fields straight back, the same way startDate
                  // is written above. Routing it through toDateStr(activationTz)
                  // re-reads a browser-local midnight in the STORED zone, which
                  // stores the PREVIOUS day whenever the browser is east of it
                  // (a travelling user, whose stored zone stays stale for the
                  // whole session — use-timezone-sync PATCHes the server only).
                  date && handleSetPaused(true, format(date, 'yyyy-MM-dd'))
                }
                initialFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <AlertDialog open={!!pendingType} onOpenChange={(o) => !o && setPendingType(null)}>
        {pendingType && pendingConfig && pendingSummary && (
            <AlertDialogContent data-testid="item-dialog-type-confirm">
              <AlertDialogHeader>
                <AlertDialogTitle>Change to {pendingConfig.label.toLowerCase()}?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="flex flex-col gap-2">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {pendingSummary.drops.map((d) => (
                        <li key={d}>{d} goes away.</li>
                      ))}
                      {pendingSummary.changes.map((c) => (
                        <li key={c}>{c}.</li>
                      ))}
                      <li>Its title, notes, time, repeat and past check-offs stay.</li>
                    </ul>
                    {pendingSummary.needsRepeat && (
                      <div className="flex flex-col gap-1.5 pt-1">
                        <span className="text-foreground text-sm">
                          {pendingConfig.labelPlural} repeat. How often should this one?
                        </span>
                        <div className="flex flex-wrap gap-1.5" role="radiogroup">
                          {CONVERT_REPEAT_CHOICES.map((r) => (
                            <button
                              key={r}
                              type="button"
                              role="radio"
                              aria-checked={convertRepeat === r}
                              data-testid="item-dialog-type-confirm-repeat"
                              data-value={r}
                              onClick={() => setConvertRepeat(r)}
                              className={cn(
                                'rounded-md border px-2.5 py-1 text-xs',
                                convertRepeat === r
                                  ? 'border-foreground text-foreground font-medium'
                                  : 'border-border text-muted-foreground hover-wash'
                              )}
                            >
                              {REPEAT_FREQUENCY_LABELS[r]}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  data-testid="item-dialog-type-confirm-accept"
                  onClick={handleConfirmTypeChange}
                >
                  Change to {pendingConfig.label.toLowerCase()}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
        )}
      </AlertDialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="item-dialog-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {editConfig?.label ?? 'Item'}?</AlertDialogTitle>
            <AlertDialogDescription>
              {editConfig?.form.deleteDescription(editItem?.title ?? '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="item-dialog-delete-confirm-accept"
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
