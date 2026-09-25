import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { CheckCircle2, Flame } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { batchHistory, usePlannerStore } from '../planner-store';
import { parseSearchQuery, searchItems } from '../search';
import { isCompletedOnDate, isRecurring, toDateStr } from '../recurrence';
import { isPausedOn } from '../active';
import { getItemTypeConfig, itemTypeName } from '../item-registry';
import { resolveCategoryIcon } from '../category-icons';
import { streaksEnabled } from '../extension-gates';
import { scoreText } from './score';
import type { Command, CommandEntityOption } from './types';
import type {
  CustomItem,
  HabitItem,
  Item,
  Task,
  TaskItem,
  TimeBucket,
} from '../planner-types';

/**
 * The selection model.
 *
 * Round 1 shipped only commands that need no target, because there was no way
 * to say WHICH item you meant (hover is not a selection — see
 * lib/hovered-item.ts). This module is that missing primitive: a command
 * declares which items it can act on, and everything else — the picker rows,
 * the resting list, the greyed-out state when nothing qualifies — is derived.
 *
 * Two decisions worth knowing:
 *
 *  • Eligibility is the single source of truth. The same predicate drives the
 *    picker's candidates AND the command's availableWhen, so "Complete" can
 *    never offer you an item it would no-op on, and can never sit enabled with
 *    an empty picker behind it.
 *
 *  • Everything resolves against the SELECTED date, not today. That is what
 *    the planner store's own actions do (resolveDateStr falls back to
 *    selectedDate), so completing a habit from the palette while looking at
 *    Tuesday completes it on Tuesday, exactly as clicking the row would.
 */

/** Desktop has a scrolling panel; the mobile sheet has ~320px of room. */
const PICKER_LIMIT = 8;
const PICKER_LIMIT_MOBILE = 5;

/* ── item predicates ───────────────────────────────────────────────────── */

/** The date the palette is operating on — the day on screen. */
export function activeDateStr(): string {
  const { selectedDate, userTimezone } = usePlannerStore.getState();
  return toDateStr(
    selectedDate,
    userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

export function isHabit(item: Item): item is HabitItem {
  return item.type === 'habit';
}

/** Task-shaped: a task or a custom type, which rides the task pipeline. */
export function isTaskLike(item: Item): item is TaskItem | CustomItem {
  return item.type !== 'habit';
}

export function isCancelled(item: Item): boolean {
  return item.type !== 'habit' && item.status === 'cancelled';
}

/**
 * "Done" means three different things depending on the item, and getting it
 * wrong makes Complete offer you rows it would silently un-complete:
 * a habit and a recurring task track completion per date, a one-shot item
 * carries a scalar status whose done value comes from its type config.
 */
export function isDoneOn(item: Item, dateStr: string): boolean {
  if (item.type === 'habit') return item.completedDates.includes(dateStr);
  if (isRecurring(item)) return isCompletedOnDate(item, dateStr);
  return item.status === getItemTypeConfig(itemTypeName(item)).doneStatus;
}

/**
 * Skipping is per-DATE for every type that supports it (`skippedDates`), so
 * this reads the same array on a habit, a recurring task and a recurring
 * custom type. Whether the item may be skipped at all is `isSkippable`.
 */
export function isSkippedOn(item: Item, dateStr: string): boolean {
  return (item.skippedDates ?? []).includes(dateStr);
}

/**
 * Is this item paused RIGHT NOW?
 *
 * Deliberately takes no dateStr, unlike its skip sibling above. Every other
 * item predicate here answers about the SELECTED day, which is right for
 * per-occurrence state — but a pause is a stretch of time, not an occurrence,
 * and the palette is a dateless surface (plan decision 3). Keyed on the
 * selected day instead, Pause and Resume would swap places as the user walked
 * the week across a resume boundary.
 */
export function isPausedNow(item: Item): boolean {
  const { userTimezone } = usePlannerStore.getState();
  const tz = userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isPausedOn(item, toDateStr(new Date(), tz), tz);
}

/* ── candidates ────────────────────────────────────────────────────────── */

/**
 * The store's `tasks` projection is task-LIKE (custom items ride it) and both
 * projections carry their runtime discriminator, so they are Items in all but
 * declared type — the same cast lib/search.ts makes internally.
 */
function asItems(rows: Task[] | HabitItem[]): Item[] {
  return rows as unknown as Item[];
}

function allItems(): Item[] {
  const { tasks, habits } = usePlannerStore.getState();
  return [...asItems(tasks), ...asItems(habits)];
}

/**
 * Candidates for a typed query, via the omnibar's own search — so the keyword
 * grammar comes along for free: "complete project:Work", "delete type:errand".
 * searchItems returns nothing for an empty query (by design, for the search
 * surface), which is why the empty case reads the projections directly.
 */
function queryCandidates(raw: string): Item[] {
  const { tasks, habits } = usePlannerStore.getState();
  if (!raw.trim()) return allItems();
  const found = searchItems(raw, tasks, habits);
  return [...asItems(found.tasks), ...asItems(found.habits)];
}

/**
 * Sort key for "how close is this item to the day I am looking at". Lower
 * first: the selected day, then the nearest dates either side, then the
 * undated backlog. Habits are date-blind, so they are always "now".
 */
function proximity(item: Item, dateStr: string): number {
  if (item.type === 'habit') return 0;
  const start = item.startDate;
  if (!start) return 2;
  const delta = Math.abs(differenceInCalendarDays(parseISO(start), parseISO(dateStr)));
  // Kept under the undated tier so a dated item never sorts below the backlog.
  return delta === 0 ? 0 : 1 + Math.min(delta, 999) / 1000;
}

/** The muted right-hand column: where the item sits, in the fewest characters. */
function defaultDetail(item: Item, dateStr: string): string | undefined {
  if (item.type === 'habit') return streaksEnabled() && item.streak > 0 ? `🔥 ${item.streak}` : undefined;
  if (!item.startDate) return item.isScheduled ? undefined : 'Braindump';
  if (item.startDate === dateStr) return undefined;
  const days = differenceInCalendarDays(parseISO(item.startDate), parseISO(dateStr));
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return format(parseISO(item.startDate), 'd MMM');
}

function toOption(item: Item, dateStr: string, detail: ItemCommandSpec['detail']): CommandEntityOption {
  return {
    value: item.id,
    label: item.title,
    typeName: itemTypeName(item),
    icon: itemIcon(item),
    container: itemContainer(item),
    detail: (detail ?? defaultDetail)(item, dateStr),
    done: isDoneOn(item, dateStr),
  };
}

/**
 * Where the item lives, with its glyph resolved. Exported so the omnibar's
 * search rows and the picker's rows stay one vocabulary rather than two that
 * drift — which, since 039 collapsed the two CLASSIFY kinds, is also all it
 * takes: every type answers with `project`.
 */
export function itemContainer(item: Item): { name: string; glyph: string } | undefined {
  const { getProjectEmoji } = usePlannerStore.getState();
  return item.project ? { name: item.project, glyph: getProjectEmoji(item.project) } : undefined;
}

/**
 * Row glyph. Custom types get the icon picked when the type was created, which
 * is the only thing distinguishing an "errand" row from a task row at a glance.
 */
export function itemIcon(item: Item): LucideIcon {
  const name = itemTypeName(item);
  if (name === 'habit') return Flame;
  if (name === 'task') return CheckCircle2;
  const def = usePlannerStore.getState().itemTypes.find((t) => t.name === name);
  return resolveCategoryIcon(def?.icon, def?.label ?? name);
}

/* ── eligibility memo ──────────────────────────────────────────────────── */

/**
 * availableWhen runs for every command on every keystroke, and each item
 * command's predicate is a full scan of the store. Memoised on the identity of
 * the store's items array (rebuilt on every mutation) plus the selected date,
 * so a palette-wide pass over N item commands costs one scan each per edit
 * rather than one per keypress.
 *
 * The key also carries WALL-CLOCK today. Every other predicate here (isDoneOn,
 * isSkippedOn) is a pure function of (items, dateStr), which is why that pair
 * was the whole key; isPausedNow is the first that reads `new Date()` itself,
 * because pausing is dateless (plan decision 3). Without today in the key, an
 * app left open overnight keeps answering with yesterday's verdict — offering
 * "Resume" for a pause that expired at midnight, then an empty picker.
 */
let eligibilityCache: {
  items: readonly Item[];
  dateStr: string;
  today: string;
  results: Map<string, boolean>;
} = {
  items: [],
  dateStr: '',
  today: '',
  results: new Map(),
};

function anyEligible(id: string, eligible: Eligible, dateStr: string): boolean {
  const { items, userTimezone } = usePlannerStore.getState();
  const today = toDateStr(new Date(), userTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (
    eligibilityCache.items !== items ||
    eligibilityCache.dateStr !== dateStr ||
    eligibilityCache.today !== today
  ) {
    eligibilityCache = { items, dateStr, today, results: new Map() };
  }
  const cached = eligibilityCache.results.get(id);
  if (cached !== undefined) return cached;
  const result = allItems().some((item) => eligible(item, dateStr));
  eligibilityCache.results.set(id, result);
  return result;
}

/* ── the command factory ───────────────────────────────────────────────── */

type Eligible = (item: Item, dateStr: string) => boolean;

export interface ItemCommandSpec {
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  keywords?: string;
  aliases?: string[];
  /** Defaults to "Which item?". */
  placeholder?: string;
  /** Shown when nothing matches — say what would qualify, not "no results". */
  emptyLabel: string;
  /** The one predicate: it filters the picker AND greys the command out. */
  eligible: Eligible;
  /** Overrides the muted right-hand column (date / streak by default). */
  detail?: (item: Item, dateStr: string) => string | undefined;
  /** Receives the item re-read from the store, never the painted snapshot. */
  run: (item: Item, dateStr: string) => void;
  /** False keeps the picker single-select. Defaults to true. */
  multi?: boolean;
  /**
   * A batch collects the per-item celebration and offers and fires them once
   * at the end, instead of a confetti burst and a toast per item.
   */
  quietBatch?: boolean;
  /** History label for a batch. Defaults to `${label} · ${n} items`. */
  batchLabel?: (n: number) => string;
  /**
   * Replaces the default loop for a batch — for a verb that cannot be looped,
   * like one that raises a single-slot confirm. Receives re-read, eligible
   * items (two or more; one goes through `run`).
   */
  runMany?: (items: Item[], dateStr: string) => void;
}

/**
 * Builds an item-targeted command from its eligibility rule. Every command in
 * the Items group goes through here so they cannot drift apart on the things
 * that are easy to get subtly wrong — which date they read, whether the picker
 * agrees with the enabled state, and re-resolving the item before mutating it.
 */
export function itemCommand(spec: ItemCommandSpec): Command {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    group: 'items',
    icon: spec.icon,
    keywords: spec.keywords,
    aliases: spec.aliases,
    availableWhen: () => anyEligible(spec.id, spec.eligible, activeDateStr()),
    argument: {
      kind: 'entity',
      placeholder: spec.placeholder ?? 'Which item?',
      emptyLabel: spec.emptyLabel,
      search: (query, ctx) => {
        const dateStr = activeDateStr();
        // Score against the TEXT of the query, not the raw string: the
        // keyword tokens have already done their filtering, and leaving
        // "project:Work" in would score every title against a phrase no title
        // contains, flattening the ranking to proximity alone.
        const q = parseSearchQuery(query).text.trim().toLowerCase();
        const limit = ctx.isMobile ? PICKER_LIMIT_MOBILE : PICKER_LIMIT;

        return queryCandidates(query)
          .filter((item) => spec.eligible(item, dateStr))
          .map((item) => ({
            item,
            // searchItems has already decided WHETHER a row matches (and
            // consumed any project:/priority: tokens); this only orders what
            // survived, so an unscored row still ranks by proximity.
            score: q ? Math.max(scoreText(q, item.title), 0) : 0,
          }))
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return proximity(a.item, dateStr) - proximity(b.item, dateStr);
          })
          .slice(0, limit)
          .map(({ item }) => toOption(item, dateStr, spec.detail));
      },
      resolve: (ids) => {
        const dateStr = activeDateStr();
        const byId = new Map(allItems().map((i) => [i.id, i]));
        return ids
          .map((id) => byId.get(id))
          .filter((i): i is Item => !!i && spec.eligible(i, dateStr))
          .map((i) => toOption(i, dateStr, spec.detail));
      },
      runMany:
        spec.multi === false
          ? undefined
          : (_ctx, ids) => {
              // The date is read ONCE, so a batch cannot straddle a day change
              // halfway through; each target is re-read and re-checked, as run() does.
              const dateStr = activeDateStr();
              const byId = new Map(allItems().map((i) => [i.id, i]));
              const targets = [...new Set(ids)]
                .map((id) => byId.get(id))
                .filter((i): i is Item => !!i && spec.eligible(i, dateStr));
              if (targets.length === 0) return;
              // One target is a single pick: same label, same effects, same entry.
              if (targets.length === 1) return spec.run(targets[0], dateStr);
              if (spec.runMany) return spec.runMany(targets, dateStr);
              const label =
                spec.batchLabel?.(targets.length) ?? `${spec.label} · ${targets.length} items`;
              batchHistory(
                label,
                targets.length,
                () => {
                  for (const target of targets) {
                    // Re-read per item: an earlier verb in the loop may have
                    // cascaded onto this one (a parent's delete, a completion).
                    const fresh = allItems().find((i) => i.id === target.id);
                    if (fresh && spec.eligible(fresh, dateStr)) spec.run(fresh, dateStr);
                  }
                },
                { quiet: !!spec.quietBatch },
              );
            },
    },
    run: (_ctx, id) => {
      if (!id) return;
      // Re-read: the row was painted from a snapshot, and between picking it
      // and pressing Enter the item may have been edited, completed elsewhere,
      // or deleted on another device.
      const dateStr = activeDateStr();
      const item = allItems().find((i) => i.id === id);
      if (!item || !spec.eligible(item, dateStr)) return;
      spec.run(item, dateStr);
    },
  };
}

/* ── shared run helpers ────────────────────────────────────────────────── */

/** Tomorrow relative to the item's own date, falling back to the day on screen. */
export function nextDayStr(item: Item, dateStr: string): string {
  const base = item.type !== 'habit' && item.startDate ? item.startDate : dateStr;
  return format(addDays(parseISO(base), 1), 'yyyy-MM-dd');
}

/** Buckets exist on both shapes but are assigned through different actions. */
export function assignBucket(item: Item, bucket: TimeBucket): void {
  const planner = usePlannerStore.getState();
  if (item.type === 'habit') planner.assignHabitToBucket(item.id, bucket);
  else planner.assignTaskToBucket(item.id, bucket);
}
