import type { Goal, HabitItem, Item, Project, Routine, Season, Task } from './planner-types';
import type { AwayPeriod } from './away';
import {
  containerMemberIds,
  daysBetween,
  deriveContainerSchedule,
  todayInOrder,
  type OccurrenceState,
} from './container-schedule';
import {
  inactiveItemIdsOn,
  isOpenLoopOn,
  isSeasonActiveOn,
  routineStandingOn,
  seasonResumeDate,
  formatDay,
} from './active';
import { goalProgress, lastDoneOn, nextMilestone } from './goals';
import { isCancelled, isDoneOn, occurrenceOn } from './verb-gates';
import { isRecurring } from './recurrence';
import { accentColorForName, projectColorToken } from './accent-colors';
import { CONTAINER_KINDS } from './container-registry';
import { toDateOnly } from './overdue';

/**
 * Atlas's cards, derived (components/views/atlas/use-atlas-cards.ts is the
 * only caller in the app). Pure: no React, no store.
 *
 * Built on the iOS-ported modules (active, goals, container-schedule,
 * verb-gates, accent-colors, container-registry) and never edits them (design
 * D9). "Does this want doing" is asked of them, through one helper,
 * {@link memberStateOn}, never re-derived here (rule 17).
 */

export type AtlasKind = 'project' | 'routine' | 'season' | 'goal';

/** A tile's state: done today, still wanted today, or not on today at all. */
export type MemberState = 'lit' | 'open' | 'quiet';

/** At most this many tiles on a card; the rest are a "+n" chip. */
export const ATLAS_TILE_CAP = 30;

/** A known touch older than this many days reads as resting. */
export const ATLAS_RESTING_DAYS = 14;

/**
 * THE question every tile, count, "All done" and next step asks (rule 17).
 *
 * - `lit`: done today (`isDoneOn`: a one-off's done status, a recurring item's
 *   date, a counted habit's target reached);
 * - `open`: an open loop today (`isOpenLoopOn`), not held off
 *   (`inactiveItemIdsOn`), and on today at all (a recurring item whose rule
 *   skips today is `absent` by `occurrenceOn`);
 * - `quiet`: everything else, such as an off-day habit, a habit skipped today,
 *   or a paused or season-suppressed member.
 *
 * `null` for a cancelled item: neither done nor open, so it gets no tile (as in
 * `goalProgress`).
 */
export function memberStateOn(
  item: Item,
  todayStr: string,
  inactive: ReadonlySet<string>,
  tz: string,
): MemberState | null {
  if (!isRecurring(item) && isCancelled(item)) return null;
  if (isDoneOn(item, todayStr)) return 'lit';
  if (!isOpenLoopOn(item, todayStr)) return 'quiet';
  if (inactive.has(item.id)) return 'quiet';
  if (occurrenceOn(item, todayStr, todayStr, tz) === 'absent') return 'quiet';
  return 'open';
}

export interface AtlasMember {
  item: Item;
  state: MemberState;
  /**
   * What today means for this row's verbs (useVerbs' `todayState`): a
   * recurring item's recorded state or 'absent'; undefined for a one-off.
   * Derived once here, so no card or row derives its own.
   */
  todayState: OccurrenceState | 'absent' | undefined;
}

/** What the footer can honestly say about the last time anything happened. */
export type AtlasTouch =
  /** No known touch: neutral, never resting (rule 13). */
  | { kind: 'unknown' }
  | { kind: 'touched'; on: string; days: number }
  | { kind: 'resting'; since: string }
  | { kind: 'paused'; until?: string };

export interface AtlasMilestone {
  id: string;
  title: string;
  done: boolean;
  /** Target day, yyyy-MM-dd, when it has one. */
  day?: string;
  next: boolean;
}

export interface AtlasCard {
  /** `${kind}:${id}`: the card's identity everywhere (places, expanded, tests). */
  key: string;
  kind: AtlasKind;
  id: string;
  name: string;
  /** The kind's user-facing noun (CONTAINER_KINDS[kind].label). */
  kindLabel: string;
  color: string;
  /** Every non-cancelled, non-subtask member, in the container's own order. */
  members: AtlasMember[];
  /** Tile states, capped at ATLAS_TILE_CAP: open first, then lit, then quiet. */
  tiles: MemberState[];
  /** Tiles past the cap. */
  moreTiles: number;
  /** Lit members (goal: milestones achieved). */
  lit: number;
  /** Lit plus open (goal: milestones defined). Quiet ones are not counted. */
  total: number;
  /** The one row the card offers. */
  next: AtlasMember | null;
  /** Every open member, next first: the expanded card's rows. */
  openRows: AtlasMember[];
  /** Nothing open: the dashed edge and "All done. What's next?". */
  allDone: boolean;
  /**
   * Whether "Put next step on Today" may be offered for `next` (rule 4): never
   * a milestone (its start date is its target date), never a recurring item
   * (the verb moves the series start). The verb's own `eligible` is still
   * asked before it runs.
   */
  nextOffersToday: boolean;
  touch: AtlasTouch;
  /** Known old touch, or paused/off: the hollow square. */
  resting: boolean;
  usualTime?: string;
  /** Goal: its target day. */
  targetOn?: string;
  /** Goal: its milestone track (information only). */
  milestones?: AtlasMilestone[];
  /** Goal: how many non-milestone items feed it. */
  feeds?: number;
  /** Season: the routines it holds (seeding puts them beside it). */
  routineIds?: readonly string[];
}

export interface AtlasModelInput {
  items: readonly Item[];
  tasks: readonly Task[];
  habits: readonly HabitItem[];
  projects: readonly Project[];
  routines: readonly Routine[];
  seasons: readonly Season[];
  /** Already gated by the Goals extension (useGoalsForDisplay). */
  goals: readonly Goal[];
  away?: readonly AwayPeriod[];
  tz: string;
  todayStr: string;
  /** Routines and seasons loaded (migration 040+). */
  collectionsAvailable: boolean;
  /** Goals loaded. */
  goalsAvailable: boolean;
  /** milestoneItemIds(goals). */
  milestoneIds: ReadonlySet<string>;
}

const STATE_RANK: Record<MemberState, number> = { open: 0, lit: 1, quiet: 2 };

/** yyyy-MM-dd of a stamp, or undefined. */
function dayOf(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const day = toDateOnly(stamp);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
}

function startDayOf(item: Item): string | undefined {
  return 'startDate' in item && item.startDate ? toDateOnly(item.startDate) : undefined;
}

function orderOf(item: Item): number {
  return (item as { order?: number }).order ?? 0;
}

/** Project and season: dated first (startDate ascending), then `order`. */
function byDatedThenOrder(a: AtlasMember, b: AtlasMember): number {
  const da = startDayOf(a.item);
  const db = startDayOf(b.item);
  if (da && db && da !== db) return da < db ? -1 : 1;
  if (da && !db) return -1;
  if (db && !da) return 1;
  return orderOf(a.item) - orderOf(b.item);
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * The footer's touch. Store-only in PR1: max `lastDoneOn` over members, a
 * season's `updatedAt`, a goal's `achievedAt`. Unknown stays neutral.
 */
function touchOf(
  lastTouch: string | undefined,
  todayStr: string,
  paused: { until?: string } | null,
): AtlasTouch {
  if (paused) return { kind: 'paused', until: paused.until };
  if (!lastTouch) return { kind: 'unknown' };
  const days = Math.max(0, daysBetween(lastTouch, todayStr));
  if (days > ATLAS_RESTING_DAYS) return { kind: 'resting', since: lastTouch };
  return { kind: 'touched', on: lastTouch, days };
}

export function buildAtlasCards(input: AtlasModelInput): AtlasCard[] {
  const { items, todayStr, tz } = input;
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const routines = input.collectionsAvailable ? input.routines : [];
  const seasons = input.collectionsAvailable ? input.seasons : [];
  const goals = input.goalsAvailable ? input.goals : [];
  const inactive = inactiveItemIdsOn(items, todayStr, {
    userTimezone: tz,
    routines,
    seasons,
    away: input.away,
  });

  /** Resolve join ids through the live map (rule 11), skip subtasks and cancelled. */
  const membersOf = (ids: readonly string[]): AtlasMember[] => {
    const seen = new Set<string>();
    const out: AtlasMember[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const item = itemsById.get(id);
      if (!item) continue;
      if ((item as { parentItemId?: string }).parentItemId) continue;
      const state = memberStateOn(item, todayStr, inactive, tz);
      if (!state) continue;
      out.push({ item, state, todayState: occurrenceOn(item, todayStr, todayStr, tz) });
    }
    return out;
  };

  const strip = (members: AtlasMember[]) => {
    const ordered = [...members].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
    const states = ordered.map((m) => m.state);
    return {
      tiles: states.slice(0, ATLAS_TILE_CAP),
      moreTiles: Math.max(0, states.length - ATLAS_TILE_CAP),
      lit: states.filter((s) => s === 'lit').length,
      total: states.filter((s) => s !== 'quiet').length,
    };
  };

  const lastDone = (members: AtlasMember[]) =>
    members.reduce<string | undefined>((max, m) => latest(max, lastDoneOn(m.item)), undefined);

  const cards: AtlasCard[] = [];
  const base = (kind: AtlasKind, id: string, name: string, color: string) => ({
    key: `${kind}:${id}`,
    kind,
    id,
    name,
    kindLabel: CONTAINER_KINDS[kind].label,
    color,
  });

  const finish = (
    head: ReturnType<typeof base>,
    members: AtlasMember[],
    next: AtlasMember | null,
    openRows: AtlasMember[],
    touch: AtlasTouch,
    extra: Partial<AtlasCard> = {},
  ): AtlasCard => {
    const nextOffersToday =
      !!next && !input.milestoneIds.has(next.item.id) && !isRecurring(next.item);
    return {
      ...head,
      members,
      ...strip(members),
      next,
      openRows: next ? [next, ...openRows.filter((m) => m !== next)] : openRows,
      allDone: !next,
      nextOffersToday,
      touch,
      resting: touch.kind === 'resting' || touch.kind === 'paused',
      ...extra,
    };
  };

  /* Goals first: they head the left column of the seeded map. */
  for (const goal of goals) {
    const ids = containerMemberIds({ kind: 'goal', goal }, items, routines);
    const members = membersOf(ids);
    const feeders = members.filter((m) => !goal.milestoneIds.includes(m.item.id));
    const open = feeders.filter((m) => m.state === 'open').sort(byDatedThenOrder);
    const progress = goalProgress(goal, itemsById);
    const nextMs = nextMilestone(goal, itemsById);
    const milestones: AtlasMilestone[] = [];
    for (const id of goal.milestoneIds) {
      const item = itemsById.get(id);
      if (!item || (!isRecurring(item) && isCancelled(item))) continue;
      milestones.push({
        id,
        title: item.title,
        done: isDoneOn(item, todayStr),
        day: startDayOf(item),
        next: nextMs?.id === id,
      });
    }
    const head = base('goal', goal.id, goal.name, goal.color ?? accentColorForName(goal.name));
    const card = finish(
      head,
      members,
      open[0] ?? null,
      open,
      touchOf(latest(lastDone(members), dayOf(goal.achievedAt)), todayStr, null),
      {
        targetOn: goal.targetOn ? toDateOnly(goal.targetOn) : undefined,
        milestones,
        feeds: feeders.length,
      },
    );
    // A goal counts milestones, not tiles (goalProgress).
    card.lit = progress.achieved;
    card.total = progress.total;
    cards.push(card);
  }

  for (const project of input.projects) {
    const ids = containerMemberIds({ kind: 'project', project }, items, routines);
    const members = membersOf(ids);
    const open = members.filter((m) => m.state === 'open').sort(byDatedThenOrder);
    const head = base('project', project.id, project.name, projectColorToken(project.name, input.projects));
    cards.push(finish(head, members, open[0] ?? null, open, touchOf(lastDone(members), todayStr, null)));
  }

  if (input.collectionsAvailable) {
    const source = {
      items,
      tasks: input.tasks,
      habits: input.habits,
      routines,
      seasons,
      away: input.away,
      timezone: tz,
    };
    for (const routine of routines) {
      const members = membersOf(routine.itemIds);
      // One schedule per routine for [today, 1 day]: its run order decides next.
      const schedule = deriveContainerSchedule({
        memberIds: routine.itemIds,
        source,
        from: todayStr,
        days: 1,
        todayStr,
      });
      const run = todayInOrder(schedule, routine.itemIds, todayStr);
      const byId = new Map(members.map((m) => [m.item.id, m]));
      const nextMember = run.nextId ? byId.get(run.nextId) : undefined;
      const next = nextMember && nextMember.state === 'open' ? nextMember : null;
      const open = run.rows
        .map((r) => byId.get(r.itemId))
        .filter((m): m is AtlasMember => !!m && m.state === 'open');
      const standing = routineStandingOn(routine, seasons, todayStr, tz);
      const paused = standing.effectiveOn
        ? null
        : {
            until:
              (!standing.localOn ? routine.pausedUntil : undefined) ??
              (standing.soonestBlocker ? seasonResumeDate(standing.soonestBlocker, todayStr) : undefined),
          };
      const head = base('routine', routine.id, routine.name, routine.color ?? accentColorForName(routine.name));
      cards.push(
        finish(head, members, next, open, touchOf(lastDone(members), todayStr, paused), {
          usualTime: routine.usualTime,
        }),
      );
    }

    for (const season of seasons) {
      const ids = containerMemberIds({ kind: 'season', season }, items, routines);
      const members = membersOf(ids);
      const open = members.filter((m) => m.state === 'open').sort(byDatedThenOrder);
      const paused = isSeasonActiveOn(season, todayStr) ? null : { until: seasonResumeDate(season, todayStr) };
      const head = base('season', season.id, season.name, season.color ?? accentColorForName(season.name));
      cards.push(
        finish(
          head,
          members,
          open[0] ?? null,
          open,
          touchOf(latest(lastDone(members), dayOf(season.updatedAt)), todayStr, paused),
          { routineIds: season.routineIds },
        ),
      );
    }
  }

  return cards;
}

/** The footer line, from the touch (lib/atlas-copy.ts words it). */
export function touchDay(touch: AtlasTouch): string | undefined {
  if (touch.kind === 'resting') return formatDay(touch.since);
  if (touch.kind === 'paused' && touch.until) return formatDay(touch.until);
  return undefined;
}
