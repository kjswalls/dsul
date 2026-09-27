import type { Goal, GroupBy, HabitItem, Priority, Season, Routine, Task, TimeBucket } from './planner-types';
import { displayGoals, goalItemIds } from './goals';
import { TIME_BUCKET_RANGES } from './planner-types';
import { BUCKET_ORDER } from './day-items';
import { containerRefOf, fieldApplies, typeNameOf } from './filters';
import {
  NO_CONTAINER,
  classifyKindForItemType,
  containerName,
  foldRef,
  getContainerKindConfig,
  unsetContainerRef,
} from './container-registry';
import { getItemTypeConfig } from './item-registry';

/**
 * Grouping — one partition function every surface calls.
 *
 * It used to be `buildListGroups` inside components/views/day-list.tsx, which is
 * why Day × List honoured all five values while Day × Buckets tested
 * `=== 'project'` and nothing else, and the other four surfaces honoured none:
 * the code that could answer the question lived inside the one view that asked
 * it. Everything here is pure — rows in, sections out — so the surfaces differ
 * only in WHICH rows they hand it.
 *
 * Two rules the callers must keep:
 *
 * 1. **Group first, then sort within each group.** These groups come back
 *    unsorted, in the row order they were given. `sortRows` is applied per group
 *    by the caller, never to the flat list beforehand — the maps below are
 *    filled by walking the rows, so sorting first reorders the SECTIONS. The
 *    braindump shipped that way for one commit; see the plan's gotcha list.
 * 2. **Never partition a spine that carries positional drop targets.** Day ×
 *    Buckets hands over its untimed rows only, because `inferDropTime` resolves
 *    "the gap above row X" as ±30 min from X's own time (lib/dnd/CONTRACT.md).
 *    Every other surface either has no per-row droppable or is not time-ordered
 *    to begin with, and hands over everything.
 */

export interface GroupableRow {
  itemType: 'task' | 'habit';
  // `HabitItem`, not the legacy `Habit`: the two disagree about the container
  // field since 039, and `containerRefOf` reads the ITEM's (`project`).
  item: Task | HabitItem;
}

/**
 * A rendered section.
 *
 * `key` is separate from `label` because they answer different questions: the
 * label is what the reader sees, the key is what React reconciles on. For most
 * groupings they coincide; routine grouping is the exception that forced the
 * split (two routines may share a name). Container grouping was the second,
 * back when a project and a habit group could share a name; 039 left one
 * classify kind, so that pair can no longer occur — the split stays because the
 * routines still need it and because the key is also what carries the `none:`
 * and `foldRef` forms.
 */
export interface RowGroup<T> {
  key: string;
  label: string;
  rows: T[];
  /**
   * Set only on GATE sections (routine/season), and only on the REAL container
   * ones — never the `:none` loose bucket, which names no container to switch.
   * It carries the switch a group header renders: the id and kind are all the
   * header needs to resolve the container's on/off state and toggle it. Absent
   * on every classify/priority/bucket/none section, so those headers stay inert.
   *
   * A GOAL section never carries it either, and that is the aspire role in one
   * field: a goal switches nothing, so its heading has nothing to toggle. The
   * type says so — `kind` is the two gate kinds, not `ContainerKind`.
   */
  gate?: { kind: 'routine' | 'season'; id: string };
}

export interface GroupContext {
  /** Required by `'routine'`; also read by `'season'` (a season's members
   *  ride in through the routines it holds); ignored by every other value. */
  routines?: readonly Routine[];
  /** Required by `'season'`; ignored by every other value. */
  seasons?: readonly Season[];
  /** Required by `'goal'`; ignored by every other value. */
  goals?: readonly Goal[];
}

/** Internal: `unset` rides along so the "None" section can be forced last. */
interface Building<T> extends RowGroup<T> {
  unset: boolean;
}

/* ── container ──────────────────────────────────────────────────────────────*/

/**
 * The container section for one row, resolved through the registry.
 *
 * This is the half of the habits fix that grouping never got. `buildListGroups`
 * hoisted every habit into a single "Habits" section and grouped only the tasks,
 * so grouping by Project answered a question about tasks and then filed the rest
 * of the day under its own type name. A habit is not container-less — it answers
 * on the same axis, exactly as `passesContainerFilter` has since Phase 1, and
 * since migration 039 with the same field.
 *
 * The key is the PREFIXED ref. It used to be prefixed because a project and a
 * habit group could share a name and had to stay two sections (DEFAULT_PROJECTS
 * and DEFAULT_HABIT_GROUPS both seeded Work); 039 removed the collision at the
 * source. The prefix stays because these keys share a keyspace with the other
 * section keys — `priority:high`, `routine:none`, `goal:none`, `none:project` —
 * and `containerKindOf` is what tells a container ref apart from all of them.
 *
 * The key is FOLDED through `foldRef`, which is where the case policy lives.
 * It is not a preference: `makeAddDraft` writes a lowercase 'personal' against a
 * seeded capitalised 'Personal' whenever the container list has not loaded yet,
 * so both spellings live in real data. Grouping keyed on the raw ref would put
 * them in two sections that the menu's SINGLE "Personal" checkbox selects
 * together. The label is the first spelling seen, which is the store's own order.
 *
 * Unset is kind-TAGGED — `none:project` — rather than sharing the filter's bare
 * `NO_CONTAINER` sentinel. With one kind the two differ only in the suffix; the
 * tag stays because it is what keeps a heading key from ever reading as a real
 * ref, and because a second classify kind would need it back.
 */
function containerSection(row: GroupableRow): { key: string; label: string; unset: boolean } {
  const typeName = row.itemType === 'habit' ? 'habit' : typeNameOf(row.item);
  const ref = containerRefOf(row.item, typeName);
  // A type that carries no container axis at all. Nothing ships one — both
  // templates answer with a kind — but the registry types `containerKind` as
  // nullable, and a row of such a type must still land somewhere.
  if (ref === null) return { key: 'container:na', label: 'No container', unset: true };
  if (ref !== NO_CONTAINER) return { key: foldRef(ref), label: containerName(ref), unset: false };

  const kind = classifyKindForItemType(getItemTypeConfig(typeName).containerKind);
  // Unreachable while `ref` is non-null: both answers come from the same
  // registry lookup. Kept as the honest total, not as a guess about which side
  // an unclassified item belongs to.
  if (kind === null) return { key: 'container:na', label: 'No container', unset: true };
  return {
    key: unsetContainerRef(kind),
    label: getContainerKindConfig(kind).unsetLabel!,
    unset: true,
  };
}

/* ── priority ───────────────────────────────────────────────────────────────*/

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_ORDER: (Priority | null)[] = ['high', 'medium', 'low', null];

/**
 * A type that does not CARRY priority lands in "No priority" with everything
 * else that has none — it does not get a section named after its own type.
 *
 * The same call `sortRows` already makes (`priorityRank` ranks a non-carrying
 * type as unset), and the pass-through rule's companion: an item the axis does
 * not reach belongs in the explicit None value, not in a fourth answer. The old
 * "Habits" section here was type grouping smuggled into a priority question, and
 * it silently excluded custom types — they carry `priority`, so they were ranked
 * while habits were hoisted, for no stated reason.
 */
function priorityOf(row: GroupableRow): Priority | null {
  const typeName = row.itemType === 'habit' ? 'habit' : typeNameOf(row.item);
  if (!fieldApplies(typeName, 'priority')) return null;
  return (row.item as { priority?: Priority }).priority ?? null;
}

/* ── routine ────────────────────────────────────────────────────────────────*/

/**
 * ONE row, ONE group. An item can belong to several routines, and rendering it
 * under each would be the Outliner's known failure — two checkboxes for one
 * obligation, and a second copy that shift-range and ⌘A silently skip. It lands
 * in the first routine that claims it, in store order.
 *
 * Habits AND tasks, unlike every other grouping here: a routine holds both, and
 * pulling habits into their own section would put half a morning routine outside
 * the group named after it.
 *
 * Members are ordered by the routine's OWN sequence (`routine_items.sort_order`,
 * which is the array index) — the only place that order is visible outside the
 * manager, and why the two shipped together. `sortRows(rows, 'default')` returns
 * its input unchanged, so the caller's per-group sort preserves it until the user
 * picks an ordering.
 *
 * Grouped by routine ID, labelled by name. Names are not unique — the table
 * declares `name text not null` with no UNIQUE, rename ships from day one, and
 * nothing dedupes on create — so keying on the name silently MERGED two routines
 * into one heading holding both their work.
 */
function routineGroups<T extends GroupableRow>(rows: T[], routines: readonly Routine[]): RowGroup<T>[] {
  const claimed = new Map<string, { id: string; rank: number }>();
  routines.forEach((routine, i) => {
    routine.itemIds.forEach((id, rank) => {
      if (!claimed.has(id)) claimed.set(id, { id: routine.id, rank: i * 1e6 + rank });
    });
  });

  const groups = new Map<string, T[]>();
  for (const routine of routines) groups.set(routine.id, []);
  const loose: T[] = [];
  for (const row of rows) {
    const claim = claimed.get(row.item.id);
    if (claim) groups.get(claim.id)!.push(row);
    else loose.push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => claimed.get(a.item.id)!.rank - claimed.get(b.item.id)!.rank);
  }

  return [
    ...routines
      .filter((routine) => (groups.get(routine.id)?.length ?? 0) > 0)
      .map((routine) => ({
        key: routine.id,
        label: routine.name,
        rows: groups.get(routine.id)!,
        gate: { kind: 'routine' as const, id: routine.id },
      })),
    // Prefixed so a routine a user actually named "No routine" cannot collide
    // with it — group KEYS are React keys, and two sections under one key
    // reconcile against a single fiber the moment the group list changes shape.
    // No `gate`: the loose bucket names no container to switch.
    ...(loose.length ? [{ key: 'routine:none', label: 'No routine', rows: loose }] : []),
  ];
}

/* ── season ────────────────────────────────────────────────────────────────*/

/**
 * A season's members, in claim order: its OWN items first, then the items of
 * each routine it holds, in `routineIds` order. Deduped within the season —
 * an item that is both a direct member and reachable through a routine appears
 * once, at its direct position.
 *
 * A season gates work either directly (`season_items`) or through a routine it
 * contains (`season_routines` → `routine_items`), so the walk unions both.
 * Reading `itemIds` alone would miss every item a season only reaches via a
 * routine — the school-year season that contains a Chinese routine holds that
 * routine's habits.
 */
function seasonMemberIds(season: Season, routineById: ReadonlyMap<string, Routine>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const id of season.itemIds) push(id);
  for (const routineId of season.routineIds) {
    const routine = routineById.get(routineId);
    if (routine) for (const id of routine.itemIds) push(id);
  }
  return out;
}

/**
 * ONE row, ONE group — the routine rule, applied to seasons. An item can sit in
 * several seasons (directly, or via routines several seasons share), so it
 * lands in the FIRST season that claims it, in store order; a duplicate row is
 * the same two-checkboxes-for-one-obligation failure `routineGroups` guards.
 *
 * Keyed by season ID, labelled by name — seasons, like routines, carry
 * `name text not null` with no UNIQUE and rename ships from day one, so keying
 * on the name would merge two same-named seasons into one heading. Members order
 * by `seasonMemberIds` (own items, then routine members); `sortRows(rows,
 * 'default')` is identity and preserves it. There is no member REORDER on a
 * season header — `season_items` has no sort_order (see schedule-lanes.ts).
 */
function seasonGroups<T extends GroupableRow>(
  rows: T[],
  seasons: readonly Season[],
  routines: readonly Routine[],
): RowGroup<T>[] {
  const routineById = new Map(routines.map((routine) => [routine.id, routine]));
  const claimed = new Map<string, { id: string; rank: number }>();
  seasons.forEach((season, i) => {
    seasonMemberIds(season, routineById).forEach((id, rank) => {
      if (!claimed.has(id)) claimed.set(id, { id: season.id, rank: i * 1e6 + rank });
    });
  });

  const groups = new Map<string, T[]>();
  for (const season of seasons) groups.set(season.id, []);
  const loose: T[] = [];
  for (const row of rows) {
    const claim = claimed.get(row.item.id);
    if (claim) groups.get(claim.id)!.push(row);
    else loose.push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => claimed.get(a.item.id)!.rank - claimed.get(b.item.id)!.rank);
  }

  return [
    ...seasons
      .filter((season) => (groups.get(season.id)?.length ?? 0) > 0)
      .map((season) => ({
        key: season.id,
        label: season.name,
        rows: groups.get(season.id)!,
        gate: { kind: 'season' as const, id: season.id },
      })),
    // Prefixed for the same React-key reason as 'routine:none'; no `gate`.
    ...(loose.length ? [{ key: 'season:none', label: 'No season', rows: loose }] : []),
  ];
}

/* ── goal ───────────────────────────────────────────────────────────────────*/

/**
 * ONE row, ONE group — the routine rule, applied to the aspire role.
 *
 * A goal is many-to-many exactly as a routine is ("morning run" serves Health
 * AND Marathon — the plan's own example), so it is not a partition and cannot
 * be rendered as one without either duplicating rows or lying about counts.
 * `routineGroups` settled that trade first and this follows it verbatim: the
 * row lands in the FIRST goal that claims it, in store order. Two sections
 * holding one obligation is two checkboxes for one obligation, and the second
 * copy is a row shift-range and ⌘A silently skip.
 *
 * What is NOT borrowed from the gates: no `gate` field on the section. A gate
 * heading carries a pause switch; a goal heading carries nothing, because a
 * goal suppresses nothing and there is no state on it to flip. That difference
 * is the aspire role.
 *
 * ACTIVE goals only (`displayGoals`). A row whose only goal has been achieved
 * falls into the loose bucket — it is never dropped, which is the contract
 * `groupRows` states and the one an aspire container may never break.
 *
 * Members arrive in `goalItemIds` order — milestones first, in the goal's own
 * timeline order, then check-ins, then plain members — so a section leads with
 * the checkpoints. `sortRows(rows, 'default')` returns its input unchanged, so
 * the caller's per-group sort preserves it until the user picks an ordering.
 *
 * Keyed by goal ID, labelled by name: `goals.name` is `text not null` with no
 * UNIQUE and rename ships from day one, so keying on the name would merge two
 * same-named goals into one heading holding both their work.
 */
function goalGroups<T extends GroupableRow>(rows: T[], goals: readonly Goal[]): RowGroup<T>[] {
  const live = displayGoals(goals);
  const claimed = new Map<string, { id: string; rank: number }>();
  live.forEach((goal, i) => {
    goalItemIds(goal).forEach((id, rank) => {
      if (!claimed.has(id)) claimed.set(id, { id: goal.id, rank: i * 1e6 + rank });
    });
  });

  const groups = new Map<string, T[]>();
  for (const goal of live) groups.set(goal.id, []);
  const loose: T[] = [];
  for (const row of rows) {
    const claim = claimed.get(row.item.id);
    if (claim) groups.get(claim.id)!.push(row);
    else loose.push(row);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => claimed.get(a.item.id)!.rank - claimed.get(b.item.id)!.rank);
  }

  return [
    ...live
      .filter((goal) => (groups.get(goal.id)?.length ?? 0) > 0)
      .map((goal) => ({ key: goal.id, label: goal.name, rows: groups.get(goal.id)! })),
    // Prefixed for the same React-key reason as 'routine:none'. A goal id is a
    // uuid, so it cannot collide with this literal — and `containerKindOf`
    // reads neither as a ref, which is what keeps GroupSection from hunting a
    // project glyph for a goal heading.
    ...(loose.length ? [{ key: 'goal:none', label: 'No goal', rows: loose }] : []),
  ];
}

/* ── the entry point ────────────────────────────────────────────────────────*/

/**
 * Partition rows into sections. Never returns an empty section, and never
 * returns a row twice.
 *
 * `'none'` is ONE unlabelled section holding everything, not a per-surface
 * default: a surface whose no-grouping look is something richer (Day × List's
 * HABITS / TASKS / PROJECTS) owns that itself, because it is a presentation
 * choice for that view rather than an answer to "group by what".
 *
 * Section order is FIRST-ENCOUNTER for the container value and STORE ORDER for
 * the id-keyed ones (routine, season, goal); the closed values (priority,
 * bucket) use a fixed ladder. "None" sections sort last either way, matching
 * the sort side's rule that unset ranks last rather than floating to the top.
 */
export function groupRows<T extends GroupableRow>(
  rows: T[],
  groupBy: GroupBy,
  ctx: GroupContext = {}
): RowGroup<T>[] {
  if (rows.length === 0) return [];
  if (groupBy === 'none') return [{ key: '', label: '', rows }];
  if (groupBy === 'routine') return routineGroups(rows, ctx.routines ?? []);
  if (groupBy === 'season') return seasonGroups(rows, ctx.seasons ?? [], ctx.routines ?? []);
  if (groupBy === 'goal') return goalGroups(rows, ctx.goals ?? []);

  if (groupBy === 'priority') {
    const byPriority = new Map<Priority | null, T[]>();
    for (const row of rows) {
      const p = priorityOf(row);
      if (!byPriority.has(p)) byPriority.set(p, []);
      byPriority.get(p)!.push(row);
    }
    return PRIORITY_ORDER.filter((p) => byPriority.has(p)).map((p) => ({
      key: `priority:${p ?? 'none'}`,
      label: p ? PRIORITY_LABEL[p] : 'No priority',
      rows: byPriority.get(p)!,
    }));
  }

  if (groupBy === 'bucket') {
    const byBucket = new Map<TimeBucket | null, T[]>();
    for (const row of rows) {
      const b = (row.item.timeBucket as TimeBucket | undefined) ?? null;
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b)!.push(row);
    }
    return [
      ...BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
        key: `bucket:${b}`,
        label: TIME_BUCKET_RANGES[b].label,
        rows: byBucket.get(b)!,
      })),
      // Unreachable from the canvas — deriveDayItems drops anything without a
      // bucket before it ever builds a row — but the braindump's corpus is
      // exactly the rows that have none, and a grouping that silently ate them
      // would be a disappearing-items bug rather than an empty section.
      ...(byBucket.has(null)
        ? [{ key: 'bucket:none', label: 'No time bucket', rows: byBucket.get(null)! }]
        : []),
    ];
  }

  // 'project' — the CONTAINER axis. The value is still named for the project
  // half because that is what the menu row says and what the persisted payload
  // holds; what changed is that habits answer it with their group instead of
  // being hoisted out of the question.
  const built = new Map<string, Building<T>>();
  for (const row of rows) {
    const { key, label, unset } = containerSection(row);
    if (!built.has(key)) built.set(key, { key, label, rows: [], unset });
    built.get(key)!.rows.push(row);
  }
  const all = [...built.values()];
  return [...all.filter((g) => !g.unset), ...all.filter((g) => g.unset)].map(
    ({ key, label, rows: groupRowsOut }) => ({ key, label, rows: groupRowsOut })
  );
}
