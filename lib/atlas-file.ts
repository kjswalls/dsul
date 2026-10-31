import type { Goal, Item, Project, Routine, Season } from './planner-types';
import { canBulkCollect, canBulkSetProject } from './bulk-edit';
import { sameContainerName } from './container-registry';
import { goalItemIds } from './goals';
import { containerMemberIds as scheduleMemberIds } from './container-schedule';
import { placementOf } from './dnd/handle-drag-end';
import type { AtlasContainerRef } from './dnd/atlas-ids';
import { batchHistory, usePlannerStore } from './planner-store';
import { isPlannerPreviewing, selectPlannerSettled } from './planner-ready';
import { ATLAS_COPY } from './atlas-copy';

/**
 * What a drop onto an Atlas card writes (design 4.2): a braindump row, or a row
 * from another card, filed into the card's container.
 *
 * | From | Onto | Write |
 * |---|---|---|
 * | anywhere but a card | project | `setItemsProject(ids, name)` |
 * | anywhere but a card | routine, season | `setItemsCollected(ids, kind, id, true)` |
 * | anywhere but a card | goal | `setItemsGoal(ids, id, true)` (a plain member) |
 * | a card of the same kind | project | `setItemsProject` (one classify value, so it moves) |
 * | a card of the same kind | routine, season, goal | off the source, onto the target, one undo |
 * | a card of another kind | any | adds; the source keeps it |
 *
 * Which kinds a type may join is the registry's answer, asked through the bulk
 * verbs' own predicates (`canBulkSetProject`, `canBulkCollect`), never a branch
 * on task vs habit. A goal's milestone or check-in never moves to another goal
 * by drag: that is the goal's own decision, made on its page.
 *
 * A drop always means something or says why it didn't: {@link planFiling} is
 * pure and answers both the card's hint while the drag is over it and the
 * drop itself, so the two can't disagree.
 */

export interface FilingState {
  items: readonly Item[];
  projects: readonly Project[];
  routines: readonly Routine[];
  seasons: readonly Season[];
  goals: readonly Goal[];
}

export type FilingPlan =
  /** The container is gone (trashed elsewhere mid-drag). Nothing to say. */
  | { kind: 'none' }
  /** Every dragged item is already in it. Nothing writes, nothing is said. */
  | { kind: 'already' }
  /** Springs back with a reason. */
  | { kind: 'refused'; message: string }
  | {
      kind: 'file';
      mode: 'add' | 'move';
      /** What joins the target. */
      ids: string[];
      /** What leaves the source (a routine, season or goal moved from). */
      removeFromSource: string[];
      targetName: string;
      /** The undo strip's sentence. */
      label: string;
    };

type Container = { id: string; name: string };

function containerOf(state: FilingState, ref: AtlasContainerRef): Container | undefined {
  const list: readonly Container[] =
    ref.kind === 'project'
      ? state.projects
      : ref.kind === 'routine'
        ? state.routines
        : ref.kind === 'season'
          ? state.seasons
          : state.goals;
  return list.find((c) => c.id === ref.id);
}

/**
 * The item ids a container's CARD shows: the same answer the card model reads
 * (lib/container-schedule.ts), so "already here" agrees with what the user
 * sees. A project by its (case-folded) name; a routine by its list; a season
 * by its list AND its routines' lists (they ride along); a goal in any role.
 */
export function containerMemberIds(state: FilingState, ref: AtlasContainerRef): Set<string> {
  if (ref.kind === 'project') return projectMemberIds(state, ref.id);
  if (ref.kind === 'goal') {
    const goal = state.goals.find((g) => g.id === ref.id);
    return new Set(goal ? goalItemIds(goal) : []);
  }
  if (ref.kind === 'routine') {
    const routine = state.routines.find((r) => r.id === ref.id);
    return new Set(routine ? scheduleMemberIds({ kind: 'routine', routine }, state.items, state.routines) : []);
  }
  const season = state.seasons.find((s) => s.id === ref.id);
  return new Set(season ? scheduleMemberIds({ kind: 'season', season }, state.items, state.routines) : []);
}

function projectMemberIds(state: FilingState, id: string): Set<string> {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return new Set();
  const out = new Set<string>();
  for (const item of state.items) {
    const name = (item as { project?: string }).project;
    if (name && sameContainerName('project', name, project.name)) out.add(item.id);
  }
  return out;
}

/**
 * What a move can take OFF a source card: its DIRECT holdings. A season's
 * routine members are held through the routine (they come off it there), and
 * a goal's milestones and check-ins never move by drag, so only `memberIds`.
 */
function directMemberIds(state: FilingState, ref: AtlasContainerRef): Set<string> {
  if (ref.kind === 'project') return projectMemberIds(state, ref.id);
  if (ref.kind === 'goal') return new Set(state.goals.find((g) => g.id === ref.id)?.memberIds ?? []);
  const list = ref.kind === 'routine' ? state.routines : state.seasons;
  return new Set(list.find((c) => c.id === ref.id)?.itemIds ?? []);
}

/** May this item join a container of this kind? The registry's answer, through the bulk verbs. */
export function canJoin(item: Item, kind: AtlasContainerRef['kind']): boolean {
  return kind === 'project' ? canBulkSetProject(item) : canBulkCollect(item);
}

const isSubtask = (item: Item) => !!(item as { parentItemId?: string }).parentItemId;

export function planFiling(
  state: FilingState,
  ids: readonly string[],
  target: AtlasContainerRef,
  source?: AtlasContainerRef | null,
): FilingPlan {
  const container = containerOf(state, target);
  if (!container) return { kind: 'none' };
  const byId = new Map(state.items.map((i) => [i.id, i]));
  const live = [...new Set(ids)].map((id) => byId.get(id)).filter((i): i is Item => !!i);
  const members = containerMemberIds(state, target);
  const incoming = live.filter((i) => !members.has(i.id));
  if (incoming.length === 0) return live.length ? { kind: 'already' } : { kind: 'none' };

  let joining = incoming.filter((i) => canJoin(i, target.kind));
  if (joining.length === 0) {
    const message = incoming.every(isSubtask) ? ATLAS_COPY.subtaskStays : ATLAS_COPY.cantFileIn(container.name);
    return { kind: 'refused', message };
  }

  // Same kind, another card: a move. A project holds one classify value, so
  // the add alone moves it; the gate and aspire kinds are lists, so the item
  // also comes off the source's. Only what the source holds DIRECTLY can come
  // off; anything else (a season's routine member, a selected row from
  // elsewhere) is added, and the label says "Filed", never "Moved" for an item
  // that stays where it was.
  const sourceContainer =
    source && source.kind === target.kind && source.id !== target.id ? containerOf(state, source) : undefined;
  let removeFromSource: string[] = [];
  let leaving = 0;
  if (source && sourceContainer) {
    if (source.kind === 'goal') {
      const goal = state.goals.find((g) => g.id === source.id);
      const locked = new Set([...(goal?.milestoneIds ?? []), ...(goal?.checkinIds ?? [])]);
      joining = joining.filter((i) => !locked.has(i.id));
      if (joining.length === 0) return { kind: 'refused', message: ATLAS_COPY.milestoneMoves };
    }
    const held = directMemberIds(state, source);
    const off = joining.filter((i) => held.has(i.id)).map((i) => i.id);
    leaving = off.length;
    if (target.kind !== 'project') removeFromSource = off;
  }
  const mode = sourceContainer && leaving === joining.length ? 'move' : 'add';

  const n = joining.length;
  let label: string;
  if (mode === 'move') {
    label = n === 1 ? ATLAS_COPY.movedRow(joining[0].title, container.name) : ATLAS_COPY.movedRows(n, container.name);
  } else if (n > 1) {
    label = ATLAS_COPY.filedMany(n, container.name);
  } else {
    // Filing never schedules: an item in the braindump is still there after.
    label = placementOf(joining[0]).placed
      ? ATLAS_COPY.filed(container.name)
      : ATLAS_COPY.filedFromBraindump(container.name);
  }

  return {
    kind: 'file',
    mode,
    ids: joining.map((i) => i.id),
    removeFromSource,
    targetName: container.name,
    label,
  };
}

export interface FilingOutcome {
  wrote: boolean;
  /** A spring-back reason to show. */
  message?: string;
}

/**
 * File `ids` into `target`, through the planner-store verbs, as ONE undo entry.
 * Writes nothing while the planner is previewing or still loading (rule 10).
 */
export function fileIntoContainer(
  ids: readonly string[],
  target: AtlasContainerRef,
  source?: AtlasContainerRef | null,
): FilingOutcome {
  const store = usePlannerStore.getState();
  if (isPlannerPreviewing() || !selectPlannerSettled(store)) return { wrote: false };
  const plan = planFiling(store, ids, target, source);
  if (plan.kind === 'refused') return { wrote: false, message: plan.message };
  if (plan.kind !== 'file') return { wrote: false };

  batchHistory(plan.label, plan.ids.length, () => {
    const s = usePlannerStore.getState();
    if (source && plan.removeFromSource.length > 0) {
      if (source.kind === 'goal') {
        const goal = s.goals.find((g) => g.id === source.id);
        const leaving = new Set(plan.removeFromSource);
        if (goal) s.updateGoal(goal.id, { memberIds: goal.memberIds.filter((id) => !leaving.has(id)) });
      } else if (source.kind === 'routine' || source.kind === 'season') {
        s.setItemsCollected(plan.removeFromSource, source.kind, source.id, false);
      }
    }
    const now = usePlannerStore.getState();
    if (target.kind === 'project') now.setItemsProject(plan.ids, plan.targetName);
    else if (target.kind === 'goal') now.setItemsGoal(plan.ids, target.id, true);
    else now.setItemsCollected(plan.ids, target.kind, target.id, true);
  });
  return { wrote: true };
}
